// Package onramp funds user wallets (spec §6.3 wallet): fiat via a Stripe
// checkout rail, crypto via direct payment-token deposits on the home chain
// (unique deposit references, credited by the chain watcher) and cross-chain
// routes quoted through a LI.FI-style bridge-aggregator HTTP API.
//
// All integrations are complete code paths, env-gated: when a credential is
// absent the endpoint returns an explicit configuration error, never mock
// data.
package onramp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/google/uuid"
	"github.com/stripe/stripe-go/v79"
	stripesession "github.com/stripe/stripe-go/v79/checkout/session"
	"github.com/stripe/stripe-go/v79/webhook"

	"github.com/pjol/THASSA/backend/internal/config"
	"github.com/pjol/THASSA/backend/internal/store"
)

// Service implements both onramp kinds.
type Service struct {
	db *store.Store

	stripeKey     string
	webhookSecret string
	returnURL     string

	bridgeURL string
	bridgeKey string
	http      *http.Client

	homeChainID  int64
	paymentToken string
}

func New(db *store.Store, cfg *config.Config) *Service {
	if cfg.StripeSecretKey != "" {
		stripe.Key = cfg.StripeSecretKey
	}
	return &Service{
		db:            db,
		stripeKey:     cfg.StripeSecretKey,
		webhookSecret: cfg.StripeWebhookSecret,
		returnURL:     cfg.OnrampReturnURL,
		bridgeURL:     cfg.BridgeAPIURL,
		bridgeKey:     cfg.BridgeAPIKey,
		http:          &http.Client{Timeout: 20 * time.Second},
		homeChainID:   cfg.ChainID,
		paymentToken:  cfg.PaymentTokenAddress,
	}
}

// ErrNotConfigured is returned when a provider credential is absent.
var ErrNotConfigured = errors.New("onramp provider not configured")

// FiatSession is the fiat response payload (hosted checkout URL).
type FiatSession struct {
	SessionID   uuid.UUID `json:"session_id"`
	Provider    string    `json:"provider"`
	CheckoutURL string    `json:"checkout_url"`
	AmountCents int64     `json:"amount_cents"`
}

// CreateFiatSession opens a real Stripe Checkout session that funds the
// user's wallet, recording it in onramp_sessions (completed by the webhook).
func (s *Service) CreateFiatSession(ctx context.Context, userID uuid.UUID, wallet string, amountCents int64) (*FiatSession, error) {
	if s.stripeKey == "" {
		return nil, fmt.Errorf("%w: STRIPE_SECRET_KEY is not set", ErrNotConfigured)
	}
	if amountCents < 100 {
		return nil, errors.New("minimum fiat onramp is $1.00")
	}
	if wallet == "" {
		return nil, errors.New("no wallet linked to this account")
	}
	sessionID, err := s.db.CreateOnrampSession(ctx, userID, "stripe", "fiat", map[string]any{
		"amount_cents": amountCents,
		"wallet":       wallet,
	})
	if err != nil {
		return nil, err
	}
	params := &stripe.CheckoutSessionParams{
		Mode: stripe.String(string(stripe.CheckoutSessionModePayment)),
		LineItems: []*stripe.CheckoutSessionLineItemParams{{
			PriceData: &stripe.CheckoutSessionLineItemPriceDataParams{
				Currency:   stripe.String("usd"),
				UnitAmount: stripe.Int64(amountCents),
				ProductData: &stripe.CheckoutSessionLineItemPriceDataProductDataParams{
					Name: stripe.String("Thassa wallet funding"),
				},
			},
			Quantity: stripe.Int64(1),
		}},
		SuccessURL: stripe.String(s.returnURL + "?onramp=success&session=" + sessionID.String()),
		CancelURL:  stripe.String(s.returnURL + "?onramp=cancel&session=" + sessionID.String()),
	}
	params.Params.Metadata = map[string]string{
		"onramp_session_id": sessionID.String(),
		"user_id":           userID.String(),
		"wallet":            wallet,
	}
	cs, err := stripesession.New(params)
	if err != nil {
		_ = s.db.UpdateOnrampSession(ctx, sessionID, "failed", map[string]any{"error": err.Error()})
		return nil, fmt.Errorf("stripe: %w", err)
	}
	_ = s.db.UpdateOnrampSession(ctx, sessionID, "pending", map[string]any{
		"stripe_session_id": cs.ID,
	})
	return &FiatSession{SessionID: sessionID, Provider: "stripe", CheckoutURL: cs.URL, AmountCents: amountCents}, nil
}

// HandleStripeWebhook verifies the signature and completes fiat sessions on
// checkout.session.completed.
func (s *Service) HandleStripeWebhook(ctx context.Context, payload []byte, sigHeader string) error {
	if s.webhookSecret == "" {
		return fmt.Errorf("%w: STRIPE_WEBHOOK_SECRET is not set", ErrNotConfigured)
	}
	event, err := webhook.ConstructEvent(payload, sigHeader, s.webhookSecret)
	if err != nil {
		return fmt.Errorf("webhook signature: %w", err)
	}
	switch event.Type {
	case "checkout.session.completed", "checkout.session.async_payment_succeeded":
		var cs stripe.CheckoutSession
		if err := json.Unmarshal(event.Data.Raw, &cs); err != nil {
			return err
		}
		idStr := cs.Metadata["onramp_session_id"]
		id, err := uuid.Parse(idStr)
		if err != nil {
			return nil // not one of ours
		}
		return s.db.UpdateOnrampSession(ctx, id, "completed", map[string]any{
			"stripe_payment_status": string(cs.PaymentStatus),
		})
	case "checkout.session.expired", "checkout.session.async_payment_failed":
		var cs stripe.CheckoutSession
		if err := json.Unmarshal(event.Data.Raw, &cs); err != nil {
			return err
		}
		if id, err := uuid.Parse(cs.Metadata["onramp_session_id"]); err == nil {
			return s.db.UpdateOnrampSession(ctx, id, "failed", nil)
		}
	}
	return nil
}

// CryptoSession is the crypto response payload: a home-chain deposit target
// plus (for cross-chain funding) a live bridge route quote.
type CryptoSession struct {
	SessionID      uuid.UUID       `json:"session_id"`
	Provider       string          `json:"provider"`
	DepositAddress string          `json:"deposit_address"`
	DepositChainID int64           `json:"deposit_chain_id"`
	TokenAddress   string          `json:"token_address"`
	Reference      string          `json:"reference"`
	SupportedChains []BridgeChain  `json:"supported_chains,omitempty"`
	Quote          json.RawMessage `json:"quote,omitempty"`
}

// BridgeChain is one chain the aggregator can route from.
type BridgeChain struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
	Key  string `json:"key"`
}

// CreateCryptoSession returns the user's home-chain deposit coordinates
// (watched by the indexer, which credits arrivals against the session) and —
// when a source chain is supplied — a real bridge-aggregator route quote.
func (s *Service) CreateCryptoSession(ctx context.Context, userID uuid.UUID, wallet string, fromChainID int64, fromToken string, amount int64) (*CryptoSession, error) {
	if wallet == "" {
		return nil, errors.New("no wallet linked to this account")
	}
	reference := uuid.NewString()
	sessionID, err := s.db.CreateOnrampSession(ctx, userID, "bridge", "crypto", map[string]any{
		"wallet":     wallet,
		"reference":  reference,
		"from_chain": fromChainID,
		"amount":     amount,
	})
	if err != nil {
		return nil, err
	}
	out := &CryptoSession{
		SessionID:      sessionID,
		Provider:       "bridge",
		DepositAddress: wallet,
		DepositChainID: s.homeChainID,
		TokenAddress:   s.paymentToken,
		Reference:      reference,
	}
	// Supported source chains from the aggregator (best-effort).
	if chains, err := s.bridgeChains(ctx); err == nil {
		out.SupportedChains = chains
	}
	// Cross-chain: fetch a live route quote.
	if fromChainID != 0 && fromChainID != s.homeChainID {
		quote, err := s.bridgeQuote(ctx, fromChainID, fromToken, wallet, amount)
		if err != nil {
			return nil, err
		}
		out.Quote = quote
	}
	return out, nil
}

func (s *Service) bridgeChains(ctx context.Context) ([]BridgeChain, error) {
	if s.bridgeURL == "" {
		return nil, fmt.Errorf("%w: BRIDGE_API_URL is not set", ErrNotConfigured)
	}
	body, err := s.bridgeGET(ctx, "/v1/chains", nil)
	if err != nil {
		return nil, err
	}
	var res struct {
		Chains []struct {
			ID   int64  `json:"id"`
			Name string `json:"name"`
			Key  string `json:"key"`
		} `json:"chains"`
	}
	if err := json.Unmarshal(body, &res); err != nil {
		return nil, err
	}
	out := make([]BridgeChain, 0, len(res.Chains))
	for _, c := range res.Chains {
		out = append(out, BridgeChain{ID: c.ID, Name: c.Name, Key: c.Key})
	}
	return out, nil
}

// bridgeQuote asks the aggregator (LI.FI-style /v1/quote) for a route from
// (fromChain, fromToken) to the payment token on the home chain.
func (s *Service) bridgeQuote(ctx context.Context, fromChainID int64, fromToken, toAddress string, amount int64) (json.RawMessage, error) {
	if s.bridgeURL == "" {
		return nil, fmt.Errorf("%w: BRIDGE_API_URL is not set for cross-chain funding", ErrNotConfigured)
	}
	if fromToken == "" || amount <= 0 {
		return nil, errors.New("cross-chain quote requires from_token and amount")
	}
	q := url.Values{}
	q.Set("fromChain", fmt.Sprint(fromChainID))
	q.Set("toChain", fmt.Sprint(s.homeChainID))
	q.Set("fromToken", fromToken)
	q.Set("toToken", s.paymentToken)
	q.Set("fromAmount", fmt.Sprint(amount))
	q.Set("fromAddress", toAddress)
	q.Set("toAddress", toAddress)
	return s.bridgeGET(ctx, "/v1/quote", q)
}

func (s *Service) bridgeGET(ctx context.Context, path string, q url.Values) (json.RawMessage, error) {
	u := s.bridgeURL + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	if s.bridgeKey != "" {
		req.Header.Set("x-lifi-api-key", s.bridgeKey)
	}
	res, err := s.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("bridge api: %w", err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("bridge api: http %d: %s", res.StatusCode, tail(body))
	}
	return json.RawMessage(body), nil
}

func tail(b []byte) string {
	if len(b) > 200 {
		b = b[:200]
	}
	return string(b)
}
