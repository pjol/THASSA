package chain

import (
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/common/math"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"
)

var testOrder = Order{
	MarketID:        big.NewInt(7),
	Side:            1, // NO
	Price:           37,
	Shares:          125,
	MaxCost:         50_000_000,
	AffiliatePostID: big.NewInt(99),
	Expiry:          1790000000,
	Nonce:           3,
	Maker:           common.HexToAddress("0x1111111111111111111111111111111111111111"),
}

const (
	testChainID  = int64(31337)
	testContract = "0x2222222222222222222222222222222222222222"
)

// TestOrderDigestAgainstGethTypedData cross-checks the hand-rolled digest
// builder against go-ethereum's independent EIP-712 implementation.
func TestOrderDigestAgainstGethTypedData(t *testing.T) {
	td := apitypes.TypedData{
		Types: apitypes.Types{
			"EIP712Domain": []apitypes.Type{
				{Name: "name", Type: "string"},
				{Name: "version", Type: "string"},
				{Name: "chainId", Type: "uint256"},
				{Name: "verifyingContract", Type: "address"},
			},
			"Order": []apitypes.Type{
				{Name: "marketId", Type: "uint256"},
				{Name: "side", Type: "uint8"},
				{Name: "price", Type: "uint8"},
				{Name: "shares", Type: "uint80"},
				{Name: "maxCost", Type: "uint256"},
				{Name: "affiliatePostId", Type: "uint256"},
				{Name: "expiry", Type: "uint64"},
				{Name: "nonce", Type: "uint256"},
				{Name: "maker", Type: "address"},
			},
		},
		PrimaryType: "Order",
		Domain: apitypes.TypedDataDomain{
			Name:              DomainName,
			Version:           DomainVersion,
			ChainId:           math.NewHexOrDecimal256(testChainID),
			VerifyingContract: testContract,
		},
		Message: apitypes.TypedDataMessage{
			"marketId":        (*math.HexOrDecimal256)(testOrder.MarketID),
			"side":            math.NewHexOrDecimal256(int64(testOrder.Side)),
			"price":           math.NewHexOrDecimal256(int64(testOrder.Price)),
			"shares":          math.NewHexOrDecimal256(testOrder.Shares),
			"maxCost":         math.NewHexOrDecimal256(testOrder.MaxCost),
			"affiliatePostId": (*math.HexOrDecimal256)(testOrder.AffiliatePostID),
			"expiry":          math.NewHexOrDecimal256(testOrder.Expiry),
			"nonce":           math.NewHexOrDecimal256(testOrder.Nonce),
			"maker":           testOrder.Maker.Hex(),
		},
	}
	hash, _, err := apitypes.TypedDataAndHash(td)
	if err != nil {
		t.Fatalf("geth typed data: %v", err)
	}
	got := OrderDigest(testOrder, testChainID, common.HexToAddress(testContract))
	if got != common.BytesToHash(hash) {
		t.Fatalf("digest mismatch:\n  ours: %s\n  geth: %s", got, hexutil.Encode(hash))
	}
}

// TestOrderDigestPinnedVector pins the digest for the canonical test order so
// contracts/web/mobile can assert the identical value against their own
// EIP-712 implementations.
func TestOrderDigestPinnedVector(t *testing.T) {
	const want = "0x52255c7a9a63ea0c39d559c0de73ffeeb86a7d4016832f6dff50665b4aeef493"
	got := OrderDigest(testOrder, testChainID, common.HexToAddress(testContract)).Hex()
	if got != want {
		t.Fatalf("pinned digest changed:\n  got  %s\n  want %s", got, want)
	}
}

// TestOrderDigestSensitivity: changing any field must change the digest.
func TestOrderDigestSensitivity(t *testing.T) {
	contract := common.HexToAddress(testContract)
	base := OrderDigest(testOrder, testChainID, contract)

	mutations := map[string]Order{}
	o := testOrder
	o.MarketID = big.NewInt(8)
	mutations["marketId"] = o
	o = testOrder
	o.Side = 0
	mutations["side"] = o
	o = testOrder
	o.Price = 38
	mutations["price"] = o
	o = testOrder
	o.Shares = 126
	mutations["shares"] = o
	o = testOrder
	o.MaxCost = 1
	mutations["maxCost"] = o
	o = testOrder
	o.Nonce = 4
	mutations["nonce"] = o
	o = testOrder
	o.Maker = common.HexToAddress("0x3333333333333333333333333333333333333333")
	mutations["maker"] = o

	for field, m := range mutations {
		if OrderDigest(m, testChainID, contract) == base {
			t.Fatalf("digest not sensitive to %s", field)
		}
	}
	if OrderDigest(testOrder, testChainID+1, contract) == base {
		t.Fatal("digest not sensitive to chain id")
	}
}

// TestRecoverOrderSigner signs the digest with a known key and recovers it.
func TestRecoverOrderSigner(t *testing.T) {
	key, err := crypto.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	maker := crypto.PubkeyToAddress(key.PublicKey)
	order := testOrder
	order.Maker = maker
	contract := common.HexToAddress(testContract)

	digest := OrderDigest(order, testChainID, contract)
	sig, err := crypto.Sign(digest.Bytes(), key)
	if err != nil {
		t.Fatal(err)
	}
	// Wallets emit v = 27/28; exercise the normalization path.
	sig[64] += 27
	got, err := RecoverOrderSigner(order, testChainID, contract, hexutil.Encode(sig))
	if err != nil {
		t.Fatalf("recover: %v", err)
	}
	if got != maker {
		t.Fatalf("recovered %s, want %s", got, maker)
	}
}
