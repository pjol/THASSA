package chain

import (
	"encoding/json"
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
)

// Auth3009 is the EIP-3009 receiveWithAuthorization / transferWithAuthorization
// payload as it travels over the API and the relayer queue. From/To are kept
// on the wire so the gate can enforce recipient rules server-side before
// relaying (spec §6.6); the onchain tuple (spec §9) omits from/to because the
// contract fixes them.
type Auth3009 struct {
	From        common.Address `json:"from"`
	To          common.Address `json:"to"`
	Value       int64          `json:"value"` // token base units
	ValidAfter  int64          `json:"valid_after"`
	ValidBefore int64          `json:"valid_before"`
	Nonce       common.Hash    `json:"nonce"` // 32-byte random auth nonce
	V           uint8          `json:"v"`
	R           common.Hash    `json:"r"`
	S           common.Hash    `json:"s"`
}

// UnmarshalAuth parses the stored/wire JSON payload.
func UnmarshalAuth(raw json.RawMessage) (*Auth3009, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, fmt.Errorf("missing eip-3009 auth")
	}
	var a Auth3009
	if err := json.Unmarshal(raw, &a); err != nil {
		return nil, fmt.Errorf("invalid eip-3009 auth: %w", err)
	}
	return &a, nil
}

// ABIAuth is the tuple shape pinned in spec §9 (field names must match the
// ABI component names for go-ethereum packing).
type ABIAuth struct {
	Value       *big.Int `abi:"value"`
	ValidAfter  *big.Int `abi:"validAfter"`
	ValidBefore *big.Int `abi:"validBefore"`
	AuthNonce   [32]byte `abi:"authNonce"`
	V           uint8    `abi:"v"`
	R           [32]byte `abi:"r"`
	S           [32]byte `abi:"s"`
}

// ABI converts to the onchain tuple.
func (a *Auth3009) ABI() ABIAuth {
	return ABIAuth{
		Value:       big.NewInt(a.Value),
		ValidAfter:  big.NewInt(a.ValidAfter),
		ValidBefore: big.NewInt(a.ValidBefore),
		AuthNonce:   a.Nonce,
		V:           a.V,
		R:           a.R,
		S:           a.S,
	}
}

// ABIOrder is the SignedOrder tuple (spec §9) for go-ethereum packing.
type ABIOrder struct {
	MarketId        *big.Int       `abi:"marketId"`
	Side            uint8          `abi:"side"`
	Price           uint8          `abi:"price"`
	Shares          *big.Int       `abi:"shares"`
	MaxCost         *big.Int       `abi:"maxCost"`
	AffiliatePostId *big.Int       `abi:"affiliatePostId"`
	Expiry          uint64         `abi:"expiry"`
	Nonce           *big.Int       `abi:"nonce"`
	Maker           common.Address `abi:"maker"`
}

// ABI converts an Order to the onchain tuple.
func (o Order) ABI() ABIOrder {
	mkt := o.MarketID
	if mkt == nil {
		mkt = big.NewInt(0)
	}
	aff := o.AffiliatePostID
	if aff == nil {
		aff = big.NewInt(0)
	}
	return ABIOrder{
		MarketId:        mkt,
		Side:            o.Side,
		Price:           o.Price,
		Shares:          big.NewInt(o.Shares),
		MaxCost:         big.NewInt(o.MaxCost),
		AffiliatePostId: aff,
		Expiry:          uint64(o.Expiry),
		Nonce:           big.NewInt(o.Nonce),
		Maker:           o.Maker,
	}
}

// ParseHash32 parses a 0x-prefixed 32-byte hex string.
func ParseHash32(s string) (common.Hash, error) {
	b, err := hexutil.Decode(s)
	if err != nil || len(b) != 32 {
		return common.Hash{}, fmt.Errorf("expected 32-byte hex")
	}
	return common.BytesToHash(b), nil
}
