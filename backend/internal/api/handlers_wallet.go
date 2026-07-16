package api

import (
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"

	"github.com/pjol/THASSA/backend/internal/auth"
	"github.com/pjol/THASSA/backend/internal/chain"
	"github.com/pjol/THASSA/backend/internal/onramp"
	"github.com/pjol/THASSA/backend/internal/respond"
)

// handleGetWallet returns the payment-token balance, address, and the user's
// next EIP-712 maker nonce ("order_nonce": max of the chain's nonces view and
// the platform's queued orders, so signing stays correct while orders are in
// flight).
func (s *Server) handleGetWallet(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	if id.Wallet == "" {
		respond.JSON(w, http.StatusOK, map[string]any{"wallet": map[string]any{
			"address": nil, "balance": 0, "decimals": 6, "order_nonce": 0,
		}})
		return
	}
	balance := int64(0)
	decimals := 6
	orderNonce := int64(0)
	if s.chain != nil {
		decimals = s.chain.Decimals
		if b, err := s.chain.BalanceOf(r.Context(), common.HexToAddress(id.Wallet)); err == nil {
			balance = b.Int64()
		}
		if n, err := s.chain.MakerNonce(r.Context(), common.HexToAddress(id.Wallet)); err == nil {
			orderNonce = n
		}
	}
	if n, err := s.db.NextOrderNonce(r.Context(), id.Wallet); err == nil && n > orderNonce {
		orderNonce = n
	}
	respond.JSON(w, http.StatusOK, map[string]any{"wallet": map[string]any{
		"address":     id.Wallet,
		"balance":     balance,
		"decimals":    decimals,
		"order_nonce": orderNonce,
	}})
}

type walletSendRequest struct {
	Recipient string      `json:"recipient"`
	Amount    int64       `json:"amount"` // token base units
	Auth      authPayload `json:"auth"`
}

// handleWalletSend relays an EIP-3009 transfer of the payment token ONLY:
// the auth must come from the caller's wallet and pay exactly the declared
// recipient (gate-enforced again at relay time).
func (s *Server) handleWalletSend(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	if !s.chainReady(w) {
		return
	}
	var req walletSendRequest
	if err := respond.Decode(r, &req); err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid body")
		return
	}
	if id.Wallet == "" {
		respond.Error(w, http.StatusBadRequest, "no wallet linked to this account")
		return
	}
	if !common.IsHexAddress(req.Recipient) {
		respond.Error(w, http.StatusBadRequest, "invalid recipient")
		return
	}
	if req.Amount <= 0 {
		respond.Error(w, http.StatusBadRequest, "invalid amount")
		return
	}
	authv, err := req.Auth.toAuth()
	if err != nil {
		respond.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	if !strings.EqualFold(authv.From.Hex(), id.Wallet) {
		respond.Error(w, http.StatusBadRequest, "auth must be signed by your wallet")
		return
	}
	if authv.Value != req.Amount {
		respond.Error(w, http.StatusBadRequest, "auth value must equal amount")
		return
	}
	recipient := common.HexToAddress(req.Recipient)
	if err := s.gate.CheckAuth(authv, chain.PurposeWalletSend, common.HexToAddress(id.Wallet), recipient, time.Now()); err != nil {
		respond.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	jobID, err := s.db.InsertRelayerJob(r.Context(), id.UserID, "send", map[string]any{
		"recipient": recipient.Hex(),
		"amount":    req.Amount,
		"auth":      authv,
	})
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to queue send")
		return
	}
	respond.JSON(w, http.StatusAccepted, map[string]any{"job_id": jobID, "status": "queued"})
}

// handleWalletActivity lists indexed payment-token transfers touching the
// caller's wallet.
func (s *Server) handleWalletActivity(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	if id.Wallet == "" {
		respond.JSON(w, http.StatusOK, map[string]any{"activity": []any{}})
		return
	}
	activity, err := s.db.WalletActivity(r.Context(), id.Wallet, parseLimit(r, 50))
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to load activity")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"activity": activity})
}

type onrampRequest struct {
	Kind        string `json:"kind"` // fiat | crypto
	AmountCents int64  `json:"amount_cents,omitempty"`
	FromChainID int64  `json:"from_chain_id,omitempty"`
	FromToken   string `json:"from_token,omitempty"`
	Amount      int64  `json:"amount,omitempty"` // source-token base units (crypto)
}

// handleCreateOnrampSession opens a funding session: fiat → Stripe hosted
// checkout URL; crypto → home-chain deposit coordinates + optional bridge
// route quote. Providers are fully implemented and env-gated (clear errors
// when unconfigured).
func (s *Server) handleCreateOnrampSession(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req onrampRequest
	if err := respond.Decode(r, &req); err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid body")
		return
	}
	switch req.Kind {
	case "fiat":
		session, err := s.onramp.CreateFiatSession(r.Context(), id.UserID, id.Wallet, req.AmountCents)
		if err != nil {
			s.onrampError(w, err)
			return
		}
		respond.JSON(w, http.StatusCreated, map[string]any{"session": session})
	case "crypto":
		session, err := s.onramp.CreateCryptoSession(r.Context(), id.UserID, id.Wallet, req.FromChainID, req.FromToken, req.Amount)
		if err != nil {
			s.onrampError(w, err)
			return
		}
		respond.JSON(w, http.StatusCreated, map[string]any{"session": session})
	default:
		respond.Error(w, http.StatusBadRequest, "kind must be fiat or crypto")
	}
}

func (s *Server) onrampError(w http.ResponseWriter, err error) {
	if errors.Is(err, onramp.ErrNotConfigured) {
		respond.Error(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	respond.Error(w, http.StatusBadRequest, err.Error())
}

// handleStripeWebhook completes fiat onramp sessions (signature-verified).
func (s *Server) handleStripeWebhook(w http.ResponseWriter, r *http.Request) {
	payload, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid payload")
		return
	}
	if err := s.onramp.HandleStripeWebhook(r.Context(), payload, r.Header.Get("Stripe-Signature")); err != nil {
		respond.Error(w, http.StatusBadRequest, "webhook rejected")
		return
	}
	w.WriteHeader(http.StatusOK)
}
