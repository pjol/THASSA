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
