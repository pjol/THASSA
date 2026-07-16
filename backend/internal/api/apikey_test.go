package api

import (
	"strings"
	"testing"
	"time"
)

const testWindow = time.Minute

func TestAPIKeyRoundTrip(t *testing.T) {
	secret, prefix, hash, err := GenerateAPIKey()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(secret, "tsk_live_") {
		t.Fatalf("secret format: %q", secret)
	}
	if !strings.HasPrefix(secret, prefix) || len(prefix) != len("tsk_live_")+4 {
		t.Fatalf("prefix %q not a display prefix of the secret", prefix)
	}
	if HashAPIKey(secret) != hash {
		t.Fatal("hash mismatch")
	}
	if !VerifyAPIKeyHash(secret, hash) {
		t.Fatal("verify must accept the correct secret")
	}
	if VerifyAPIKeyHash(secret+"x", hash) {
		t.Fatal("verify must reject a tampered secret")
	}
	other, _, _, _ := GenerateAPIKey()
	if VerifyAPIKeyHash(other, hash) {
		t.Fatal("verify must reject a different key")
	}
}

func TestAPIKeyUniqueness(t *testing.T) {
	a, _, _, _ := GenerateAPIKey()
	b, _, _, _ := GenerateAPIKey()
	if a == b {
		t.Fatal("keys must be unique")
	}
}

func TestScopeAllows(t *testing.T) {
	tests := []struct {
		keyScope, required string
		want               bool
	}{
		{"read", "read", true},
		{"trade", "read", true},  // trade ⊃ read
		{"trade", "trade", true},
		{"read", "trade", false}, // read keys can never mutate
		{"", "read", false},
		{"admin", "trade", false}, // unknown scopes grant nothing
		{"trade", "admin", false},
	}
	for _, tt := range tests {
		if got := scopeAllows(tt.keyScope, tt.required); got != tt.want {
			t.Fatalf("scopeAllows(%q, %q) = %v, want %v", tt.keyScope, tt.required, got, tt.want)
		}
	}
}

func TestRateLimiter(t *testing.T) {
	l := newRateLimiter(3, testWindow)
	for i := 0; i < 3; i++ {
		if !l.Allow("k") {
			t.Fatalf("request %d should pass", i)
		}
	}
	if l.Allow("k") {
		t.Fatal("4th request should be limited")
	}
	if !l.Allow("other") {
		t.Fatal("other keys are independent")
	}
}
