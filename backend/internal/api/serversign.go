package api

import (
	"fmt"
	"math/big"
	"net/http"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/google/uuid"

	"github.com/pjol/THASSA/backend/internal/auth"
	"github.com/pjol/THASSA/backend/internal/chain"
)

// serverSignOrder completes and signs an UNSIGNED trade-API order on behalf
// of a user who enabled server-side signing (trade API route 2). It fills in
// nonce, expiry, and max cost when omitted, computes the order's EIP-712
// digest, and signs the EIP-3009 ReceiveWithAuthorization through the user's
// delegated Privy wallet. The result lands in p.Auth, after which the request
// flows through the exact same validateOrder gate as a client-signed one.
// Returns a user-facing error string ("" on success).
func (s *Server) serverSignOrder(r *http.Request, id *auth.Identity, p *orderPayload, chainMarketID *big.Int) string {
	ctx := r.Context()
	if id.Wallet == "" {
		return "no wallet linked to this account"
	}
	if p.Side != "yes" && p.Side != "no" {
		return "side must be yes or no"
	}
	if p.PriceCents < 1 || p.PriceCents > 99 {
		return "price must be 1..99 cents"
	}
	if p.Shares <= 0 {
		return "shares must be positive"
	}

	unit := chain.TokenUnit(s.chain.Decimals)
	if p.MaxCost == 0 {
		p.MaxCost = chain.EstimateMaxCost(p.Shares, p.PriceCents, unit)
	}
	if p.Expiry == 0 {
		p.Expiry = time.Now().Add(time.Hour).Unix()
	}
	if p.Nonce == 0 {
		nonce := int64(0)
		if n, err := s.chain.MakerNonce(ctx, common.HexToAddress(id.Wallet)); err == nil {
			nonce = n
		}
		if n, err := s.db.NextOrderNonce(ctx, id.Wallet); err == nil && n > nonce {
			nonce = n
		}
		p.Nonce = nonce
	}

	side := uint8(0)
	if p.Side == "no" {
		side = 1
	}
	affiliate := big.NewInt(0)
	if p.AffiliatePostID != nil && *p.AffiliatePostID != "" {
		if pid, err := uuid.Parse(*p.AffiliatePostID); err == nil {
			affiliate = new(big.Int).SetBytes(pid[:])
		}
	} else if p.AffiliateID != nil && *p.AffiliateID != "" {
		if n, ok := new(big.Int).SetString(*p.AffiliateID, 10); ok {
			affiliate = n
		}
	}

	order := chain.Order{
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
	digest := chain.OrderDigest(order, s.gate.ChainID, s.gate.Markets)

	// Signature carriage (spec §9): the auth nonce IS the order digest, so the
	// one delegated signature commits to both payment and order.
	typed := map[string]any{
		"types": map[string]any{
			"EIP712Domain": []map[string]string{
				{"name": "name", "type": "string"},
				{"name": "version", "type": "string"},
				{"name": "chainId", "type": "uint256"},
				{"name": "verifyingContract", "type": "address"},
			},
			"ReceiveWithAuthorization": []map[string]string{
				{"name": "from", "type": "address"},
				{"name": "to", "type": "address"},
				{"name": "value", "type": "uint256"},
				{"name": "validAfter", "type": "uint256"},
				{"name": "validBefore", "type": "uint256"},
				{"name": "nonce", "type": "bytes32"},
			},
		},
		"primaryType": "ReceiveWithAuthorization",
		"domain": map[string]any{
			"name":              s.cfg.PaymentTokenName,
			"version":           s.cfg.PaymentTokenVersion,
			"chainId":           s.gate.ChainID,
			"verifyingContract": s.gate.Token.Hex(),
		},
		"message": map[string]any{
			"from":        id.Wallet,
			"to":          s.gate.Markets.Hex(),
			"value":       fmt.Sprintf("%d", p.MaxCost),
			"validAfter":  "0",
			"validBefore": fmt.Sprintf("%d", p.Expiry),
			"nonce":       digest.Hex(),
		},
	}

	sig, err := s.privyAPI.SignTypedDataForDID(ctx, id.PrivyDID, typed)
	if err != nil {
		return "server-side signing failed: " + err.Error()
	}
	sigBytes := common.FromHex(sig)
	if len(sigBytes) != 65 {
		return "server-side signing returned a malformed signature"
	}
	v := sigBytes[64]
	if v < 27 {
		v += 27
	}
	p.Auth = &authPayload{
		From:        id.Wallet,
		To:          s.gate.Markets.Hex(),
		Value:       p.MaxCost,
		ValidAfter:  0,
		ValidBefore: p.Expiry,
		Nonce:       digest.Hex(),
		V:           v,
		R:           common.BytesToHash(sigBytes[:32]).Hex(),
		S:           common.BytesToHash(sigBytes[32:64]).Hex(),
	}
	return ""
}
