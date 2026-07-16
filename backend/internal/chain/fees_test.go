package chain

import "testing"

const unit6 = int64(1_000_000) // 6-decimal token

func TestTakerFee(t *testing.T) {
	tests := []struct {
		name   string
		shares int64
		price  int
		want   int64
	}{
		// 0.07 × 10 × 0.50 × 0.50 = $0.175
		{"mid price", 10, 50, 175_000},
		// 0.07 × 100 × 0.99 × 0.01 = $0.0693
		{"extreme price", 100, 99, 69_300},
		// 0.07 × 1 × 0.01 × 0.99 = $0.000693 → rounds UP to 693 units
		{"one share cheap", 1, 1, 693},
		// ceil check: 0.07 × 3 × 0.33 × 0.67 = $0.0464310 exactly 46431
		{"three shares", 3, 33, 46_431},
		{"zero shares", 0, 50, 0},
		{"invalid price", 10, 0, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := TakerFee(tt.shares, tt.price, unit6); got != tt.want {
				t.Fatalf("TakerFee(%d, %d) = %d, want %d", tt.shares, tt.price, got, tt.want)
			}
		})
	}
}

func TestTakerFeeRoundsUp(t *testing.T) {
	// With a 2-decimal token: 700 × 1 × 50 × 50 × 100 / 1e8 = 1.75 units →
	// the contract (and this mirror) round fees UP, so 2 — never 1.
	if got := TakerFee(1, 50, 100); got != 2 {
		t.Fatalf("expected fee rounded up to 2, got %d", got)
	}
	// Exact divisions stay exact: 700 × 2 × 50 × 50 × 100 / 1e8 = 3.5 → 4.
	if got := TakerFee(2, 50, 100); got != 4 {
		t.Fatalf("expected 4, got %d", got)
	}
}

func TestEscrowAndMaxCost(t *testing.T) {
	// 10 shares at 62¢ = $6.20 escrow.
	if got := Escrow(10, 62, unit6); got != 6_200_000 {
		t.Fatalf("Escrow = %d", got)
	}
	esc := Escrow(10, 62, unit6)
	fee := TakerFee(10, 62, unit6)
	if got := EstimateMaxCost(10, 62, unit6); got != esc+fee {
		t.Fatalf("EstimateMaxCost = %d, want %d", got, esc+fee)
	}
}

func TestSettlementFee(t *testing.T) {
	if got := SettlementFee(unit6); got != 50_000 { // $0.05
		t.Fatalf("SettlementFee = %d", got)
	}
}

func TestTokenUnit(t *testing.T) {
	if TokenUnit(6) != 1_000_000 || TokenUnit(0) != 1 || TokenUnit(2) != 100 {
		t.Fatal("TokenUnit wrong")
	}
}
