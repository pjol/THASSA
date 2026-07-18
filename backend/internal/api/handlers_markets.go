package api

import (
	"errors"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/google/uuid"

	"github.com/pjol/THASSA/backend/internal/auth"
	"github.com/pjol/THASSA/backend/internal/chain"
	"github.com/pjol/THASSA/backend/internal/marketsvc"
	"github.com/pjol/THASSA/backend/internal/respond"
	"github.com/pjol/THASSA/backend/internal/sources"
	"github.com/pjol/THASSA/backend/internal/store"
	"github.com/pjol/THASSA/backend/internal/structs"
)

// handleListSources serves the public authoritative-source registry (§6.5b).
func (s *Server) handleListSources(w http.ResponseWriter, r *http.Request) {
	respond.JSON(w, http.StatusOK, map[string]any{
		"categories": s.registry.List(r.URL.Query().Get("category")),
	})
}

// handleSearchMarkets is the typeahead search (trigram + websearch fts).
func (s *Server) handleSearchMarkets(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		respond.Error(w, http.StatusBadRequest, "missing q")
		return
	}
	if len(q) > 200 {
		q = q[:200]
	}
	markets, err := s.db.SearchMarkets(r.Context(), q, parseLimit(r, 10))
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to search markets")
		return
	}
	// Stored generation candidates (from every user's past generations) that
	// nobody has started yet — the client tags these "start market".
	generated, err := s.db.SearchGeneratedCandidates(r.Context(), q, 5)
	if err != nil {
		generated = []structs.GeneratedCandidate{} // best-effort side list
	}
	respond.JSON(w, http.StatusOK, map[string]any{"markets": markets, "generated": generated})
}

type generateRequest struct {
	Query string `json:"query"`
}

// handleGenerateMarkets runs the LLM+MCP generation agent (spec §6.5/§6.5b).
func (s *Server) handleGenerateMarkets(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req generateRequest
	if err := respond.Decode(r, &req); err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid body")
		return
	}
	result, err := s.markets.Generate(r.Context(), id.UserID, req.Query)
	switch {
	case errors.Is(err, marketsvc.ErrEmptyInput), errors.Is(err, marketsvc.ErrTooLong):
		respond.Error(w, http.StatusBadRequest, err.Error())
		return
	case errors.Is(err, marketsvc.ErrFlagged):
		respond.Error(w, http.StatusUnprocessableEntity, err.Error())
		return
	case err != nil:
		respond.Error(w, http.StatusServiceUnavailable, "market generation failed: "+err.Error())
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{
		"candidates":       result.Candidates,
		"existing_markets": result.Existing,
	})
}

// authPayload is the EIP-3009 wire shape shared by orders/settle/send.
type authPayload struct {
	From        string `json:"from"`
	To          string `json:"to"`
	Value       int64  `json:"value"`
	ValidAfter  int64  `json:"valid_after"`
	ValidBefore int64  `json:"valid_before"`
	Nonce       string `json:"nonce"`
	V           uint8  `json:"v"`
	R           string `json:"r"`
	S           string `json:"s"`
}

func (a *authPayload) toAuth() (*chain.Auth3009, error) {
	nonce, err := chain.ParseHash32(a.Nonce)
	if err != nil {
		return nil, errors.New("invalid auth nonce")
	}
	rr, err := chain.ParseHash32(a.R)
	if err != nil {
		return nil, errors.New("invalid auth r")
	}
	ss, err := chain.ParseHash32(a.S)
	if err != nil {
		return nil, errors.New("invalid auth s")
	}
	return &chain.Auth3009{
		From:        common.HexToAddress(a.From),
		To:          common.HexToAddress(a.To),
		Value:       a.Value,
		ValidAfter:  a.ValidAfter,
		ValidBefore: a.ValidBefore,
		Nonce:       nonce,
		V:           a.V,
		R:           rr,
		S:           ss,
	}, nil
}

// orderPayload is the signed-order wire shape (spec §9: no signature fields —
// the auth nonce equals the order's EIP-712 digest).
type orderPayload struct {
	Side            string       `json:"side"` // yes | no
	PriceCents      int          `json:"price_cents"`
	Shares          int64        `json:"shares"`
	MaxCost         int64        `json:"max_cost"`
	AffiliatePostID *string      `json:"affiliate_post_id"` // uuid
	AffiliateID     *string      `json:"affiliate_id"`      // decimal uint256 (alt form)
	Expiry          int64        `json:"expiry"`
	Nonce           int64        `json:"nonce"`
	Auth            *authPayload `json:"auth"`
}

type createMarketRequest struct {
	Title           string       `json:"title"`
	Question        string       `json:"question"`
	SettlementQuery string       `json:"settlement_query"` // structured JSON (§6.5b)
	InitialOrder    orderPayload `json:"initial_order"`
}

// handleCreateMarket creates a market via the relayer: a PENDING row plus the
// creator's opening signed order (marketId = 0 in the digest; the contract
// binds the real id inside createMarket). The initial order must deposit ≥ $1.
func (s *Server) handleCreateMarket(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	if !s.chainReady(w) {
		return
	}
	var req createMarketRequest
	if err := respond.Decode(r, &req); err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid body")
		return
	}
	question := strings.TrimSpace(req.Question)
	if question == "" || len(question) > 300 {
		respond.Error(w, http.StatusBadRequest, "invalid question")
		return
	}
	if len(req.Title) > 80 {
		respond.Error(w, http.StatusBadRequest, "title too long")
		return
	}
	if !marketsvc.ScreenCandidate(req.Title + " " + question + " " + req.SettlementQuery) {
		respond.Error(w, http.StatusUnprocessableEntity, "market rejected by content guardrails")
		return
	}

	// Normalize the structured settlement query: parse what the client sent,
	// then re-bind category/rule/sources authoritatively from the registry
	// (the registry — not the client — decides the disclosed sources).
	parsed := sources.ParseSettlementQuery(req.SettlementQuery)
	if strings.TrimSpace(parsed.Question) == "" {
		respond.Error(w, http.StatusBadRequest, "invalid settlement query")
		return
	}
	sq, sqJSON, err := s.registry.BuildSettlementQuery(parsed.Question, parsed.Category)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to build settlement query")
		return
	}

	// Validate the creator's opening order: ≥ $1 capital.
	if chain.Escrow(req.InitialOrder.Shares, req.InitialOrder.PriceCents, s.chain.Unit) < s.chain.Unit {
		respond.Error(w, http.StatusBadRequest, "initial order must deposit at least $1")
		return
	}
	order, authp, orderErr := s.validateOrder(r, id, req.InitialOrder, big.NewInt(0))
	if orderErr != "" {
		respond.Error(w, http.StatusBadRequest, orderErr)
		return
	}

	srcRefs := toStructRefs(sq.Sources)
	// Expiration default: unsettled markets auto-resolve 50/50 at expiry.
	// Sports questions are game-bound (short horizon); everything else gets a
	// month before the 50/50 backstop kicks in.
	expiresAt := time.Now().AddDate(0, 0, 30)
	if sq.Category == "sports" {
		expiresAt = time.Now().AddDate(0, 0, 7)
	}
	marketID, err := s.db.CreateMarket(r.Context(), store.CreateMarketParams{
		CreatorID:       id.UserID,
		Title:           req.Title,
		Question:        question,
		SettlementQuery: sqJSON,
		Category:        sq.Category,
		Rule:            sq.Rule,
		Sources:         srcRefs,
		ExpiresAt:       &expiresAt,
	})
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to create market")
		return
	}
	// If this market came from a stored generation candidate, stamp it as
	// started so search stops suggesting it (best-effort, matched by question).
	s.db.MarkGeneratedCandidateStarted(r.Context(), question, marketID)

	created, err := s.insertOrder(r, id, marketID, req.InitialOrder, order, authp, true)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to queue initial order")
		return
	}
	market, err := s.db.GetMarket(r.Context(), id.UserID, marketID)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to load market")
		return
	}
	respond.JSON(w, http.StatusCreated, map[string]any{
		"market": market, // status PENDING → OPEN when MarketCreated lands
		"order":  created,
	})
}

// handleGetMarket returns the detail incl. the PUBLIC settlement query with
// its parsed sources + rule.
func (s *Server) handleGetMarket(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	marketID, err := uuid.Parse(chiParam(r, "id"))
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid market id")
		return
	}
	market, err := s.db.GetMarket(r.Context(), id.UserID, marketID)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to load market")
		return
	}
	if market == nil {
		respond.Error(w, http.StatusNotFound, "market not found")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"market": market})
}

// handleMarketBook returns the aggregated order-book snapshot + recent trades.
func (s *Server) handleMarketBook(w http.ResponseWriter, r *http.Request) {
	marketID, err := uuid.Parse(chiParam(r, "id"))
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid market id")
		return
	}
	book, err := s.db.MarketBook(r.Context(), marketID)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to load book")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"book": book})
}

// handleMarketPosts returns the top posts referencing a market.
func (s *Server) handleMarketPosts(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	marketID, err := uuid.Parse(chiParam(r, "id"))
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid market id")
		return
	}
	posts, err := s.db.MarketTopPosts(r.Context(), id.UserID, marketID, parseLimit(r, 12))
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to load posts")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"posts": posts})
}

// handleMarketComments / handleCreateMarketComment: comments attach to
// markets exactly like posts (shared comments table, §6.2 check constraint).
func (s *Server) handleMarketComments(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	marketID, err := uuid.Parse(chiParam(r, "id"))
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid market id")
		return
	}
	opts, ok := feedOpts(w, r, 50)
	if !ok {
		return
	}
	comments, next, err := s.db.MarketComments(r.Context(), id.UserID, marketID, opts)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to load comments")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"comments": comments, "next_cursor": next})
}

func (s *Server) handleCreateMarketComment(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	marketID, err := uuid.Parse(chiParam(r, "id"))
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid market id")
		return
	}
	if m, err := s.db.MarketSummaryByID(r.Context(), marketID); err != nil || m == nil {
		respond.Error(w, http.StatusNotFound, "market not found")
		return
	}
	s.createComment(w, r, id.UserID, nil, &marketID)
}

type settleRequest struct {
	Auth authPayload `json:"auth"`
}

// handleSettleMarket queues settlement: the caller signs a 5¢ EIP-3009 auth
// (random nonce, recipient = markets contract) which the settlement runner
// relays via settleMarketWithAuth(marketId, payer, auth).
func (s *Server) handleSettleMarket(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	if !s.chainReady(w) {
		return
	}
	marketID, err := uuid.Parse(chiParam(r, "id"))
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid market id")
		return
	}
	chainID, status, err := s.db.MarketChainID(r.Context(), marketID)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to load market")
		return
	}
	if status == "" {
		respond.Error(w, http.StatusNotFound, "market not found")
		return
	}
	if chainID == nil || (status != "OPEN" && status != "MATCHED") {
		respond.Error(w, http.StatusConflict, "market is not eligible for settlement")
		return
	}
	var req settleRequest
	if err := respond.Decode(r, &req); err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid body")
		return
	}
	authv, err := req.Auth.toAuth()
	if err != nil {
		respond.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	if id.Wallet == "" {
		respond.Error(w, http.StatusBadRequest, "no wallet linked to this account")
		return
	}
	// §8.1 + gate: the fee auth must come from the token user's wallet and
	// pay the markets contract at least the 5¢ settlement fee.
	if err := s.gate.CheckAuth(authv, chain.PurposeSettlement, common.HexToAddress(id.Wallet), common.Address{}, time.Now()); err != nil {
		respond.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	if authv.Value < chain.SettlementFee(s.chain.Unit) {
		respond.Error(w, http.StatusBadRequest, "auth must cover the 5 cent settlement fee")
		return
	}
	ok, err := s.db.RequestSettlement(r.Context(), marketID, id.UserID, authv)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to request settlement")
		return
	}
	if !ok {
		respond.Error(w, http.StatusConflict, "market is not eligible for settlement")
		return
	}
	respond.JSON(w, http.StatusAccepted, map[string]any{"ok": true, "market_id": marketID})
}

// handleRedeemMarket queues a relayed redeem (winner claim) for a SETTLED
// market the caller holds a position in.
func (s *Server) handleRedeemMarket(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	if !s.chainReady(w) {
		return
	}
	marketID, err := uuid.Parse(chiParam(r, "id"))
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid market id")
		return
	}
	chainID, status, err := s.db.MarketChainID(r.Context(), marketID)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to load market")
		return
	}
	if status == "" || chainID == nil {
		respond.Error(w, http.StatusNotFound, "market not found")
		return
	}
	if status != "SETTLED" && status != "VOID" {
		respond.Error(w, http.StatusConflict, "market is not settled")
		return
	}
	// §8.1: only positions of the token user count.
	var holds bool
	if err := s.pool.QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM positions WHERE market_id=$1 AND user_id=$2 AND shares > 0)`,
		marketID, id.UserID).Scan(&holds); err != nil || !holds {
		respond.Error(w, http.StatusConflict, "no position to redeem")
		return
	}
	jobID, err := s.db.InsertRelayerJob(r.Context(), id.UserID, "redeem", map[string]any{
		"market_id":       marketID,
		"chain_market_id": *chainID,
	})
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to queue redeem")
		return
	}
	respond.JSON(w, http.StatusAccepted, map[string]any{"job_id": jobID, "status": "queued"})
}

// chainReady 503s money endpoints when chain services are not configured.
func (s *Server) chainReady(w http.ResponseWriter) bool {
	if s.chain == nil || s.gate == nil {
		respond.Error(w, http.StatusServiceUnavailable, "chain services not configured")
		return false
	}
	return true
}

func toStructRefs(in []sources.Source) []structs.SourceRef {
	out := make([]structs.SourceRef, 0, len(in))
	for _, src := range in {
		out = append(out, structs.SourceRef{ID: src.ID, Name: src.Name, URL: src.URL})
	}
	return out
}
