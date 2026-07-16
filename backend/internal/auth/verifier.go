package auth

import (
	"context"
	"errors"
)

// Claims are the vendor-agnostic facts extracted from a verified access token.
type Claims struct {
	// Subject is the stable vendor user id (Privy DID, e.g. "did:privy:…").
	Subject string
	// Wallet is the linked/embedded wallet address claim, if present.
	Wallet string
}

// ErrUnauthorized is returned for any invalid, expired, or malformed token.
var ErrUnauthorized = errors.New("unauthorized")

// Verifier verifies a bearer access token and returns its claims. The Privy
// implementation is the default; a future Signet verifier plugs in behind the
// same interface.
type Verifier interface {
	Verify(ctx context.Context, token string) (*Claims, error)
}
