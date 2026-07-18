package chain

import "math/big"

// Fee constants (spec §9): takerFeeBps applied to shares × p × (100−p)/10000
// dollars; settlement trigger $0.05; withdrawal flat $0.10.
const (
	TakerFeeBps         = 700
	CreatorFeeShareBps  = 1000
	AffiliateFeeShareBps = 1000
)

// TokenUnit returns 10^decimals (the $1 payout per share).
func TokenUnit(decimals int) int64 {
	unit := int64(1)
	for i := 0; i < decimals; i++ {
		unit *= 10
	}
	return unit
}

// TakerFee mirrors the contract's taker fee for a match executed at
// priceCents: fee = ceil(takerFeeBps × shares × p × (100−p) / 10000² ) dollars,
// returned in token units (rounded UP, like the contract).
func TakerFee(shares int64, priceCents int, tokenUnit int64) int64 {
	if shares <= 0 || priceCents < 1 || priceCents > 99 {
		return 0
	}
	num := new(big.Int).SetInt64(TakerFeeBps)
	num.Mul(num, big.NewInt(shares))
	num.Mul(num, big.NewInt(int64(priceCents)))
	num.Mul(num, big.NewInt(int64(100-priceCents)))
	num.Mul(num, big.NewInt(tokenUnit))
	den := big.NewInt(100_000_000) // 10000 (bps) × 10000 (p×(100−p) scale)
	// ceil division
	rem := new(big.Int)
	q, rem := num.QuoRem(num, den, rem)
	if rem.Sign() > 0 {
		q.Add(q, big.NewInt(1))
	}
	return q.Int64()
}

// Escrow is the maker-side deposit for a buy of `shares` at limit priceCents:
// shares × p/100 dollars in token units.
func Escrow(shares int64, priceCents int, tokenUnit int64) int64 {
	n := new(big.Int).SetInt64(shares)
	n.Mul(n, big.NewInt(int64(priceCents)))
	n.Mul(n, big.NewInt(tokenUnit))
	n.Div(n, big.NewInt(100))
	return n.Int64()
}

// EstimateMaxCost is the maximum token amount an order can consume: the
// escrow at the limit price plus taker-fee headroom if the whole order crosses
// at the limit price. Used to validate the signed order's maxCost and the
// EIP-3009 auth value.
func EstimateMaxCost(shares int64, priceCents int, tokenUnit int64) int64 {
	return Escrow(shares, priceCents, tokenUnit) + TakerFee(shares, priceCents, tokenUnit)
}

// SettlementFee is the $0.05 settle-trigger fee in token units.
func SettlementFee(tokenUnit int64) int64 { return tokenUnit / 20 }
