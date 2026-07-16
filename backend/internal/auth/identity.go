package auth

import (
	"context"

	"github.com/google/uuid"
)

// Identity is the authenticated caller, resolved from the verified access
// token and the local users row. Attached to the request context by the
// resolveIdentity middleware.
type Identity struct {
	UserID   uuid.UUID
	PrivyDID string
	Wallet   string // linked/embedded wallet address (0x…), may be empty
	Username string
}

type ctxKey int

const (
	identityKey ctxKey = iota
	claimsKey
)

// WithIdentity returns a context carrying the caller identity.
func WithIdentity(ctx context.Context, id *Identity) context.Context {
	return context.WithValue(ctx, identityKey, id)
}

// FromContext returns the caller identity, if present.
func FromContext(ctx context.Context) (*Identity, bool) {
	id, ok := ctx.Value(identityKey).(*Identity)
	return id, ok
}

// WithClaims returns a context carrying the verified token claims (set by the
// token-verification middleware, consumed by resolveIdentity).
func WithClaims(ctx context.Context, c *Claims) context.Context {
	return context.WithValue(ctx, claimsKey, c)
}

// ClaimsFromContext returns the verified token claims, if present.
func ClaimsFromContext(ctx context.Context) (*Claims, bool) {
	c, ok := ctx.Value(claimsKey).(*Claims)
	return c, ok
}
