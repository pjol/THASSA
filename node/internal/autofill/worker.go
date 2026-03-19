package autofill

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"time"

	ethereum "github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/pjol/THASSA/node/internal/config"
	"github.com/pjol/THASSA/node/internal/format"
	"github.com/pjol/THASSA/node/internal/fulfillment"
	"github.com/pjol/THASSA/node/internal/shape"
	"github.com/pjol/THASSA/node/internal/signing"
)

const (
	hubABIFile           = "ThassaHub.abi.json"
	oracleABIFile        = "ThassaOracle.abi.json"
	proofSchemeSignature = 1
)

type OpenAIClient interface {
	GenerateStructuredOutput(
		ctx context.Context,
		model string,
		query string,
		inputData map[string]any,
		schema map[string]any,
	) (map[string]any, string, error)
}

type Worker struct {
	cfg       config.Config
	openai    OpenAIClient
	formatter format.CallbackFormatter
	signer    *signing.Signer

	ethClient *ethclient.Client
	chainID   *big.Int

	hubAddress  common.Address
	hubABI      abi.ABI
	oracleABI   abi.ABI
	hubContract *bind.BoundContract

	bidPlacedTopic common.Hash
	nextBlock      uint64

	lastShapedOutputByClient map[common.Address]map[string]any
}

type hubUpdateEnvelope struct {
	Client           common.Address
	CallbackData     []byte
	QueryHash        [32]byte
	ShapeHash        [32]byte
	ModelHash        [32]byte
	ClientVersion    uint64
	RequestTimestamp uint64
	Expiry           uint64
	Nonce            *big.Int
	Fulfiller        common.Address
}

type hubProofEnvelope struct {
	Scheme       uint8
	PublicValues []byte
	Proof        []byte
}

type oracleSpec struct {
	Query         string
	ExpectedShape string
	Model         string
	ClientVersion uint64
}

func New(
	cfg config.Config,
	openaiClient OpenAIClient,
	formatter format.CallbackFormatter,
	signer *signing.Signer,
) (*Worker, error) {
	if strings.TrimSpace(cfg.RPCURL) == "" {
		return nil, fmt.Errorf("THASSA_RPC_URL is required for auto-fulfill worker")
	}
	if strings.TrimSpace(cfg.DefaultHubAddress) == "" || !common.IsHexAddress(cfg.DefaultHubAddress) {
		return nil, fmt.Errorf("DEFAULT_THASSA_HUB must be set to a valid address for auto-fulfill worker")
	}

	hubABI, err := loadABI(filepath.Join(cfg.ABIDir, hubABIFile))
	if err != nil {
		return nil, fmt.Errorf("load hub ABI: %w", err)
	}
	oracleABI, err := loadABI(filepath.Join(cfg.ABIDir, oracleABIFile))
	if err != nil {
		return nil, fmt.Errorf("load oracle ABI: %w", err)
	}

	client, err := ethclient.Dial(cfg.RPCURL)
	if err != nil {
		return nil, fmt.Errorf("connect rpc: %w", err)
	}

	chainID, err := client.ChainID(context.Background())
	if err != nil {
		return nil, fmt.Errorf("fetch chain id: %w", err)
	}

	hubAddress := common.HexToAddress(cfg.DefaultHubAddress)
	hubContract := bind.NewBoundContract(hubAddress, hubABI, client, client, client)
	bidPlacedEvent, ok := hubABI.Events["BidPlaced"]
	if !ok {
		return nil, fmt.Errorf("hub ABI missing BidPlaced event")
	}

	return &Worker{
		cfg:                      cfg,
		openai:                   openaiClient,
		formatter:                formatter,
		signer:                   signer,
		ethClient:                client,
		chainID:                  chainID,
		hubAddress:               hubAddress,
		hubABI:                   hubABI,
		oracleABI:                oracleABI,
		hubContract:              hubContract,
		bidPlacedTopic:           bidPlacedEvent.ID,
		lastShapedOutputByClient: make(map[common.Address]map[string]any),
	}, nil
}

func (w *Worker) Start(ctx context.Context) {
	if ctx == nil {
		ctx = context.Background()
	}

	w.logStep(nil, "START", "worker started: hub=%s chainId=%s pollEvery=%s signer=%s",
		w.hubAddress.Hex(),
		w.chainID.String(),
		w.cfg.BidScanInterval,
		w.signer.Address().Hex(),
	)

	if err := w.scanAndFulfill(ctx); err != nil {
		log.Printf("auto-fulfill initial scan error: %v", err)
	}

	ticker := time.NewTicker(w.cfg.BidScanInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			w.logStep(nil, "STOP", "worker stopped: %v", ctx.Err())
			return
		case <-ticker.C:
			if err := w.scanAndFulfill(ctx); err != nil {
				w.logStep(nil, "SCAN_ERR", "%v", err)
			}
		}
	}
}

func (w *Worker) scanAndFulfill(ctx context.Context) error {
	latestBlock, err := w.ethClient.BlockNumber(ctx)
	if err != nil {
		return fmt.Errorf("get latest block: %w", err)
	}

	if w.nextBlock == 0 {
		w.nextBlock = latestBlock
		w.logStep(nil, "BASELINE", "initial block baseline set to %d", w.nextBlock)
		return nil
	}
	if latestBlock < w.nextBlock {
		return nil
	}

	fromBlock := w.nextBlock
	toBlock := latestBlock

	query := ethereum.FilterQuery{
		FromBlock: new(big.Int).SetUint64(fromBlock),
		ToBlock:   new(big.Int).SetUint64(toBlock),
		Addresses: []common.Address{w.hubAddress},
		Topics:    [][]common.Hash{{w.bidPlacedTopic}},
	}

	logs, err := w.ethClient.FilterLogs(ctx, query)
	if err != nil {
		return fmt.Errorf("filter BidPlaced logs [%d,%d]: %w", fromBlock, toBlock, err)
	}

	w.nextBlock = toBlock + 1

	w.logStep(nil, "SCAN", "blocks [%d,%d], bidPlacedEvents=%d", fromBlock, toBlock, len(logs))

	if len(logs) == 0 {
		return nil
	}

	for _, eventLog := range logs {
		bidID, clientAddress, err := decodeBidPlaced(eventLog)
		if err != nil {
			w.logStep(nil, "EVENT_SKIP", "malformed BidPlaced tx=%s block=%d err=%v", eventLog.TxHash.Hex(), eventLog.BlockNumber, err)
			continue
		}
		w.logStep(
			bidID,
			"EVENT",
			"BidPlaced detected tx=%s block=%d client=%s",
			eventLog.TxHash.Hex(),
			eventLog.BlockNumber,
			clientAddress.Hex(),
		)

		if err := w.tryFulfillBid(ctx, bidID, clientAddress); err != nil {
			w.logStep(bidID, "FAILED", "%v", err)
			continue
		}
	}

	return nil
}

func (w *Worker) tryFulfillBid(ctx context.Context, bidID *big.Int, clientAddress common.Address) error {
	if bidID == nil || bidID.Sign() <= 0 {
		return fmt.Errorf("invalid bid id")
	}

	w.logStep(bidID, "SPEC", "loading oracle spec from client=%s", clientAddress.Hex())
	spec, err := w.loadOracleSpec(ctx, clientAddress)
	if err != nil {
		return fmt.Errorf("load oracle spec: %w", err)
	}
	w.logStep(
		bidID,
		"SPEC_OK",
		"model=%s clientVersion=%d queryHash=%s shapeHash=%s",
		spec.Model,
		spec.ClientVersion,
		crypto.Keccak256Hash([]byte(spec.Query)).Hex(),
		crypto.Keccak256Hash([]byte(spec.ExpectedShape)).Hex(),
	)

	w.logStep(bidID, "SHAPE", "parsing expectedShape=%s", spec.ExpectedShape)
	outputShape, err := shape.ParseExpectedShapeDSL(spec.ExpectedShape)
	if err != nil {
		return fmt.Errorf("parse expected shape %q: %w", spec.ExpectedShape, err)
	}
	if shape.HasField(outputShape, shape.FulfillmentFieldName) {
		return fmt.Errorf("expected shape must not include reserved field %q; the node adds it automatically", shape.FulfillmentFieldName)
	}
	w.logStep(bidID, "SHAPE_OK", "parsed fields=%s", summarizeShape(outputShape))

	llmShape := shape.WithFulfillmentField(outputShape)

	schema, err := shape.BuildJSONSchema(llmShape)
	if err != nil {
		return fmt.Errorf("build schema: %w", err)
	}
	schemaJSON, _ := json.Marshal(schema)
	w.logStep(bidID, "SCHEMA", "structured-output schema=%s", string(schemaJSON))

	openAIModel := deriveOpenAIModel(spec.Model)
	if openAIModel == "" {
		return fmt.Errorf("could not derive openAI model from %q", spec.Model)
	}
	w.logStep(bidID, "MODEL", "resolved openaiModel=%s from onchain model=%s", openAIModel, spec.Model)

	inputData := w.buildAutoFulfillInputData(bidID, clientAddress, spec)
	inputDataJSON, _ := json.Marshal(inputData)
	w.logStep(bidID, "INPUT", "structured-output inputData=%s", string(inputDataJSON))

	llmCtx, cancelLLM := context.WithTimeout(ctx, w.cfg.AutoFulfillLLMTimeout)
	defer cancelLLM()

	w.logStep(bidID, "LLM", "requesting structured output timeout=%s until _fulfilled=true", w.cfg.AutoFulfillLLMTimeout)
	result, err := fulfillment.GenerateUntilFulfilled(
		llmCtx,
		w.openai,
		openAIModel,
		spec.Query,
		inputData,
		schema,
		llmShape,
		func(format string, args ...any) {
			w.logStep(bidID, "LLM_ATTEMPT", format, args...)
		},
	)
	if err != nil {
		return fmt.Errorf("generate structured output: %w", err)
	}

	shapedOutput := result.ShapedOutput
	rawModelJSON := result.RawModelJSON
	llmFulfilled := result.Fulfilled

	w.logStep(bidID, "LLM_OK", "rawJson=%s", rawModelJSON)
	w.logStep(bidID, "LLM_FIELDS", "currentOutput=%s", formatOutputForLog(llmShape, shapedOutput))
	w.logStep(bidID, "LLM_STATUS", "_fulfilled=%t attempts=%d", llmFulfilled, result.Attempts)

	prevShaped := w.lastShapedOutputByClient[clientAddress]
	if prevShaped != nil {
		w.logStep(bidID, "LLM_PREV", "previousOutput=%s", formatOutputForLog(llmShape, prevShaped))
		w.logStep(bidID, "LLM_DIFF", "%s", summarizeFieldDelta(llmShape, prevShaped, shapedOutput))
	}

	w.lastShapedOutputByClient[clientAddress] = cloneAnyMap(shapedOutput)

	if !llmFulfilled {
		return fmt.Errorf("structured output marked _fulfilled=false; refusing to submit defaulted result")
	}

	shapedOutputJSON, _ := json.Marshal(shapedOutput)
	w.logStep(bidID, "SHAPE_MATCH", "output matches expected fields=%s", string(shapedOutputJSON))

	w.logStep(bidID, "ABI", "encoding callbackData from expectedShape field order")
	callbackData, err := w.formatter.EncodeCallbackData(outputShape, shapedOutput)
	if err != nil {
		return fmt.Errorf("encode callback data: %w", err)
	}
	w.logStep(
		bidID,
		"ABI_OK",
		"callbackDataBytes=%d callbackDataHash=%s callbackDataPreview=%s",
		len(callbackData),
		crypto.Keccak256Hash(callbackData).Hex(),
		previewBytesHex(callbackData, 48),
	)

	queryHash := crypto.Keccak256Hash([]byte(spec.Query))
	shapeHash := crypto.Keccak256Hash([]byte(spec.ExpectedShape))
	modelHash := crypto.Keccak256Hash([]byte(spec.Model))

	requestTimestamp := uint64(time.Now().Unix())
	expiry := requestTimestamp + w.cfg.DefaultTTLSeconds
	nonce := uint64(time.Now().UnixNano())
	w.logStep(
		bidID,
		"HASHES",
		"queryHash=%s shapeHash=%s modelHash=%s requestTimestamp=%d expiry=%d nonce=%d",
		queryHash.Hex(),
		shapeHash.Hex(),
		modelHash.Hex(),
		requestTimestamp,
		expiry,
		nonce,
	)

	signResult, err := w.signer.SignUpdate(signing.SignRequest{
		HubAddress: w.hubAddress,
		ChainID:    w.chainID,
		BidID:      bidID,
		AutoFlow:   true,
		Payload: signing.UpdatePayload{
			Client:           clientAddress,
			CallbackData:     callbackData,
			QueryHash:        queryHash,
			ShapeHash:        shapeHash,
			ModelHash:        modelHash,
			ClientVersion:    spec.ClientVersion,
			RequestTimestamp: requestTimestamp,
			Expiry:           expiry,
			Nonce:            new(big.Int).SetUint64(nonce),
			Fulfiller:        w.signer.Address(),
		},
	})
	if err != nil {
		return fmt.Errorf("sign update: %w", err)
	}
	w.logStep(bidID, "SIGN", "localDigest=%s signer=%s", signResult.Digest.Hex(), w.signer.Address().Hex())

	update := hubUpdateEnvelope{
		Client:           clientAddress,
		CallbackData:     callbackData,
		QueryHash:        queryHash,
		ShapeHash:        shapeHash,
		ModelHash:        modelHash,
		ClientVersion:    spec.ClientVersion,
		RequestTimestamp: requestTimestamp,
		Expiry:           expiry,
		Nonce:            new(big.Int).SetUint64(nonce),
		Fulfiller:        w.signer.Address(),
	}

	publicValues, err := format.EncodeFulfillmentPublicValues(llmFulfilled)
	if err != nil {
		return fmt.Errorf("encode proof public values: %w", err)
	}
	proof := hubProofEnvelope{
		Scheme:       proofSchemeSignature,
		PublicValues: publicValues,
		Proof:        signResult.Signature,
	}

	hubDigest, err := w.computeHubDigest(ctx, bidID, update)
	if err != nil {
		return fmt.Errorf("hub digest check failed: %w", err)
	}
	if hubDigest != signResult.Digest {
		return fmt.Errorf("digest mismatch local=%s hub=%s", signResult.Digest.Hex(), hubDigest.Hex())
	}
	w.logStep(bidID, "DIGEST_OK", "hub digest matches local digest=%s", hubDigest.Hex())

	isProofValid, verifierModule, err := w.verifyWithVerifierModule(ctx, hubDigest, bidID, update, proof)
	if err != nil {
		return fmt.Errorf("verifier module preflight failed: %w", err)
	}
	if !isProofValid {
		return fmt.Errorf("verifier module %s rejected signature preflight", verifierModule.Hex())
	}
	w.logStep(bidID, "PROOF_OK", "verifier=%s preflight=true", verifierModule.Hex())

	w.logStep(bidID, "ALLOWANCE", "checking/ensuring hub lockup allowance")
	if err := w.ensurePaymentTokenApproval(ctx); err != nil {
		return fmt.Errorf("ensure payment-token approval: %w", err)
	}

	w.logStep(bidID, "TX", "submitting submitAutoUpdate transaction")
	tx, err := w.submitAutoUpdateTx(ctx, bidID, update, proof)
	if err != nil {
		return fmt.Errorf("submitAutoUpdate tx: %w", err)
	}

	w.logStep(
		bidID,
		"TX_SENT",
		"client=%s tx=%s digest=%s",
		clientAddress.Hex(),
		tx.Hash().Hex(),
		signResult.Digest.Hex(),
	)

	receipt, err := bind.WaitMined(ctx, w.ethClient, tx)
	if err != nil {
		return fmt.Errorf("wait tx mined: %w", err)
	}
	if receipt.Status == types.ReceiptStatusSuccessful {
		w.logStep(bidID, "DONE", "tx mined block=%d status=success gasUsed=%d", receipt.BlockNumber.Uint64(), receipt.GasUsed)
	} else {
		w.logStep(bidID, "DONE", "tx mined block=%d status=reverted gasUsed=%d", receipt.BlockNumber.Uint64(), receipt.GasUsed)
	}

	return nil
}

func (w *Worker) submitAutoUpdateTx(
	ctx context.Context,
	bidID *big.Int,
	update hubUpdateEnvelope,
	proof hubProofEnvelope,
) (*types.Transaction, error) {
	auth, err := bind.NewKeyedTransactorWithChainID(w.signer.PrivateKey(), w.chainID)
	if err != nil {
		return nil, err
	}
	auth.Context = ctx

	tx, err := w.hubContract.Transact(auth, "submitAutoUpdate", bidID, update, proof)
	if err != nil {
		return nil, err
	}

	return tx, nil
}

func (w *Worker) ensurePaymentTokenApproval(ctx context.Context) error {
	paymentTokenAddress, err := w.readHubAddress(ctx, "paymentToken")
	if err != nil {
		return err
	}

	lockupAmount, err := w.readHubBigInt(ctx, "autoFlowLockup")
	if err != nil {
		return err
	}

	erc20ABI, err := abi.JSON(strings.NewReader(erc20ABIJSON))
	if err != nil {
		return fmt.Errorf("load ERC20 ABI: %w", err)
	}

	tokenContract := bind.NewBoundContract(paymentTokenAddress, erc20ABI, w.ethClient, w.ethClient, w.ethClient)

	var allowanceOut []any
	if err := tokenContract.Call(
		&bind.CallOpts{Context: ctx},
		&allowanceOut,
		"allowance",
		w.signer.Address(),
		w.hubAddress,
	); err != nil {
		return fmt.Errorf("read allowance: %w", err)
	}
	if len(allowanceOut) != 1 {
		return fmt.Errorf("unexpected allowance output length")
	}

	allowance, ok := allowanceOut[0].(*big.Int)
	if !ok {
		return fmt.Errorf("unexpected allowance output type %T", allowanceOut[0])
	}
	if allowance.Cmp(lockupAmount) >= 0 {
		w.logStep(nil, "ALLOWANCE_OK", "existing allowance=%s lockup=%s", allowance.String(), lockupAmount.String())
		return nil
	}

	maxAllowance := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1))
	w.logStep(
		nil,
		"ALLOWANCE_NEEDS_UPDATE",
		"token=%s spender=%s allowance=%s requiredLockup=%s",
		paymentTokenAddress.Hex(),
		w.hubAddress.Hex(),
		allowance.String(),
		lockupAmount.String(),
	)

	tx, err := w.sendTokenApprove(ctx, tokenContract, w.hubAddress, maxAllowance)
	if err != nil {
		w.logStep(nil, "ALLOWANCE_RETRY", "max approve failed once: %v; trying reset-to-zero then max", err)

		resetTx, resetErr := w.sendTokenApprove(ctx, tokenContract, w.hubAddress, big.NewInt(0))
		if resetErr != nil {
			return fmt.Errorf("approve reset-to-zero failed: %w (initial approve err: %v)", resetErr, err)
		}
		w.logStep(nil, "ALLOWANCE_TX", "reset approval tx sent=%s", resetTx.Hash().Hex())
		if resetWaitErr := w.waitTxSuccess(ctx, resetTx, "approval reset-to-zero"); resetWaitErr != nil {
			return resetWaitErr
		}

		tx, err = w.sendTokenApprove(ctx, tokenContract, w.hubAddress, maxAllowance)
		if err != nil {
			return fmt.Errorf("approve max after reset failed: %w", err)
		}
	}

	w.logStep(
		nil,
		"ALLOWANCE_TX",
		"approval tx sent=%s (oldAllowance=%s lockup=%s spender=%s)",
		tx.Hash().Hex(),
		allowance.String(),
		lockupAmount.String(),
		w.hubAddress.Hex(),
	)
	if err := w.waitTxSuccess(ctx, tx, "approval max"); err != nil {
		return err
	}

	var postAllowanceOut []any
	if err := tokenContract.Call(
		&bind.CallOpts{Context: ctx},
		&postAllowanceOut,
		"allowance",
		w.signer.Address(),
		w.hubAddress,
	); err != nil {
		return fmt.Errorf("read allowance after approve: %w", err)
	}
	if len(postAllowanceOut) != 1 {
		return fmt.Errorf("unexpected allowance post-check output length")
	}
	postAllowance, ok := postAllowanceOut[0].(*big.Int)
	if !ok {
		return fmt.Errorf("unexpected post allowance output type %T", postAllowanceOut[0])
	}
	if postAllowance.Cmp(lockupAmount) < 0 {
		return fmt.Errorf("post approval allowance too low: got=%s need=%s", postAllowance.String(), lockupAmount.String())
	}
	w.logStep(nil, "ALLOWANCE_SET", "post allowance=%s", postAllowance.String())
	return nil
}

func (w *Worker) sendTokenApprove(
	ctx context.Context,
	tokenContract *bind.BoundContract,
	spender common.Address,
	amount *big.Int,
) (*types.Transaction, error) {
	auth, err := bind.NewKeyedTransactorWithChainID(w.signer.PrivateKey(), w.chainID)
	if err != nil {
		return nil, fmt.Errorf("create approve signer: %w", err)
	}
	auth.Context = ctx

	tx, err := tokenContract.Transact(auth, "approve", spender, amount)
	if err != nil {
		return nil, err
	}
	return tx, nil
}

func (w *Worker) waitTxSuccess(ctx context.Context, tx *types.Transaction, label string) error {
	receipt, err := bind.WaitMined(ctx, w.ethClient, tx)
	if err != nil {
		return fmt.Errorf("wait %s mined: %w", label, err)
	}
	if receipt.Status != types.ReceiptStatusSuccessful {
		return fmt.Errorf("%s transaction reverted tx=%s", label, tx.Hash().Hex())
	}
	w.logStep(nil, "TX_MINED", "%s block=%d gasUsed=%d", label, receipt.BlockNumber.Uint64(), receipt.GasUsed)
	return nil
}

func (w *Worker) loadOracleSpec(ctx context.Context, oracleAddress common.Address) (oracleSpec, error) {
	oracleContract := bind.NewBoundContract(oracleAddress, w.oracleABI, w.ethClient, w.ethClient, w.ethClient)

	query, err := callString(ctx, oracleContract, "query")
	if err != nil {
		return oracleSpec{}, err
	}
	expectedShape, err := callString(ctx, oracleContract, "expectedShape")
	if err != nil {
		return oracleSpec{}, err
	}
	model, err := callString(ctx, oracleContract, "model")
	if err != nil {
		return oracleSpec{}, err
	}
	clientVersion, err := callUint64(ctx, oracleContract, "clientVersion")
	if err != nil {
		return oracleSpec{}, err
	}

	return oracleSpec{
		Query:         query,
		ExpectedShape: expectedShape,
		Model:         model,
		ClientVersion: clientVersion,
	}, nil
}

func (w *Worker) readHubAddress(ctx context.Context, method string) (common.Address, error) {
	var out []any
	if err := w.hubContract.Call(&bind.CallOpts{Context: ctx}, &out, method); err != nil {
		return common.Address{}, fmt.Errorf("%s: %w", method, err)
	}
	if len(out) != 1 {
		return common.Address{}, fmt.Errorf("%s: unexpected output length %d", method, len(out))
	}

	address, ok := out[0].(common.Address)
	if !ok {
		return common.Address{}, fmt.Errorf("%s: unexpected output type %T", method, out[0])
	}
	return address, nil
}

func (w *Worker) readHubBigInt(ctx context.Context, method string) (*big.Int, error) {
	var out []any
	if err := w.hubContract.Call(&bind.CallOpts{Context: ctx}, &out, method); err != nil {
		return nil, fmt.Errorf("%s: %w", method, err)
	}
	if len(out) != 1 {
		return nil, fmt.Errorf("%s: unexpected output length %d", method, len(out))
	}

	value, ok := out[0].(*big.Int)
	if !ok {
		return nil, fmt.Errorf("%s: unexpected output type %T", method, out[0])
	}
	return value, nil
}

func callString(ctx context.Context, contract *bind.BoundContract, method string, args ...any) (string, error) {
	var out []any
	if err := contract.Call(&bind.CallOpts{Context: ctx}, &out, method, args...); err != nil {
		return "", fmt.Errorf("%s: %w", method, err)
	}
	if len(out) != 1 {
		return "", fmt.Errorf("%s: unexpected output length %d", method, len(out))
	}

	value, ok := out[0].(string)
	if !ok {
		return "", fmt.Errorf("%s: unexpected output type %T", method, out[0])
	}
	return value, nil
}

func callUint64(ctx context.Context, contract *bind.BoundContract, method string, args ...any) (uint64, error) {
	var out []any
	if err := contract.Call(&bind.CallOpts{Context: ctx}, &out, method, args...); err != nil {
		return 0, fmt.Errorf("%s: %w", method, err)
	}
	if len(out) != 1 {
		return 0, fmt.Errorf("%s: unexpected output length %d", method, len(out))
	}

	switch value := out[0].(type) {
	case uint64:
		return value, nil
	case *big.Int:
		return value.Uint64(), nil
	default:
		return 0, fmt.Errorf("%s: unexpected output type %T", method, out[0])
	}
}

func loadABI(path string) (abi.ABI, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return abi.ABI{}, fmt.Errorf("read %s: %w", path, err)
	}

	parsed, err := abi.JSON(strings.NewReader(string(raw)))
	if err != nil {
		return abi.ABI{}, fmt.Errorf("parse %s: %w", path, err)
	}

	return parsed, nil
}

func decodeBidPlaced(eventLog types.Log) (*big.Int, common.Address, error) {
	if len(eventLog.Topics) < 4 {
		return nil, common.Address{}, fmt.Errorf("expected 4 topics, got %d", len(eventLog.Topics))
	}

	bidID := new(big.Int).SetBytes(eventLog.Topics[1].Bytes())
	client := common.BytesToAddress(eventLog.Topics[3].Bytes()[12:])
	if bidID.Sign() <= 0 {
		return nil, common.Address{}, fmt.Errorf("invalid bid id")
	}
	if client == (common.Address{}) {
		return nil, common.Address{}, fmt.Errorf("zero client address")
	}

	return bidID, client, nil
}

func (w *Worker) computeHubDigest(ctx context.Context, bidID *big.Int, update hubUpdateEnvelope) (common.Hash, error) {
	var out []any
	if err := w.hubContract.Call(
		&bind.CallOpts{Context: ctx},
		&out,
		"computeUpdateDigest",
		update,
		bidID,
		true,
	); err != nil {
		return common.Hash{}, err
	}
	if len(out) != 1 {
		return common.Hash{}, fmt.Errorf("unexpected output length %d", len(out))
	}

	switch value := out[0].(type) {
	case [32]byte:
		return common.BytesToHash(value[:]), nil
	case common.Hash:
		return value, nil
	default:
		return common.Hash{}, fmt.Errorf("unexpected digest output type %T", out[0])
	}
}

func (w *Worker) verifyWithVerifierModule(
	ctx context.Context,
	digest common.Hash,
	bidID *big.Int,
	update hubUpdateEnvelope,
	proof hubProofEnvelope,
) (bool, common.Address, error) {
	verifierModule, err := w.readHubAddress(ctx, "verifierModule")
	if err != nil {
		return false, common.Address{}, err
	}

	verifierABI, err := abi.JSON(strings.NewReader(verifierABIJSON))
	if err != nil {
		return false, common.Address{}, fmt.Errorf("load verifier ABI: %w", err)
	}
	verifierContract := bind.NewBoundContract(verifierModule, verifierABI, w.ethClient, w.ethClient, w.ethClient)

	var out []any
	if err := verifierContract.Call(
		&bind.CallOpts{Context: ctx},
		&out,
		"verifyUpdate",
		digest,
		bidID,
		true,
		update,
		proof,
	); err != nil {
		return false, verifierModule, err
	}
	if len(out) != 1 {
		return false, verifierModule, fmt.Errorf("unexpected verifier output length %d", len(out))
	}

	value, ok := out[0].(bool)
	if !ok {
		return false, verifierModule, fmt.Errorf("unexpected verifier output type %T", out[0])
	}

	return value, verifierModule, nil
}

func (w *Worker) buildAutoFulfillInputData(bidID *big.Int, client common.Address, spec oracleSpec) map[string]any {
	result := map[string]any{
		"oracleClient":        client.Hex(),
		"bidId":               bidID.String(),
		"chainId":             w.chainID.String(),
		"query":               spec.Query,
		"expectedShape":       spec.ExpectedShape,
		"model":               spec.Model,
		"clientVersion":       spec.ClientVersion,
		"requestTimestampUtc": time.Now().UTC().Format(time.RFC3339),
	}

	for key, value := range w.cfg.AutoFulfillInputData {
		result[key] = value
	}

	return result
}

func summarizeShape(fields []shape.FieldSpec) string {
	parts := make([]string, 0, len(fields))
	for _, field := range fields {
		parts = append(parts, fmt.Sprintf("%s:%s", field.Name, field.SolidityType))
	}
	return strings.Join(parts, ",")
}

func formatOutputForLog(fields []shape.FieldSpec, shaped map[string]any) string {
	if shaped == nil {
		return "<nil>"
	}

	parts := make([]string, 0, len(fields))
	for _, field := range fields {
		value, ok := shaped[field.Name]
		if !ok {
			parts = append(parts, fmt.Sprintf("%s=<missing>", field.Name))
			continue
		}

		raw, err := json.Marshal(value)
		if err != nil {
			parts = append(parts, fmt.Sprintf("%s=<marshal-error:%v>", field.Name, err))
			continue
		}

		parts = append(parts, fmt.Sprintf("%s=%s", field.Name, truncateForLog(string(raw), 80)))
	}

	return strings.Join(parts, " | ")
}

func summarizeFieldDelta(fields []shape.FieldSpec, previous map[string]any, current map[string]any) string {
	if previous == nil || current == nil {
		return "delta unavailable (missing previous/current output)"
	}

	changed := make([]string, 0, len(fields))
	unchanged := make([]string, 0, len(fields))
	missing := make([]string, 0)

	for _, field := range fields {
		prevValue, prevOK := previous[field.Name]
		currValue, currOK := current[field.Name]
		if !prevOK || !currOK {
			missing = append(missing, field.Name)
			continue
		}

		if jsonValuesEqual(prevValue, currValue) {
			unchanged = append(unchanged, field.Name)
			continue
		}

		prevRaw, _ := json.Marshal(prevValue)
		currRaw, _ := json.Marshal(currValue)
		changed = append(
			changed,
			fmt.Sprintf(
				"%s:%s->%s",
				field.Name,
				truncateForLog(string(prevRaw), 40),
				truncateForLog(string(currRaw), 40),
			),
		)
	}

	return fmt.Sprintf(
		"changed=%d [%s] unchanged=%d [%s] missing=%d [%s]",
		len(changed),
		strings.Join(changed, ", "),
		len(unchanged),
		strings.Join(unchanged, ", "),
		len(missing),
		strings.Join(missing, ", "),
	)
}

func isTimeLikeField(name string) bool {
	lower := strings.ToLower(strings.TrimSpace(name))
	if lower == "" {
		return false
	}
	return strings.Contains(lower, "timestamp") ||
		strings.Contains(lower, "time") ||
		strings.Contains(lower, "date") ||
		strings.Contains(lower, "asof")
}

func jsonValuesEqual(a any, b any) bool {
	ja, errA := json.Marshal(a)
	jb, errB := json.Marshal(b)
	if errA != nil || errB != nil {
		return fmt.Sprintf("%v", a) == fmt.Sprintf("%v", b)
	}
	return string(ja) == string(jb)
}

func cloneAnyMap(input map[string]any) map[string]any {
	if input == nil {
		return nil
	}

	cloned := make(map[string]any, len(input))
	for key, value := range input {
		cloned[key] = value
	}
	return cloned
}

func truncateForLog(value string, maxChars int) string {
	if maxChars <= 0 || len(value) <= maxChars {
		return value
	}
	return value[:maxChars] + "..."
}

func previewBytesHex(data []byte, maxBytes int) string {
	if len(data) == 0 {
		return "0x"
	}
	if maxBytes <= 0 {
		maxBytes = 16
	}
	if len(data) <= maxBytes {
		return fmt.Sprintf("0x%x", data)
	}
	return fmt.Sprintf("0x%x...(len=%d)", data[:maxBytes], len(data))
}

func (w *Worker) logStep(bidID *big.Int, stage string, format string, args ...any) {
	stage = strings.ToUpper(strings.TrimSpace(stage))
	if stage == "" {
		stage = "STEP"
	}

	message := fmt.Sprintf(format, args...)
	if bidID == nil {
		log.Printf("[AUTOFULFILL] %-12s | %s", stage, message)
		return
	}

	log.Printf("[AUTOFULFILL] [bid=%s] %-12s | %s", bidID.String(), stage, message)
}

func deriveOpenAIModel(model string) string {
	model = strings.TrimSpace(model)
	if model == "" {
		return ""
	}

	if strings.HasPrefix(model, "openai:") {
		return strings.TrimPrefix(model, "openai:")
	}

	return model
}

const erc20ABIJSON = `[
  {
    "type":"function",
    "name":"allowance",
    "inputs":[
      {"name":"owner","type":"address","internalType":"address"},
      {"name":"spender","type":"address","internalType":"address"}
    ],
    "outputs":[{"name":"","type":"uint256","internalType":"uint256"}],
    "stateMutability":"view"
  },
  {
    "type":"function",
    "name":"approve",
    "inputs":[
      {"name":"spender","type":"address","internalType":"address"},
      {"name":"value","type":"uint256","internalType":"uint256"}
    ],
    "outputs":[{"name":"","type":"bool","internalType":"bool"}],
    "stateMutability":"nonpayable"
  }
]`

const verifierABIJSON = `[
  {
    "type":"function",
    "name":"verifyUpdate",
    "inputs":[
      {"name":"digest","type":"bytes32","internalType":"bytes32"},
      {"name":"bidId","type":"uint256","internalType":"uint256"},
      {"name":"autoFlow","type":"bool","internalType":"bool"},
      {
        "name":"update",
        "type":"tuple",
        "internalType":"struct IThassaHub.UpdateEnvelope",
        "components":[
          {"name":"client","type":"address","internalType":"address"},
          {"name":"callbackData","type":"bytes","internalType":"bytes"},
          {"name":"queryHash","type":"bytes32","internalType":"bytes32"},
          {"name":"shapeHash","type":"bytes32","internalType":"bytes32"},
          {"name":"modelHash","type":"bytes32","internalType":"bytes32"},
          {"name":"clientVersion","type":"uint64","internalType":"uint64"},
          {"name":"requestTimestamp","type":"uint64","internalType":"uint64"},
          {"name":"expiry","type":"uint64","internalType":"uint64"},
          {"name":"nonce","type":"uint256","internalType":"uint256"},
          {"name":"fulfiller","type":"address","internalType":"address"}
        ]
      },
      {
        "name":"proof",
        "type":"tuple",
        "internalType":"struct IThassaHub.ProofEnvelope",
        "components":[
          {"name":"scheme","type":"uint8","internalType":"uint8"},
          {"name":"publicValues","type":"bytes","internalType":"bytes"},
          {"name":"proof","type":"bytes","internalType":"bytes"}
        ]
      }
    ],
    "outputs":[{"name":"","type":"bool","internalType":"bool"}],
    "stateMutability":"view"
  }
]`
