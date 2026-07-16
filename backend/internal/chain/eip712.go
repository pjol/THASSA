package chain

import (
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/crypto"
)

// EIP-712 domain pinned by spec §9:
// {name:"ThassaMarkets", version:"1", chainId, verifyingContract}.
const (
	DomainName    = "ThassaMarkets"
	DomainVersion = "1"
)

// Order is the EIP-712 signed order (spec §9 SignedOrder). Money fields are
// int64 token base units; a new-market initial order carries MarketID = 0
// (the contract binds the real id inside createMarket).
type Order struct {
	MarketID        *big.Int
	Side            uint8 // 0 = YES, 1 = NO
	Price           uint8 // cents 1..99
	Shares          int64
	MaxCost         int64
	AffiliatePostID *big.Int // 0 = none; uint256(post uuid)
	Expiry          int64
	Nonce           int64
	Maker           common.Address
}

var (
	eip712DomainTypeHash = crypto.Keccak256Hash(
		[]byte("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"))
	orderTypeHash = crypto.Keccak256Hash(
		[]byte("Order(uint256 marketId,uint8 side,uint8 price,uint80 shares,uint256 maxCost,uint256 affiliatePostId,uint64 expiry,uint256 nonce,address maker)"))
)

// DomainSeparator computes the EIP-712 domain separator.
func DomainSeparator(chainID int64, verifyingContract common.Address) common.Hash {
	return crypto.Keccak256Hash(
		eip712DomainTypeHash.Bytes(),
		crypto.Keccak256([]byte(DomainName)),
		crypto.Keccak256([]byte(DomainVersion)),
		uint256Bytes(big.NewInt(chainID)),
		addressWord(verifyingContract),
	)
}

// OrderStructHash computes hashStruct(order).
func OrderStructHash(o Order) common.Hash {
	return crypto.Keccak256Hash(
		orderTypeHash.Bytes(),
		uint256Bytes(o.MarketID),
		uint256Bytes(big.NewInt(int64(o.Side))),
		uint256Bytes(big.NewInt(int64(o.Price))),
		uint256Bytes(big.NewInt(o.Shares)),
		uint256Bytes(big.NewInt(o.MaxCost)),
		uint256Bytes(o.AffiliatePostID),
		uint256Bytes(big.NewInt(o.Expiry)),
		uint256Bytes(big.NewInt(o.Nonce)),
		addressWord(o.Maker),
	)
}

// OrderDigest is the final \x19\x01-prefixed signing digest.
func OrderDigest(o Order, chainID int64, verifyingContract common.Address) common.Hash {
	return crypto.Keccak256Hash(
		[]byte{0x19, 0x01},
		DomainSeparator(chainID, verifyingContract).Bytes(),
		OrderStructHash(o).Bytes(),
	)
}

// RecoverOrderSigner recovers the signer of a 65-byte (r||s||v) signature over
// the order digest. Accepts v ∈ {0,1,27,28}.
func RecoverOrderSigner(o Order, chainID int64, verifyingContract common.Address, sigHex string) (common.Address, error) {
	sig, err := hexutil.Decode(sigHex)
	if err != nil {
		return common.Address{}, fmt.Errorf("invalid signature hex: %w", err)
	}
	if len(sig) != 65 {
		return common.Address{}, fmt.Errorf("signature must be 65 bytes")
	}
	// Normalize v.
	s := make([]byte, 65)
	copy(s, sig)
	if s[64] >= 27 {
		s[64] -= 27
	}
	if s[64] > 1 {
		return common.Address{}, fmt.Errorf("invalid signature v")
	}
	digest := OrderDigest(o, chainID, verifyingContract)
	pub, err := crypto.SigToPub(digest.Bytes(), s)
	if err != nil {
		return common.Address{}, fmt.Errorf("recover: %w", err)
	}
	return crypto.PubkeyToAddress(*pub), nil
}

func uint256Bytes(n *big.Int) []byte {
	if n == nil {
		n = big.NewInt(0)
	}
	b := make([]byte, 32)
	n.FillBytes(b)
	return b
}

func addressWord(a common.Address) []byte {
	b := make([]byte, 32)
	copy(b[12:], a.Bytes())
	return b
}
