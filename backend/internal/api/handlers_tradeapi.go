package api

import (
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/pjol/THASSA/backend/internal/auth"
	"github.com/pjol/THASSA/backend/internal/respond"
	"github.com/pjol/THASSA/backend/internal/sources"
)

// --- app-side key management (/v1/developer/keys, Privy-authenticated) -------

type createKeyRequest struct {
	Name  string `json:"name"`
	Scope string `json:"scope"` // read | trade
}

// handleCreateAPIKey mints a developer key. The secret is returned ONCE.
func (s *Server) handleCreateAPIKey(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req createKeyRequest
	if err := respond.Decode(r, &req); err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid body")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || len(req.Name) > 60 {
		respond.Error(w, http.StatusBadRequest, "invalid key name")
		return
	}
	if req.Scope != "read" && req.Scope != "trade" {
		respond.Error(w, http.StatusBadRequest, "scope must be read or trade")
		return
	}
	secret, prefix, hash, err := GenerateAPIKey()
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to generate key")
		return
	}
	key, err := s.db.CreateAPIKey(r.Context(), id.UserID, req.Name, prefix, hash, req.Scope)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to create key")
		return
	}
	respond.JSON(w, http.StatusCreated, map[string]any{
		"key":    key,
		"secret": secret, // shown once; only the hash is stored
	})
}

// handleListAPIKeys lists the caller's active keys (no secrets).
func (s *Server) handleListAPIKeys(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	keys, err := s.db.ListAPIKeys(r.Context(), id.UserID)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to list keys")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"keys": keys})
}

// handleRevokeAPIKey revokes the caller's key (§8.1: ownership in the UPDATE).
func (s *Server) handleRevokeAPIKey(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	keyID, err := uuid.Parse(chiParam(r, "id"))
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid key id")
		return
	}
	ok, err := s.db.RevokeAPIKey(r.Context(), id.UserID, keyID)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to revoke key")
		return
	}
	if !ok {
		respond.Error(w, http.StatusNotFound, "key not found")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

// --- public market data (/trade-api/v1, no auth, IP rate-limited) -----------

// handleTradeMarkets lists/searches markets for the public API.
func (s *Server) handleTradeMarkets(w http.ResponseWriter, r *http.Request) {
	if q := strings.TrimSpace(r.URL.Query().Get("q")); q != "" {
		if len(q) > 200 {
			q = q[:200]
		}
		markets, err := s.db.SearchMarkets(r.Context(), q, parseLimit(r, 25))
		if err != nil {
			respond.Error(w, http.StatusInternalServerError, "failed to search markets")
			return
		}
		respond.JSON(w, http.StatusOK, map[string]any{"markets": markets})
		return
	}
	markets, err := s.db.ExploreMarkets(r.Context(), parseLimit(r, 25), 0)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to list markets")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"markets": markets})
}

// handleTradeMarket returns the public market detail (settlement query is
// public by design; viewer-specific fields are computed for the nil user).
func (s *Server) handleTradeMarket(w http.ResponseWriter, r *http.Request) {
	marketID, err := uuid.Parse(chiParam(r, "id"))
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid market id")
		return
	}
	market, err := s.db.GetMarket(r.Context(), uuid.Nil, marketID)
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

// handleTradeMarketTrades returns the public trade tape.
func (s *Server) handleTradeMarketTrades(w http.ResponseWriter, r *http.Request) {
	marketID, err := uuid.Parse(chiParam(r, "id"))
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid market id")
		return
	}
	book, err := s.db.MarketBook(r.Context(), marketID)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to load trades")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"trades": book.Trades})
}

// handleTradeMarketSources discloses the market's parsed resolution sources.
func (s *Server) handleTradeMarketSources(w http.ResponseWriter, r *http.Request) {
	marketID, err := uuid.Parse(chiParam(r, "id"))
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid market id")
		return
	}
	market, err := s.db.GetMarket(r.Context(), uuid.Nil, marketID)
	if err != nil || market == nil {
		respond.Error(w, http.StatusNotFound, "market not found")
		return
	}
	parsed := sources.ParseSettlementQuery(market.SettlementQuery)
	respond.JSON(w, http.StatusOK, map[string]any{
		"category":         market.Category,
		"rule":             market.Rule,
		"sources":          market.Sources,
		"settlement_query": parsed,
	})
}

// --- keyed endpoints (/trade-api/v1, X-Thassa-Key) ---------------------------
// These re-use the exact /v1 handlers: the API-key middleware resolves the
// key to its owner's identity, so every §8.1-gated store call is unchanged.
// POST /trade-api/v1/orders takes the SAME non-custodial payload as
// /v1/orders (order + EIP-3009 auth, authNonce = order digest); the maker is
// forced to the key user's linked wallet inside validateOrder.

// handleTradeFills lists the key user's fills.
func (s *Server) handleTradeFills(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	opts, ok := feedOpts(w, r, 50)
	if !ok {
		return
	}
	fills, next, err := s.db.UserTrades(r.Context(), id.UserID, opts)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to load fills")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"fills": fills, "next_cursor": next})
}
