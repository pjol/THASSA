package api

import (
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/google/uuid"

	"github.com/pjol/THASSA/backend/internal/auth"
	"github.com/pjol/THASSA/backend/internal/chain"
	"github.com/pjol/THASSA/backend/internal/respond"
	"github.com/pjol/THASSA/backend/internal/store"
	"github.com/pjol/THASSA/backend/internal/structs"
)

type createOrderRequest struct {
	MarketID string `json:"market_id"`
	orderPayload
}

// handleCreateOrder accepts an EIP-712 order + EIP-3009 funding auth,
// validates everything server-side (spec §6.6 gate + §9 signature carriage:
// the auth nonce must equal the order digest), enforces per-user rate limits,
// and enqueues the order for the relayer. Response: the order in QUEUED state.
func (s *Server) handleCreateOrder(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	if !s.chainReady(w) {
		return
	}
	var req createOrderRequest
	if err := respond.Decode(r, &req); err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid body")
		return
	}
	marketID, err := uuid.Parse(req.MarketID)
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid market id")
		return
	}
	chainMarketID, status, err := s.db.MarketChainID(r.Context(), marketID)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to load market")
		return
	}
	if status == "" {
		respond.Error(w, http.StatusNotFound, "market not found")
		return
	}
	// SETTLING stays open for trading — orders keep matching while the
	// oracle resolves; only PENDING/SETTLED/VOID block.
	if chainMarketID == nil || (status != "OPEN" && status != "MATCHED" && status != "SETTLING") {
		respond.Error(w, http.StatusConflict, "market is not accepting orders")
		return
	}

	// Trade API route 2: an unsigned order (no eip-3009 auth). Only allowed
	// when the user enabled server-side signing; the platform then completes
	// and signs the order through their delegated Privy wallet, and the
	// request continues through the normal validation gate below.
	if req.Auth == nil {
		if !s.db.ServerSigningEnabled(r.Context(), id.UserID) {
			respond.Error(w, http.StatusForbidden,
				"unsigned order: include a signed eip-3009 auth, or enable server-side signing for your account")
			return
		}
		if errMsg := s.serverSignOrder(r, id, &req.orderPayload, big.NewInt(*chainMarketID)); errMsg != "" {
			respond.Error(w, http.StatusServiceUnavailable, errMsg)
			return
		}
	}

	order, authv, orderErr := s.validateOrder(r, id, req.orderPayload, big.NewInt(*chainMarketID))
	if orderErr != "" {
		respond.Error(w, http.StatusBadRequest, orderErr)
		return
	}
	created, err := s.insertOrder(r, id, marketID, req.orderPayload, order, authv, false)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to queue order")
		return
	}
	respond.JSON(w, http.StatusCreated, map[string]any{"order": created}) // status QUEUED
}

// validateOrder runs every server-side check on an order + auth pair. §8.1:
// the maker is ALWAYS the token user's linked wallet — never client-supplied.
// Returns a user-facing error string ("" on success).
func (s *Server) validateOrder(r *http.Request, id *auth.Identity, p orderPayload, chainMarketID *big.Int) (chain.Order, *chain.Auth3009, string) {
	var order chain.Order
	if id.Wallet == "" {
		return order, nil, "no wallet linked to this account"
	}
	if p.Side != "yes" && p.Side != "no" {
		return order, nil, "side must be yes or no"
	}
	if p.Auth == nil {
		return order, nil, "missing eip-3009 auth"
	}
	authv, err := p.Auth.toAuth()
	if err != nil {
		return order, nil, err.Error()
	}

	// Per-user rate limit (stateless: counted in the DB, spec §6.7).
	if n, err := s.db.CountRecentOrders(r.Context(), id.UserID, time.Minute); err == nil && n >= s.cfg.OrderRatePerMin {
		return order, nil, "order rate limit exceeded, slow down"
	}

	side := uint8(0)
	if p.Side == "no" {
		side = 1
	}
	affiliate := big.NewInt(0)
	var affiliateUUID *uuid.UUID
	switch {
	case p.AffiliatePostID != nil && *p.AffiliatePostID != "":
		pid, err := uuid.Parse(*p.AffiliatePostID)
		if err != nil {
			return order, nil, "invalid affiliate_post_id"
		}
		affiliateUUID = &pid
		affiliate = new(big.Int).SetBytes(pid[:])
	case p.AffiliateID != nil && *p.AffiliateID != "":
		n, ok := new(big.Int).SetString(*p.AffiliateID, 10)
		if !ok || n.Sign() < 0 || n.BitLen() > 128 {
			return order, nil, "invalid affiliate_id"
		}
		affiliate = n
		var pid uuid.UUID
		n.FillBytes(pid[:])
		affiliateUUID = &pid
	}
	if affiliateUUID != nil {
		authorID, _, _, err := s.db.PostAffiliateInfo(r.Context(), *affiliateUUID)
		if err != nil || authorID == uuid.Nil {
			return order, nil, "affiliate post not found"
		}
	}

	order = chain.Order{
		MarketID:        chainMarketID,
		Side:            side,
		Price:           uint8(p.PriceCents),
		Shares:          p.Shares,
		MaxCost:         p.MaxCost,
		AffiliatePostID: affiliate,
		Expiry:          p.Expiry,
		Nonce:           p.Nonce,
		Maker:           common.HexToAddress(id.Wallet),
	}
	if p.PriceCents < 1 || p.PriceCents > 99 {
		return order, nil, "price_cents must be 1..99"
	}
	// The gate enforces bounds, max size, expiry, recipient (= markets
	// contract), sender (= maker), funding sufficiency, and the digest
	// binding (auth nonce == EIP-712 order digest).
	if err := s.gate.CheckOrder(order, authv, s.chain.Unit, time.Now()); err != nil {
		return order, nil, err.Error()
	}
	return order, authv, ""
}

// insertOrder stores the validated order in QUEUED state (Idempotency-Key
// honored; the order digest is a second dedupe layer).
func (s *Server) insertOrder(r *http.Request, id *auth.Identity, marketID uuid.UUID, p orderPayload, order chain.Order, authv *chain.Auth3009, isCreate bool) (*structs.Order, error) {
	digest := chain.OrderDigest(order, s.gate.ChainID, s.gate.Markets).Hex()
	var idem *string
	if k := strings.TrimSpace(r.Header.Get("Idempotency-Key")); k != "" {
		idem = &k
	}
	var affiliateUUID *uuid.UUID
	if order.AffiliatePostID != nil && order.AffiliatePostID.Sign() > 0 {
		var pid uuid.UUID
		order.AffiliatePostID.FillBytes(pid[:])
		affiliateUUID = &pid
	}
	return s.db.InsertQueuedOrder(r.Context(), store.NewOrderParams{
		MarketID:        marketID,
		UserID:          id.UserID,
		Side:            p.Side,
		PriceCents:      p.PriceCents,
		Shares:          p.Shares,
		MakerAddress:    id.Wallet,
		MaxCost:         p.MaxCost,
		Expiry:          p.Expiry,
		Nonce:           p.Nonce,
		OrderDigest:     digest,
		Auth3009:        authv,
		AffiliatePostID: affiliateUUID,
		IsMarketCreate:  isCreate,
		IdempotencyKey:  idem,
	})
}

// handleCancelOrder cancels the caller's order (immediate for QUEUED, signed
// relayed cancel for RESTING/PARTIAL). §8.1: the UPDATE is scoped to
// user_id = token user; foreign ids 404.
func (s *Server) handleCancelOrder(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	orderID, err := uuid.Parse(chiParam(r, "id"))
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid order id")
		return
	}
	order, err := s.db.RequestCancel(r.Context(), id.UserID, orderID)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to cancel order")
		return
	}
	if order == nil {
		respond.Error(w, http.StatusNotFound, "order not found")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"order": order})
}

// handleListOrders lists the caller's orders (?market= filter).
func (s *Server) handleListOrders(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var marketID *uuid.UUID
	if m := r.URL.Query().Get("market"); m != "" {
		mid, err := uuid.Parse(m)
		if err != nil {
			respond.Error(w, http.StatusBadRequest, "invalid market id")
			return
		}
		marketID = &mid
	}
	opts, ok := feedOpts(w, r, 30)
	if !ok {
		return
	}
	orders, next, err := s.db.ListOrders(r.Context(), id.UserID, marketID, opts)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to list orders")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"orders": orders, "next_cursor": next})
}

// handleListPositions lists the caller's positions.
func (s *Server) handleListPositions(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	positions, err := s.db.Positions(r.Context(), id.UserID)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to list positions")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"positions": positions})
}
