package server

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/pjol/THASSA/node/internal/config"
	"github.com/pjol/THASSA/node/internal/format"
	"github.com/pjol/THASSA/node/internal/fulfillment"
	"github.com/pjol/THASSA/node/internal/shape"
	"github.com/pjol/THASSA/node/internal/signing"
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

type UpdateRequest struct {
	Client           string            `json:"client"`
	ThassaHub        string            `json:"thassaHub,omitempty"`
	ChainID          uint64            `json:"chainId,omitempty"`
	BidID            uint64            `json:"bidId,omitempty"`
	AutoFlow         bool              `json:"autoFlow,omitempty"`
	ClientVersion    uint64            `json:"clientVersion,omitempty"`
	RequestTimestamp uint64            `json:"requestTimestamp,omitempty"`
	Expiry           uint64            `json:"expiry,omitempty"`
	TTLSeconds       uint64            `json:"ttlSeconds,omitempty"`
	Nonce            uint64            `json:"nonce,omitempty"`
	Query            string            `json:"query"`
	InputData        map[string]any    `json:"inputData,omitempty"`
	ExpectedShape    string            `json:"expectedShape,omitempty"`
	Shape            []shape.FieldSpec `json:"shape,omitempty"`
	OutputShape      []shape.FieldSpec `json:"outputShape,omitempty"`
	Model            string            `json:"model,omitempty"`
	OpenAIModel      string            `json:"openAIModel,omitempty"`
	QueryHash        string            `json:"queryHash,omitempty"`
	ShapeHash        string            `json:"shapeHash,omitempty"`
	ModelHash        string            `json:"modelHash,omitempty"`
}

type updateResponse struct {
	OracleSpec       oracleSpecJSON     `json:"oracleSpec"`
	OpenAIModel      string             `json:"openAIModel"`
	Fulfiller        string             `json:"fulfiller"`
	ExpectedShape    string             `json:"expectedShape"`
	CanonicalShape   string             `json:"canonicalShape"`
	StructuredOutput map[string]any     `json:"structuredOutput"`
	RawModelJSON     string             `json:"rawModelJson"`
	CallbackData     string             `json:"callbackData"`
	Digest           string             `json:"digest"`
	UpdateEnvelope   updateEnvelopeJSON `json:"updateEnvelope"`
	ProofEnvelope    proofEnvelopeJSON  `json:"proofEnvelope"`
	SigningContext   signingContext     `json:"signingContext"`
	HashCommitments  hashCommitmentSet  `json:"hashCommitments"`
}

type updateEnvelopeJSON struct {
	Client           string `json:"client"`
	CallbackData     string `json:"callbackData"`
	QueryHash        string `json:"queryHash"`
	ShapeHash        string `json:"shapeHash"`
	ModelHash        string `json:"modelHash"`
	ClientVersion    uint64 `json:"clientVersion"`
	RequestTimestamp uint64 `json:"requestTimestamp"`
	Expiry           uint64 `json:"expiry"`
	Nonce            string `json:"nonce"`
	Fulfiller        string `json:"fulfiller"`
}

type proofEnvelopeJSON struct {
	Scheme       uint8  `json:"scheme"`
	PublicValues string `json:"publicValues"`
	Proof        string `json:"proof"`
}

type oracleSpecJSON struct {
	Query         string `json:"query"`
	ExpectedShape string `json:"expectedShape"`
	Model         string `json:"model"`
	ClientVersion uint64 `json:"clientVersion"`
}

type signingContext struct {
	ThassaHub string `json:"thassaHub"`
	ChainID   string `json:"chainId"`
	BidID     string `json:"bidId"`
	AutoFlow  bool   `json:"autoFlow"`
}

type hashCommitmentSet struct {
	QueryHash string `json:"queryHash"`
	ShapeHash string `json:"shapeHash"`
	ModelHash string `json:"modelHash"`
}

type jsonError struct {
	Error string `json:"error"`
}

type Server struct {
	cfg       config.Config
	openai    OpenAIClient
	formatter format.CallbackFormatter
	signer    *signing.Signer
}

func New(cfg config.Config, openaiClient OpenAIClient, formatter format.CallbackFormatter, signer *signing.Signer) *Server {
	return &Server{
		cfg:       cfg,
		openai:    openaiClient,
		formatter: formatter,
		signer:    signer,
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.handleHealth)
	mux.HandleFunc("/v1/update", s.handleUpdate)
	return mux
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, jsonError{Error: "method not allowed"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"service": "thassa-node-demo",
	})
}

func (s *Server) handleUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, jsonError{Error: "method not allowed"})
		return
	}

	var req UpdateRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, jsonError{Error: fmt.Sprintf("invalid request: %v", err)})
		return
	}

	if strings.TrimSpace(req.Client) == "" {
		writeJSON(w, http.StatusBadRequest, jsonError{Error: "client is required"})
		return
	}
	if !common.IsHexAddress(req.Client) {
		writeJSON(w, http.StatusBadRequest, jsonError{Error: "client must be a valid hex address"})
		return
	}
	if strings.TrimSpace(req.Query) == "" {
		writeJSON(w, http.StatusBadRequest, jsonError{Error: "query is required"})
		return
	}

	outputShape := req.Shape
	if len(outputShape) == 0 {
		outputShape = req.OutputShape
	}
	if err := shape.ValidateFields(outputShape); err != nil {
		writeJSON(w, http.StatusBadRequest, jsonError{Error: fmt.Sprintf("invalid shape: %v", err)})
		return
	}
	if shape.HasField(outputShape, shape.FulfillmentFieldName) {
		writeJSON(
			w,
			http.StatusBadRequest,
			jsonError{Error: fmt.Sprintf("shape must not include reserved field %q; it is added automatically", shape.FulfillmentFieldName)},
		)
		return
	}

	llmShape := shape.WithFulfillmentField(outputShape)

	schema, err := shape.BuildJSONSchema(llmShape)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, jsonError{Error: fmt.Sprintf("build schema: %v", err)})
		return
	}

	canonicalShape, err := shape.CanonicalShape(outputShape)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, jsonError{Error: fmt.Sprintf("canonical shape: %v", err)})
		return
	}

	expectedShape := strings.TrimSpace(req.ExpectedShape)
	if expectedShape == "" {
		expectedShape = canonicalShape
	}

	committedModel := strings.TrimSpace(req.Model)
	if committedModel == "" {
		committedModel = strings.TrimSpace(s.cfg.DefaultModel)
	}
	if committedModel == "" {
		writeJSON(w, http.StatusBadRequest, jsonError{Error: "model is required (request.model or OPENAI_MODEL)"})
		return
	}

	openAIModel := strings.TrimSpace(req.OpenAIModel)
	if openAIModel == "" {
		openAIModel = deriveOpenAIModel(committedModel)
	}
	if openAIModel == "" {
		writeJSON(
			w,
			http.StatusBadRequest,
			jsonError{Error: "openAIModel could not be derived; provide request.openAIModel"},
		)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), s.cfg.RequestTimeout)
	defer cancel()

	result, err := fulfillment.GenerateUntilFulfilled(
		ctx,
		s.openai,
		openAIModel,
		req.Query,
		req.InputData,
		schema,
		llmShape,
		func(format string, args ...any) {
			log.Printf("[UPDATE] "+format, args...)
		},
	)
	if err != nil {
		log.Printf("openai request failed: %v", err)
		writeJSON(w, http.StatusBadGateway, jsonError{Error: fmt.Sprintf("openai request failed: %v", err)})
		return
	}

	shapedOutput := result.ShapedOutput
	rawModelJSON := result.RawModelJSON
	llmFulfilled := result.Fulfilled
	log.Printf("[UPDATE] structured output fulfilled after attempts=%d", result.Attempts)

	callbackData, err := s.formatter.EncodeCallbackData(outputShape, shapedOutput)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, jsonError{Error: fmt.Sprintf("format callbackData: %v", err)})
		return
	}

	publicValues, err := format.EncodeFulfillmentPublicValues(llmFulfilled)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, jsonError{Error: fmt.Sprintf("encode proof public values: %v", err)})
		return
	}

	queryHash, err := selectHash(req.QueryHash, req.Query)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, jsonError{Error: fmt.Sprintf("queryHash: %v", err)})
		return
	}

	shapeHash, err := selectHash(req.ShapeHash, expectedShape)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, jsonError{Error: fmt.Sprintf("shapeHash: %v", err)})
		return
	}

	modelHash, err := selectHash(req.ModelHash, committedModel)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, jsonError{Error: fmt.Sprintf("modelHash: %v", err)})
		return
	}

	hubAddress := req.ThassaHub
	if hubAddress == "" {
		hubAddress = s.cfg.DefaultHubAddress
	}
	if hubAddress == "" || !common.IsHexAddress(hubAddress) {
		writeJSON(
			w,
			http.StatusBadRequest,
			jsonError{Error: "thassaHub is required (request.thassaHub or DEFAULT_THASSA_HUB)"},
		)
		return
	}

	chainID := req.ChainID
	if chainID == 0 {
		chainID = s.cfg.DefaultChainID
	}

	clientVersion := req.ClientVersion
	if clientVersion == 0 {
		clientVersion = s.cfg.DefaultClientVersion
	}

	expiry := req.Expiry
	requestTimestamp := req.RequestTimestamp
	if requestTimestamp == 0 {
		requestTimestamp = uint64(time.Now().Unix())
	}
	if expiry == 0 {
		ttl := req.TTLSeconds
		if ttl == 0 {
			ttl = s.cfg.DefaultTTLSeconds
		}
		expiry = requestTimestamp + ttl
	}

	nonce := req.Nonce
	if nonce == 0 {
		nonce = uint64(time.Now().UnixNano())
	}

	signResult, err := s.signer.SignUpdate(signing.SignRequest{
		HubAddress: common.HexToAddress(hubAddress),
		ChainID:    new(big.Int).SetUint64(chainID),
		BidID:      new(big.Int).SetUint64(req.BidID),
		AutoFlow:   req.AutoFlow,
		Payload: signing.UpdatePayload{
			Client:           common.HexToAddress(req.Client),
			CallbackData:     callbackData,
			QueryHash:        queryHash,
			ShapeHash:        shapeHash,
			ModelHash:        modelHash,
			ClientVersion:    clientVersion,
			RequestTimestamp: requestTimestamp,
			Expiry:           expiry,
			Nonce:            new(big.Int).SetUint64(nonce),
			Fulfiller:        s.signer.Address(),
		},
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, jsonError{Error: fmt.Sprintf("sign update: %v", err)})
		return
	}

	response := updateResponse{
		OracleSpec: oracleSpecJSON{
			Query:         req.Query,
			ExpectedShape: expectedShape,
			Model:         committedModel,
			ClientVersion: clientVersion,
		},
		OpenAIModel:      openAIModel,
		Fulfiller:        s.signer.Address().Hex(),
		ExpectedShape:    expectedShape,
		CanonicalShape:   canonicalShape,
		StructuredOutput: shapedOutput,
		RawModelJSON:     rawModelJSON,
		CallbackData:     "0x" + hex.EncodeToString(callbackData),
		Digest:           signResult.Digest.Hex(),
		UpdateEnvelope: updateEnvelopeJSON{
			Client:           common.HexToAddress(req.Client).Hex(),
			CallbackData:     "0x" + hex.EncodeToString(callbackData),
			QueryHash:        queryHash.Hex(),
			ShapeHash:        shapeHash.Hex(),
			ModelHash:        modelHash.Hex(),
			ClientVersion:    clientVersion,
			RequestTimestamp: requestTimestamp,
			Expiry:           expiry,
			Nonce:            new(big.Int).SetUint64(nonce).String(),
			Fulfiller:        s.signer.Address().Hex(),
		},
		ProofEnvelope: proofEnvelopeJSON{
			Scheme:       1,
			PublicValues: "0x" + hex.EncodeToString(publicValues),
			Proof:        "0x" + hex.EncodeToString(signResult.Signature),
		},
		SigningContext: signingContext{
			ThassaHub: common.HexToAddress(hubAddress).Hex(),
			ChainID:   new(big.Int).SetUint64(chainID).String(),
			BidID:     new(big.Int).SetUint64(req.BidID).String(),
			AutoFlow:  req.AutoFlow,
		},
		HashCommitments: hashCommitmentSet{
			QueryHash: queryHash.Hex(),
			ShapeHash: shapeHash.Hex(),
			ModelHash: modelHash.Hex(),
		},
	}

	writeJSON(w, http.StatusOK, response)
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

func writeJSON(w http.ResponseWriter, statusCode int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	_ = json.NewEncoder(w).Encode(payload)
}

func selectHash(override string, fallback string) (common.Hash, error) {
	if strings.TrimSpace(override) == "" {
		return crypto.Keccak256Hash([]byte(fallback)), nil
	}

	trimmed := strings.TrimPrefix(strings.TrimPrefix(strings.TrimSpace(override), "0x"), "0X")
	if len(trimmed) != 64 {
		return common.Hash{}, fmt.Errorf("must be 32-byte hex")
	}
	if _, err := hex.DecodeString(trimmed); err != nil {
		return common.Hash{}, fmt.Errorf("must be 32-byte hex: %w", err)
	}

	return common.HexToHash("0x" + trimmed), nil
}
