package chain

import "testing"

func TestApplyFill(t *testing.T) {
	shares, avg := ApplyFill(0, 0, 10, 60)
	if shares != 10 || avg != 60 {
		t.Fatalf("first fill: %d @ %.2f", shares, avg)
	}
	// 10 @ 60 + 30 @ 40 → 40 @ 45.
	shares, avg = ApplyFill(shares, avg, 30, 40)
	if shares != 40 || avg != 45 {
		t.Fatalf("second fill: %d @ %.2f", shares, avg)
	}
	// Zero-share fills are no-ops.
	shares2, avg2 := ApplyFill(shares, avg, 0, 99)
	if shares2 != shares || avg2 != avg {
		t.Fatal("zero fill mutated position")
	}
}

func TestSettlePnl(t *testing.T) {
	tests := []struct {
		name      string
		side      string
		direction bool
		shares    int64
		avg       float64
		want      int64
	}{
		// YES wins: 20 shares bought at 45¢ pay $1 → +$11.00
		{"yes wins", "yes", true, 20, 45, 11_000_000},
		// NO held when YES settles: lose the 55¢ escrow × 20 → −$11.00
		{"no loses", "no", true, 20, 55, -11_000_000},
		// NO wins.
		{"no wins", "no", false, 10, 30, 7_000_000},
		{"yes loses", "yes", false, 10, 70, -7_000_000},
		{"empty", "yes", true, 0, 50, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := SettlePnl(tt.side, tt.direction, tt.shares, tt.avg, unit6); got != tt.want {
				t.Fatalf("SettlePnl = %d, want %d", got, tt.want)
			}
		})
	}
}

func TestSettlePnlMatchesSQLFormula(t *testing.T) {
	// The indexer bulk-settles in SQL: winners (100−avg)×shares×unit/100,
	// losers −avg×shares×unit/100. Keep the Go mirror in lockstep.
	shares, avg := int64(7), 33.5
	win := int64((100 - avg) * float64(shares) * float64(unit6) / 100)
	if got := SettlePnl("yes", true, shares, avg, unit6); got != win {
		t.Fatalf("winner mismatch: %d vs %d", got, win)
	}
	lose := -int64(avg * float64(shares) * float64(unit6) / 100)
	if got := SettlePnl("no", true, shares, avg, unit6); got != lose {
		t.Fatalf("loser mismatch: %d vs %d", got, lose)
	}
}

func TestPositionSwing(t *testing.T) {
	tests := []struct {
		name      string
		prev, cur int64
		wantPct   int
		wantSwung bool
	}{
		// Opening from zero is never a "swing" (no prior magnitude).
		{"open from zero", 0, 100, 0, false},
		// +50% exactly is NOT > 50%.
		{"exactly 50pct up", 100, 150, 50, false},
		// Just over 50% up.
		{"51pct up", 100, 151, 51, true},
		// Doubling.
		{"double", 100, 200, 100, true},
		// A shrink of >50% (magnitude down): 100 → 40 is −60%.
		{"60pct down", 100, 40, -60, true},
		// Small move, no swing.
		{"10pct up", 100, 110, 10, false},
		// Rounding: 3 → 5 is +66.67% → rounds to 67.
		{"rounds", 3, 5, 67, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			pct, swung := PositionSwing(tt.prev, tt.cur)
			if pct != tt.wantPct || swung != tt.wantSwung {
				t.Fatalf("PositionSwing(%d,%d) = (%d,%v), want (%d,%v)",
					tt.prev, tt.cur, pct, swung, tt.wantPct, tt.wantSwung)
			}
		})
	}
}

func TestLargeEntry(t *testing.T) {
	tests := []struct {
		name        string
		size        int64
		sum, count  int64
		wantLarge   bool
	}{
		// No history ⇒ never large (guard against divide-by-zero).
		{"no history", 1000, 0, 0, false},
		// avg = 100; 2×avg = 200; 201 > 200 ⇒ large.
		{"just over 2x", 201, 1000, 10, true},
		// exactly 2×avg is NOT strictly greater.
		{"exactly 2x", 200, 1000, 10, false},
		// well under.
		{"under", 150, 1000, 10, false},
		// avg = 50; threshold 100; 100 not > 100.
		{"boundary", 100, 500, 10, false},
		{"boundary over", 101, 500, 10, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := LargeEntry(tt.size, tt.sum, tt.count); got != tt.wantLarge {
				t.Fatalf("LargeEntry(%d,%d,%d) = %v, want %v",
					tt.size, tt.sum, tt.count, got, tt.wantLarge)
			}
		})
	}
}
