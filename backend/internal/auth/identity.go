package auth

import (
	"context"

	"github.com/google/uuid"
)

// Identity is the authenticated caller, resolved from the verified access
// token and the local users row. Attached to the request context by the
// resolveIdentity middleware.
//
// While a warp is active (spec §7c.2) the identity returned by FromContext is
// the EFFECTIVE (impersonated target) user, so every §8.1-gated handler and
// store call automatically operates on the warped user with no per-handler
// change. The REAL admin identity is retained separately and read via
// RealIdentity — admin-only endpoints must use that so a warp can never
// escalate.
type Identity struct {
	UserID   uuid.UUID
	PrivyDID string
	Wallet   string // linked/embedded wallet address (0x…), may be empty
	Username string
	// Email is the user's resolved email (verified token claim or Privy API).
	Email string
	// EmailVerified is true when Email came from a trusted source.
	EmailVerified bool
	// IsAdmin is email_verified (or the dev trust flag) AND lower(email) ∈
	// ADMIN_EMAILS. Computed at identity resolution.
	IsAdmin bool
}

type ctxKey int

const (
	identityKey ctxKey = iota
	claimsKey
	realIdentityKey
)

// WithIdentity returns a context carrying the (effective) caller identity.
func WithIdentity(ctx context.Context, id *Identity) context.Context {
	return context.WithValue(ctx, identityKey, id)
}

// FromContext returns the EFFECTIVE caller identity, if present. This is the
// warp target while warped, or the real user otherwise — every §8.1-gated
// handler/store call keys off this.
func FromContext(ctx context.Context) (*Identity, bool) {
	id, ok := ctx.Value(identityKey).(*Identity)
	return id, ok
}

// WithRealIdentity records the REAL (admin) identity separately from the
// effective one. Set by the warp middleware when a warp activates.
func WithRealIdentity(ctx context.Context, id *Identity) context.Context {
	return context.WithValue(ctx, realIdentityKey, id)
}

// RealIdentity returns the REAL authenticated caller — the admin behind a warp,
// or simply the caller when no warp is active. Admin-only endpoints MUST use
// this (never FromContext) so warping cannot escalate. Falls back to the
// effective identity when no separate real identity was recorded.
func RealIdentity(ctx context.Context) (*Identity, bool) {
	if id, ok := ctx.Value(realIdentityKey).(*Identity); ok {
		return id, true
	}
	return FromContext(ctx)
}

// IsWarped reports whether a warp is active (a distinct real identity exists).
func IsWarped(ctx context.Context) bool {
	_, ok := ctx.Value(realIdentityKey).(*Identity)
	return ok
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
