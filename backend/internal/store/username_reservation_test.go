package store

import "testing"

// TestUsernameClaimAllowed exercises the reservation decision (spec §7c):
// 1–4 char names reserved for non-admins, admins exempt, whitelist email
// match/mismatch, and a whitelisted short name claimable by its email.
func TestUsernameClaimAllowed(t *testing.T) {
	const resEmail = "owner@thassa.io"
	tests := []struct {
		name          string
		username      string
		isAdmin       bool
		emailVerified bool
		claimerEmail  string
		reservedEmail string
		hasRes        bool
		want          bool
	}{
		// Default length reservation for non-admins.
		{"1 char reserved", "a", false, false, "", "", false, false},
		{"3 char reserved", "abc", false, false, "", "", false, false},
		{"4 char reserved", "abcd", false, false, "", "", false, false},
		{"5 char free", "abcde", false, false, "", "", false, true},
		{"long free", "someusername", false, false, "", "", false, true},

		// Admins are exempt from every rule.
		{"admin claims 1 char", "a", true, false, "", "", false, true},
		{"admin claims 4 char", "abcd", true, false, "", "", false, true},
		{"admin claims whitelisted-other", "brand", true, true, "someone@x.io", resEmail, true, true},

		// Whitelist enforcement (5+ char name that would otherwise be free).
		{"whitelist match", "brandname", false, true, resEmail, resEmail, true, true},
		{"whitelist match case-insensitive", "brandname", false, true, "OWNER@THASSA.IO", resEmail, true, true},
		{"whitelist mismatch", "brandname", false, true, "other@x.io", resEmail, true, false},
		{"whitelist but unverified email", "brandname", false, false, resEmail, resEmail, true, false},
		{"whitelist blocks empty claimer", "brandname", false, false, "", resEmail, true, false},

		// A whitelisted SHORT (reserved-by-default) name is claimable by its email.
		{"whitelisted short claimable by email", "abcd", false, true, resEmail, resEmail, true, true},
		{"whitelisted short blocked for others", "abcd", false, true, "nope@x.io", resEmail, true, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := UsernameClaimAllowed(tt.username, tt.isAdmin, tt.emailVerified,
				tt.claimerEmail, tt.reservedEmail, tt.hasRes)
			if got != tt.want {
				t.Fatalf("UsernameClaimAllowed(%q, admin=%v, verified=%v, claimer=%q, reserved=%q, hasRes=%v) = %v, want %v",
					tt.username, tt.isAdmin, tt.emailVerified, tt.claimerEmail, tt.reservedEmail, tt.hasRes, got, tt.want)
			}
		})
	}
}
