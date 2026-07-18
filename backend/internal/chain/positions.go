package chain

// Pure position/PnL math used by the indexer (mirrored in SQL for bulk
// settlement) and unit-tested without a database.

import "math"

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

// swingThreshold is the fractional position-magnitude change that fires a
// position.swing notification (spec §7d.4: >50% in either direction).
const swingThreshold = 0.50

// PositionSwing reports whether a position's magnitude moved by more than 50%
// relative to its previous value, and the signed percentage of the move
// (positive = grew, negative = shrank), rounded to a whole percent. A swing is
// only meaningful when prev > 0 (a position opening from zero is not a "swing").
func PositionSwing(prevShares, newShares int64) (pct int, swung bool) {
	if prevShares <= 0 {
		return 0, false
	}
	delta := float64(newShares - prevShares)
	frac := delta / float64(prevShares)
	pct = int(math.Round(frac * 100))
	return pct, math.Abs(frac) > swingThreshold
}

// LargeEntry reports whether an entry of the given notional size is "large" for
// a follower — strictly more than 2× the follower's running average entry size
// across everyone they follow (spec §7d.4). Requires count > 0.
func LargeEntry(size, followingNotionalSum, followingEntryCount int64) bool {
	if followingEntryCount <= 0 {
		return false
	}
	avg := float64(followingNotionalSum) / float64(followingEntryCount)
	return float64(size) > 2*avg
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
