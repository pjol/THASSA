package config

import "testing"

func TestEmailIsAdmin(t *testing.T) {
	cfg := &Config{
		AdminEmails: lowerSet([]string{"Admin@Thassa.io", " boss@thassa.io "}),
	}

	cases := []struct {
		name     string
		email    string
		verified bool
		trust    bool
		want     bool
	}{
		{"verified admin matches (case-insensitive)", "ADMIN@thassa.io", true, false, true},
		{"verified second admin trimmed", "boss@thassa.io", true, false, true},
		{"unverified admin denied without dev flag", "admin@thassa.io", false, false, false},
		{"unverified admin allowed with dev flag", "admin@thassa.io", false, true, true},
		{"verified non-admin denied", "nobody@thassa.io", true, false, false},
		{"empty email denied", "", true, true, false},
		{"unverified non-admin denied even with flag", "nobody@thassa.io", false, true, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			cfg.AdminTrustUnverifiedEmail = c.trust
			if got := cfg.EmailIsAdmin(c.email, c.verified); got != c.want {
				t.Errorf("EmailIsAdmin(%q, verified=%v, trust=%v) = %v, want %v",
					c.email, c.verified, c.trust, got, c.want)
			}
		})
	}
}
