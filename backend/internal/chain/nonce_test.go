package chain

import "testing"

// RecoverNonce is the failover-safety core (spec §6.7): a new leader must
// never reuse a nonce the previous leader may have broadcast.
func TestRecoverNonce(t *testing.T) {
	tests := []struct {
		name         string
		chainPending uint64
		dbMax        int64
		dbHasRows    bool
		want         uint64
	}{
		{"fresh key, empty ledger", 0, 0, false, 0},
		{"chain ahead of ledger", 12, 5, true, 12},
		{"ledger ahead of chain (broadcast not yet mined)", 5, 11, true, 12},
		{"equal: ledger nonce still pending on chain", 8, 8, true, 9},
		{"ledger present but chain pruned/reset", 0, 3, true, 4},
		{"no ledger rows, chain has history", 42, 0, false, 42},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := RecoverNonce(tt.chainPending, tt.dbMax, tt.dbHasRows); got != tt.want {
				t.Fatalf("RecoverNonce(%d, %d, %v) = %d, want %d",
					tt.chainPending, tt.dbMax, tt.dbHasRows, got, tt.want)
			}
		})
	}
}
