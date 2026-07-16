package chain

// Pure position/PnL math used by the indexer (mirrored in SQL for bulk
// settlement) and unit-tested without a database.

// ApplyFill folds a fill into a position, returning the new share count and
// volume-weighted average price in cents.
func ApplyFill(shares int64, avgPriceCents float64, fillShares int64, fillPriceCents int) (int64, float64) {
	if fillShares <= 0 {
		return shares, avgPriceCents
	}
	total := shares + fillShares
	avg := (avgPriceCents*float64(shares) + float64(fillPriceCents)*float64(fillShares)) / float64(total)
	return total, avg
}

// SettlePnl computes the realized profit/loss (token units) of a position
// when the market settles with the given direction (true = YES). Winners
// receive $1/share having paid avg¢/share; losers forfeit their escrow.
func SettlePnl(side string, direction bool, shares int64, avgPriceCents float64, tokenUnit int64) int64 {
	if shares <= 0 {
		return 0
	}
	won := (side == "yes") == direction
	if won {
		return int64((100 - avgPriceCents) * float64(shares) * float64(tokenUnit) / 100)
	}
	return -int64(avgPriceCents * float64(shares) * float64(tokenUnit) / 100)
}
