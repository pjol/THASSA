package store

import (
	"testing"
	"time"
)

func TestUsernameChangeCooldownDays(t *testing.T) {
	now := time.Date(2026, 7, 16, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name        string
		changedAt   time.Time
		wantDays    int
		wantAllowed bool
	}{
		// Never changed (zero time): first set is always free.
		{"never changed", time.Time{}, 0, true},
		// Changed 8 days ago: allowed.
		{"8 days ago", now.Add(-8 * 24 * time.Hour), 0, true},
		// Changed exactly 7 days ago: allowed (cooldown elapsed).
		{"exactly 7 days", now.Add(-7 * 24 * time.Hour), 0, true},
		// Changed just now: full 7 days remaining → ceil = 7.
		{"just now", now, 7, false},
		// Changed 1 day ago: 6 days remain.
		{"1 day ago", now.Add(-24 * time.Hour), 6, false},
		// Changed 6.5 days ago: 0.5 day remains → ceil = 1.
		{"6.5 days ago", now.Add(-time.Duration(6.5 * float64(24*time.Hour))), 1, false},
		// Changed 6 days + 1 hour ago: ~23h remain → ceil = 1.
		{"6d1h ago", now.Add(-(6*24 + 1) * time.Hour), 1, false},
		// Changed 3 days ago: 4 days remain.
		{"3 days ago", now.Add(-3 * 24 * time.Hour), 4, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			days, allowed := UsernameChangeCooldownDays(tt.changedAt, now)
			if allowed != tt.wantAllowed || days != tt.wantDays {
				t.Fatalf("UsernameChangeCooldownDays = (%d,%v), want (%d,%v)",
					days, allowed, tt.wantDays, tt.wantAllowed)
			}
		})
	}
}
