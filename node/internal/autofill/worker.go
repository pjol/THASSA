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
	"github.com/pjol/THASSA/node/internal/sources"
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
	// GenerateStructuredOutputNoSearch is the web-search-disabled variant used for
	// evidence-only settlement adjudication (spec 6.5b).
	GenerateStructuredOutputNoSearch(
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

	sourceRegistry      *sources.Registry
	mcpClient           *sources.MCPClient
	lastRegistryRefresh time.Time

	lastShapedOutputByClient map[common.Address]map[string]any
}

// registryRefreshInterval bounds how often the source registry is re-fetched over MCP.
const registryRefreshInterval = 10 * time.Minute

type hubUpdateEnvelope struct {
	Client           common.Address
	CallbackData     []byte
	InputData        []byte
	ResponseId       [32]byte
	QueryHash        [32]byte
	ShapeHash        [32]byte
	ModelHash        [32]byte
	ClientVersion    uint64
	RequestTimestamp uint64
	Fulfiller        common.Address
}

type hubBid struct {
	Requester     common.Address
	Client        common.Address
	Amount        *big.Int
	IsOpen        bool
	BaseFee       *big.Int
	PriorityFee   *big.Int
	ProtocolFee   *big.Int
	NodeFee       *big.Int
	AllocatedNode common.Address
	InputDataHash [32]byte
	ResponseId    [32]byte
}

var defaultInputDataHash = crypto.Keccak256Hash([]byte("{}"))

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

	var mcpClient *sources.MCPClient
	if strings.TrimSpace(cfg.NodeMCPURL) != "" {
		mcpClient = sources.NewMCPClient(cfg.NodeMCPURL, cfg.SourceFetchTimeout)
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
		sourceRegistry:           sources.NewRegistry(cfg.SourceFetchTimeout),
		mcpClient:                mcpClient,
		lastShapedOutputByClient: make(map[common.Address]map[string]any),
	}, nil
}

// maybeRefreshRegistry re-fetches the source registry over MCP at most every
// registryRefreshInterval; failures degrade gracefully to the built-in defaults.
func (w *Worker) maybeRefreshRegistry(ctx context.Context) {
	if w.mcpClient == nil {
		return
	}
	if !w.lastRegistryRefresh.IsZero() && time.Since(w.lastRegistryRefresh) < registryRefreshInterval {
		return
	}
	w.lastRegistryRefresh = time.Now()

	categories, err := w.mcpClient.ListSources(ctx, "")
	if err != nil {
		w.logStep(nil, "REGISTRY", "mcp list_sources failed (keeping built-in registry): %v", err)
		return
	}

	w.sourceRegistry.ApplyCategories(categories)
	w.logStep(nil, "REGISTRY", "source registry refreshed over MCP: %d categories", len(categories))
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

	w.maybeRefreshRegistry(ctx)

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

		if err := w.tryFulfillBid(ctx, bidID, clientAddress, eventLog.TxHash); err != nil {
			w.logStep(bidID, "FAILED", "%v", err)
			continue
		}
	}

	return nil
}

func (w *Worker) tryFulfillBid(ctx context.Context, bidID *big.Int, clientAddress common.Address, txHash common.Hash) error {
	if bidID == nil || bidID.Sign() <= 0 {
		return fmt.Errorf("invalid bid id")
	}

	w.logStep(bidID, "BID", "loading bid record from hub")
	bid, err := w.loadBid(ctx, bidID)
	if err != nil {
		return fmt.Errorf("load bid: %w", err)
	}
	if !bid.IsOpen {
		w.logStep(bidID, "BID_SKIP", "bid is no longer open")
		return nil
	}

	rawInputData, err := w.resolveBidInputData(ctx, bidID, clientAddress, bid.InputDataHash, txHash)
	if err != nil {
		return fmt.Errorf("resolve bid inputData: %w", err)
	}
	w.logStep(
		bidID,
		"INPUT_DATA",
		"inputDataBytes=%d inputDataHash=%s preview=%s",
		len(rawInputData),
		crypto.Keccak256Hash(rawInputData).Hex(),
		previewBytesHex(rawInputData, 48),
	)

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

	settlementMarketID, settlementQuestion, isSettlementBid := decodeSettlementInputData(rawInputData)

	// Structured settlement queries with bound sources resolve through node-side source
	// fetching + evidence-only adjudication (spec 6.5b) instead of LLM web search.
	if isSettlementBid && isMarketsSettlementShape(outputShape) {
		if parsedQuery, structured := sources.ParseSettlementQuery(settlementQuestion); structured && len(parsedQuery.Sources) > 0 {
			return w.fulfillWithSources(
				ctx, bidID, clientAddress, spec, bid, rawInputData, outputShape, openAIModel, settlementMarketID, parsedQuery,
			)
		}
		w.logStep(bidID, "SOURCES_SKIP", "settlement query is unstructured or binds no sources; using general LLM path (labeled general adjudication)")
	}

	inputData := w.buildAutoFulfillInputData(bidID, clientAddress, spec)
	if isSettlementBid {
		inputData["marketId"] = settlementMarketID.String()
		inputData["settlementQuestion"] = settlementQuestion
	} else if len(rawInputData) > 0 && string(rawInputData) != "{}" {
		inputData["inputDataHex"] = fmt.Sprintf("0x%x", rawInputData)
	}
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

	// Markets settlement shape hardening: the signed response must echo the marketId bound
	// into the bid inputData, never one invented by the model.
	if isSettlementBid && shape.HasField(outputShape, "marketId") {
		if current, ok := shapedOutput["marketId"]; !ok || !jsonValuesEqual(fmt.Sprintf("%v", current), settlementMarketID.String()) {
			w.logStep(bidID, "MARKET_ID_FIX", "model echoed marketId=%v; enforcing bound marketId=%s", shapedOutput["marketId"], settlementMarketID.String())
		}
		shapedOutput["marketId"] = settlementMarketID.String()
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

	return w.signAndSubmitUpdate(ctx, bidID, clientAddress, spec, bid, rawInputData, callbackData)
}

// isMarketsSettlementShape reports whether the client's expected shape is exactly the markets
// settlement tuple (marketId, settled, direction) the source-adjudication path can produce.
func isMarketsSettlementShape(outputShape []shape.FieldSpec) bool {
	return len(outputShape) == 3 &&
		shape.HasField(outputShape, "marketId") &&
		shape.HasField(outputShape, "settled") &&
		shape.HasField(outputShape, "direction")
}

// fulfillWithSources resolves a structured settlement query per spec 6.5b: the node fetches every
// bound source itself, the LLM adjudicates each source's evidence independently with web search
// disabled, and concurrence is computed in code. No update is produced when the outcome is not
// (yet) resolvable — the bid stays open and is retried on a later scan.
func (w *Worker) fulfillWithSources(
	ctx context.Context,
	bidID *big.Int,
	clientAddress common.Address,
	spec oracleSpec,
	bid hubBid,
	rawInputData []byte,
	outputShape []shape.FieldSpec,
	openAIModel string,
	marketID *big.Int,
	parsedQuery sources.StructuredQuery,
) error {
	w.logStep(
		bidID,
		"SOURCES",
		"structured settlement query category=%s rule=%s boundSources=%d question=%s",
		parsedQuery.Category,
		parsedQuery.Rule,
		len(parsedQuery.Sources),
		truncateForLog(parsedQuery.Question, 160),
	)

	w.maybeRefreshRegistry(ctx)

	adjudicationCtx, cancel := context.WithTimeout(ctx, w.cfg.AutoFulfillLLMTimeout)
	defer cancel()

	outcome, verdicts, err := fulfillment.AdjudicateSources(
		adjudicationCtx,
		w.sourceRegistry,
		w.openai,
		openAIModel,
		parsedQuery,
		func(format string, args ...any) {
			w.logStep(bidID, "ADJUDICATE", format, args...)
		},
	)
	if err != nil {
		return fmt.Errorf("adjudicate sources: %w", err)
	}

	for _, verdict := range verdicts {
		if verdict.Err != nil {
			w.logStep(bidID, "VERDICT", "source=%s error=%v", verdict.SourceID, verdict.Err)
			continue
		}
		w.logStep(bidID, "VERDICT", "source=%s settled=%t direction=%t", verdict.SourceID, verdict.Settled, verdict.Direction)
	}

	if !outcome.Settled {
		return fmt.Errorf("settlement outcome not resolvable now (%s); no update produced, bid remains open for retry", outcome.Reason)
	}
	w.logStep(bidID, "OUTCOME", "settled=true direction=%t (%s)", outcome.Direction, outcome.Reason)

	shapedOutput := map[string]any{
		"marketId":  marketID.String(),
		"settled":   true,
		"direction": outcome.Direction,
	}

	callbackData, err := w.formatter.EncodeCallbackData(outputShape, shapedOutput)
	if err != nil {
		return fmt.Errorf("encode callback data: %w", err)
	}
	w.logStep(
		bidID,
		"ABI_OK",
		"callbackDataBytes=%d callbackDataHash=%s",
		len(callbackData),
		crypto.Keccak256Hash(callbackData).Hex(),
	)

	return w.signAndSubmitUpdate(ctx, bidID, clientAddress, spec, bid, rawInputData, callbackData)
}

// signAndSubmitUpdate signs the ProofUpdateV2 envelope for a fulfilled result and submits the
// auto update through the hub after digest and verifier preflights.
func (w *Worker) signAndSubmitUpdate(
	ctx context.Context,
	bidID *big.Int,
	clientAddress common.Address,
	spec oracleSpec,
	bid hubBid,
	rawInputData []byte,
	callbackData []byte,
) error {
	queryHash := crypto.Keccak256Hash([]byte(spec.Query))
	shapeHash := crypto.Keccak256Hash([]byte(spec.ExpectedShape))
	modelHash := crypto.Keccak256Hash([]byte(spec.Model))

	requestTimestamp := uint64(time.Now().Unix())
	w.logStep(
		bidID,
		"HASHES",
		"queryHash=%s shapeHash=%s modelHash=%s responseId=%s requestTimestamp=%d",
		queryHash.Hex(),
		shapeHash.Hex(),
		modelHash.Hex(),
		common.Hash(bid.ResponseId).Hex(),
		requestTimestamp,
	)

	signResult, err := w.signer.SignUpdate(signing.SignRequest{
		HubAddress: w.hubAddress,
		ChainID:    w.chainID,
		BidID:      bidID,
		AutoFlow:   true,
		Payload: signing.UpdatePayload{
			Client:           clientAddress,
			CallbackData:     callbackData,
			InputData:        rawInputData,
			ResponseID:       bid.ResponseId,
			QueryHash:        queryHash,
			ShapeHash:        shapeHash,
			ModelHash:        modelHash,
			ClientVersion:    spec.ClientVersion,
			RequestTimestamp: requestTimestamp,
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
		InputData:        rawInputData,
		ResponseId:       bid.ResponseId,
		QueryHash:        queryHash,
		ShapeHash:        shapeHash,
		ModelHash:        modelHash,
		ClientVersion:    spec.ClientVersion,
		RequestTimestamp: requestTimestamp,
		Fulfiller:        w.signer.Address(),
	}

	// Updates are only ever submitted for fulfilled results; unfulfilled runs abort earlier.
	publicValues, err := format.EncodeFulfillmentPublicValues(true)
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

func (w *Worker) loadBid(ctx context.Context, bidID *big.Int) (hubBid, error) {
	var out []any
	if err := w.hubContract.Call(&bind.CallOpts{Context: ctx}, &out, "getBid", bidID); err != nil {
		return hubBid{}, fmt.Errorf("getBid: %w", err)
	}
	if len(out) != 1 {
		return hubBid{}, fmt.Errorf("getBid: unexpected output length %d", len(out))
	}

	bid := abi.ConvertType(out[0], new(hubBid)).(*hubBid)
	return *bid, nil
}

// resolveBidInputData recovers the exact inputData bytes bound into a bid. The hub only stores
// keccak256(inputData), so the node reconstructs the preimage from (in order):
//  1. the default "{}" marker,
//  2. the client contract's optional bidInputData(uint256) view (ThassaMarkets exposes it),
//  3. the calldata of the transaction that placed the bid (placeBid*WithInputData variants).
func (w *Worker) resolveBidInputData(
	ctx context.Context,
	bidID *big.Int,
	clientAddress common.Address,
	inputDataHash [32]byte,
	txHash common.Hash,
) ([]byte, error) {
	if common.Hash(inputDataHash) == defaultInputDataHash {
		return []byte("{}"), nil
	}

	if data, err := w.callClientBidInputData(ctx, clientAddress, bidID); err == nil {
		if crypto.Keccak256Hash(data) == common.Hash(inputDataHash) {
			return data, nil
		}
		w.logStep(bidID, "INPUT_MISMATCH", "client bidInputData hash mismatch; falling back to tx calldata")
	} else {
		w.logStep(bidID, "INPUT_VIEW_MISS", "client bidInputData view unavailable: %v", err)
	}

	data, err := w.extractInputDataFromTx(ctx, txHash, inputDataHash)
	if err != nil {
		return nil, fmt.Errorf(
			"cannot recover inputData preimage for hash %s: %w",
			common.Hash(inputDataHash).Hex(),
			err,
		)
	}
	return data, nil
}

func (w *Worker) callClientBidInputData(
	ctx context.Context,
	clientAddress common.Address,
	bidID *big.Int,
) ([]byte, error) {
	clientABI, err := abi.JSON(strings.NewReader(bidInputDataABIJSON))
	if err != nil {
		return nil, fmt.Errorf("load bidInputData ABI: %w", err)
	}

	clientContract := bind.NewBoundContract(clientAddress, clientABI, w.ethClient, w.ethClient, w.ethClient)

	var out []any
	if err := clientContract.Call(&bind.CallOpts{Context: ctx}, &out, "bidInputData", bidID); err != nil {
		return nil, err
	}
	if len(out) != 1 {
		return nil, fmt.Errorf("bidInputData: unexpected output length %d", len(out))
	}

	data, ok := out[0].([]byte)
	if !ok {
		return nil, fmt.Errorf("bidInputData: unexpected output type %T", out[0])
	}
	if len(data) == 0 {
		return nil, fmt.Errorf("bidInputData: empty result")
	}
	return data, nil
}

func (w *Worker) extractInputDataFromTx(
	ctx context.Context,
	txHash common.Hash,
	inputDataHash [32]byte,
) ([]byte, error) {
	tx, _, err := w.ethClient.TransactionByHash(ctx, txHash)
	if err != nil {
		return nil, fmt.Errorf("fetch bid tx %s: %w", txHash.Hex(), err)
	}

	calldata := tx.Data()
	if len(calldata) < 4 {
		return nil, fmt.Errorf("bid tx %s calldata too short", txHash.Hex())
	}

	method, err := w.hubABI.MethodById(calldata[:4])
	if err != nil {
		return nil, fmt.Errorf("bid tx %s is not a direct hub call: %w", txHash.Hex(), err)
	}

	args, err := method.Inputs.Unpack(calldata[4:])
	if err != nil {
		return nil, fmt.Errorf("unpack %s calldata: %w", method.Name, err)
	}

	for i, input := range method.Inputs {
		if input.Name != "inputData" {
			continue
		}
		data, ok := args[i].([]byte)
		if !ok {
			return nil, fmt.Errorf("%s inputData arg has unexpected type %T", method.Name, args[i])
		}
		if crypto.Keccak256Hash(data) != common.Hash(inputDataHash) {
			return nil, fmt.Errorf("%s calldata inputData does not match bid inputDataHash", method.Name)
		}
		return data, nil
	}

	return nil, fmt.Errorf("hub method %s carries no inputData argument", method.Name)
}

// decodeSettlementInputData decodes the markets settlement binding
// abi.encode(marketId:uint256, settlementQuery:string).
func decodeSettlementInputData(raw []byte) (*big.Int, string, bool) {
	args, err := newDecodeArguments("uint256", "string")
	if err != nil {
		return nil, "", false
	}

	values, err := args.Unpack(raw)
	if err != nil || len(values) != 2 {
		return nil, "", false
	}

	marketID, ok := values[0].(*big.Int)
	if !ok {
		return nil, "", false
	}
	query, ok := values[1].(string)
	if !ok || strings.TrimSpace(query) == "" {
		return nil, "", false
	}

	return marketID, query, true
}

func newDecodeArguments(typeNames ...string) (abi.Arguments, error) {
	args := make(abi.Arguments, 0, len(typeNames))
	for _, typeName := range typeNames {
		argType, err := abi.NewType(typeName, "", nil)
		if err != nil {
			return nil, fmt.Errorf("create ABI type %q: %w", typeName, err)
		}
		args = append(args, abi.Argument{Type: argType})
	}
	return args, nil
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

const bidInputDataABIJSON = `[
  {
    "type":"function",
    "name":"bidInputData",
    "inputs":[{"name":"bidId","type":"uint256","internalType":"uint256"}],
    "outputs":[{"name":"","type":"bytes","internalType":"bytes"}],
    "stateMutability":"view"
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
          {"name":"inputData","type":"bytes","internalType":"bytes"},
          {"name":"responseId","type":"bytes32","internalType":"bytes32"},
          {"name":"queryHash","type":"bytes32","internalType":"bytes32"},
          {"name":"shapeHash","type":"bytes32","internalType":"bytes32"},
          {"name":"modelHash","type":"bytes32","internalType":"bytes32"},
          {"name":"clientVersion","type":"uint64","internalType":"uint64"},
          {"name":"requestTimestamp","type":"uint64","internalType":"uint64"},
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
