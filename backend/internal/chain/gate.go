package chain

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
)

// Gate is the relayer's gas-sponsorship gate (spec §6.6/§8, non-negotiable):
// the relayer only ever submits transactions to the allowlisted platform
// contracts and only the whitelisted methods; every EIP-3009 auth must pay
// the expected recipient; per-order size caps apply. It never relays
// arbitrary calldata — all calldata is built in-process from typed inputs and
// re-checked here.
type Gate struct {
	Markets common.Address // ThassaMarkets
	Token   common.Address // payment token (EIP-3009)
	Hub     common.Address // Thassa hub
	Relayer common.Address // the relayer's own key
	ChainID int64          // EIP-712 domain chain id

	// MaxOrderCost caps a single signed order's maxCost/auth value (token
	// units). Zero disables the cap (not recommended).
	MaxOrderCost int64

	allowed map[common.Address]map[string]bool
}

// Auth purposes determine the only recipient the gate will accept.
const (
	PurposeOrder      = "order"       // receiveWithAuthorization → markets contract
	PurposeSettlement = "settlement"  // 5¢ fee → markets contract (settleMarketWithAuth pulls it)
	PurposeWalletSend = "wallet_send" // transferWithAuthorization → user-declared recipient
)

var (
	ErrMethodNotAllowed  = errors.New("relayer: contract/method not allowlisted")
	ErrBadAuthRecipient  = errors.New("relayer: eip-3009 auth recipient mismatch")
	ErrBadAuthSender     = errors.New("relayer: eip-3009 auth sender mismatch")
	ErrAuthValue         = errors.New("relayer: eip-3009 auth value out of bounds")
	ErrOrderTooLarge     = errors.New("relayer: order exceeds max size")
	ErrOrderExpired      = errors.New("relayer: order expired")
	ErrAuthWindow        = errors.New("relayer: auth validity window invalid")
	ErrBadPrice          = errors.New("relayer: price out of range")
	ErrBadShares         = errors.New("relayer: shares out of range")
	// ErrDigestMismatch: signature carriage (spec §9) — the EIP-3009 auth's
	// nonce must equal the order's EIP-712 digest, binding the funding
	// authorization to exactly one order.
	ErrDigestMismatch = errors.New("relayer: auth nonce does not equal the order's eip-712 digest")
)

// NewGate builds the gate with the fixed contract/method allowlist. Nothing
// outside this list can ever be signed by the relayer key.
func NewGate(markets, token, hub, relayer common.Address, chainID, maxOrderCost int64) *Gate {
	g := &Gate{Markets: markets, Token: token, Hub: hub, Relayer: relayer, ChainID: chainID, MaxOrderCost: maxOrderCost}
	g.allowed = map[common.Address]map[string]bool{
		markets: {
			"placeOrdersBatch":      true,
			"createMarket":          true,
			"cancelOrder":           true,
			"settleMarketWithAuth":  true,
			"redeem":                true,
			"registerAffiliatePost": true,
		},
		token: {
			"transferWithAuthorization": true,
		},
	}
	return g
}

// AllowCall reports whether the relayer may sign a transaction to `to`
// invoking `method`. Every relayer submission path calls this first.
func (g *Gate) AllowCall(to common.Address, method string) bool {
	m, ok := g.allowed[to]
	return ok && m[method]
}

// CheckAuth validates an EIP-3009 payload against its purpose:
//   - order funding must pay the markets contract, from the order maker;
//   - the settlement fee must pay the relayer (which fronts the contract's
//     transferFrom pull), from the requesting user;
//   - wallet sends must pay exactly the recipient the user declared.
func (g *Gate) CheckAuth(a *Auth3009, purpose string, expectedFrom common.Address, declaredRecipient common.Address, now time.Time) error {
	if a == nil {
		return errors.New("relayer: missing eip-3009 auth")
	}
	var wantTo common.Address
	switch purpose {
	case PurposeOrder, PurposeSettlement:
		wantTo = g.Markets
	case PurposeWalletSend:
		wantTo = declaredRecipient
		if wantTo == (common.Address{}) {
			return ErrBadAuthRecipient
		}
	default:
		return fmt.Errorf("relayer: unknown auth purpose %q", purpose)
	}
	if !strings.EqualFold(a.To.Hex(), wantTo.Hex()) {
		return ErrBadAuthRecipient
	}
	if expectedFrom != (common.Address{}) && !strings.EqualFold(a.From.Hex(), expectedFrom.Hex()) {
		return ErrBadAuthSender
	}
	if a.Value <= 0 || (g.MaxOrderCost > 0 && purpose == PurposeOrder && a.Value > g.MaxOrderCost) {
		return ErrAuthValue
	}
	ts := now.Unix()
	if a.ValidAfter > ts || (a.ValidBefore != 0 && a.ValidBefore <= ts) {
		return ErrAuthWindow
	}
	return nil
}

// CheckOrder validates an order + funding-auth pair before it may enter the
// relayer queue: allowlisted target, bounds, expiry, fully-funding auth, and
// the signature-carriage binding (spec §9): SignedOrder carries no signature
// fields — the EIP-3009 auth's nonce MUST equal the order's EIP-712 digest,
// so the maker's 3009 signature authorizes exactly this order.
func (g *Gate) CheckOrder(o Order, a *Auth3009, tokenUnit int64, now time.Time) error {
	if !g.AllowCall(g.Markets, "placeOrdersBatch") {
		return ErrMethodNotAllowed
	}
	if o.Price < 1 || o.Price > 99 {
		return ErrBadPrice
	}
	if o.Shares <= 0 {
		return ErrBadShares
	}
	if o.Expiry != 0 && o.Expiry <= now.Unix() {
		return ErrOrderExpired
	}
	need := EstimateMaxCost(o.Shares, int(o.Price), tokenUnit)
	if o.MaxCost < need {
		return fmt.Errorf("relayer: maxCost %d below required escrow+fee %d", o.MaxCost, need)
	}
	if g.MaxOrderCost > 0 && o.MaxCost > g.MaxOrderCost {
		return ErrOrderTooLarge
	}
	if err := g.CheckAuth(a, PurposeOrder, o.Maker, common.Address{}, now); err != nil {
		return err
	}
	if a.Value < need {
		return ErrAuthValue
	}
	if a.Nonce != OrderDigest(o, g.ChainID, g.Markets) {
		return ErrDigestMismatch
	}
	return nil
}
