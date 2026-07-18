package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/pjol/THASSA/backend/internal/auth"
	"github.com/pjol/THASSA/backend/internal/respond"
)

// Developer API keys (spec §6.9): tsk_live_<random> secrets shown once at
// creation; only the SHA-256 hash + a display prefix are stored.

const apiKeyPrefix = "tsk_live_"

// GenerateAPIKey mints a new secret and returns (secret, prefix, hash).
func GenerateAPIKey() (secret, prefix, hash string, err error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", "", "", err
	}
	secret = apiKeyPrefix + base64.RawURLEncoding.EncodeToString(raw)
	return secret, secret[:len(apiKeyPrefix)+4], HashAPIKey(secret), nil
}

// HashAPIKey is the storage/lookup hash of a full secret.
func HashAPIKey(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

// VerifyAPIKeyHash compares a presented secret against a stored hash in
// constant time.
func VerifyAPIKeyHash(secret, storedHash string) bool {
	presented := HashAPIKey(secret)
	return subtle.ConstantTimeCompare([]byte(presented), []byte(storedHash)) == 1
}

// scopeAllows reports whether a key scope authorizes an action.
// trade ⊃ read.
func scopeAllows(keyScope, required string) bool {
	switch required {
	case "read":
		return keyScope == "read" || keyScope == "trade"
	case "trade":
		return keyScope == "trade"
	}
	return false
}

type ctxScopeKey struct{}

// scopeFromContext returns the API-key scope ("" for Privy sessions, which
// carry full user authority).
func scopeFromContext(ctx context.Context) (string, bool) {
	s, ok := ctx.Value(ctxScopeKey{}).(string)
	return s, ok
}

// presentedAPIKey extracts the key from the X-Thassa-Key header. (On the
// WebSocket upgrade the key may instead ride the Sec-WebSocket-Protocol header;
// that path is handled in privyAuth via wsProtocolCreds.) Keys are never read
// from query parameters, so they can't leak into URLs or logs.
func presentedAPIKey(r *http.Request) string {
	return strings.TrimSpace(r.Header.Get("X-Thassa-Key"))
}

// resolveAPIKey authenticates a presented key: hash lookup + constant-time
// hash comparison, resolving to the owner's identity so every §8.1-gated
// store function works unchanged. Returns nil when invalid.
func (s *Server) resolveAPIKey(ctx context.Context, presented string) (*auth.Identity, string) {
	if presented == "" || !strings.HasPrefix(presented, apiKeyPrefix) {
		return nil, ""
	}
	keyID, userID, scope, storedHash, wallet, err := s.db.APIKeyIdentity(ctx, HashAPIKey(presented))
	if err != nil || userID == [16]byte{} {
		return nil, ""
	}
	if !VerifyAPIKeyHash(presented, storedHash) {
		return nil, ""
	}
	s.db.TouchAPIKey(ctx, keyID)
	return &auth.Identity{UserID: userID, Wallet: wallet}, scope
}

// resolveBearerIdentity authenticates a live user session (a Privy access
// token) on the trade API. This is access route 1, the OAuth-style path for
// agents and MCP servers that hold a real login and sign orders client-side,
// exactly like the app. A live session acts as the user with full scope.
func (s *Server) resolveBearerIdentity(r *http.Request) *auth.Identity {
	token := bearerToken(r)
	if token == "" {
		return nil
	}
	claims, err := s.verifier.Verify(r.Context(), token)
	if err != nil || claims.Subject == "" {
		return nil
	}
	userID, username, wallet, err := s.db.UpsertUserByPrivyDID(r.Context(), claims.Subject, claims.Wallet)
	if err != nil {
		return nil
	}
	return &auth.Identity{UserID: userID, PrivyDID: claims.Subject, Wallet: wallet, Username: username}
}

// apiKeyAuth is the /trade-api middleware. Two access routes:
//  1. Authorization: Bearer <privy access token>. A live session, full scope,
//     client-side signing (the OAuth/MCP path).
//  2. X-Thassa-Key. A developer API key; scope-checked. Signed payloads
//     always work; unsigned order submission additionally requires the user's
//     server-side signing opt-in (see handleCreateOrder).
func (s *Server) apiKeyAuth(requiredScope string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			presented := presentedAPIKey(r)
			if presented == "" {
				if id := s.resolveBearerIdentity(r); id != nil {
					if !s.keyLimiter.Allow("bearer:" + id.UserID.String()) {
						respond.Error(w, http.StatusTooManyRequests, "rate limit exceeded")
						return
					}
					ctx := auth.WithIdentity(r.Context(), id)
					ctx = context.WithValue(ctx, ctxScopeKey{}, "trade")
					next.ServeHTTP(w, r.WithContext(ctx))
					return
				}
				respond.Error(w, http.StatusUnauthorized, "missing api key or bearer token")
				return
			}
			id, scope := s.resolveAPIKey(r.Context(), presented)
			if id == nil {
				respond.Error(w, http.StatusUnauthorized, "invalid api key")
				return
			}
			if !scopeAllows(scope, requiredScope) {
				respond.Error(w, http.StatusForbidden, "api key scope does not allow this action")
				return
			}
			if !s.keyLimiter.Allow(HashAPIKey(presented)) {
				respond.Error(w, http.StatusTooManyRequests, "rate limit exceeded")
				return
			}
			ctx := auth.WithIdentity(r.Context(), id)
			ctx = context.WithValue(ctx, ctxScopeKey{}, scope)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// ipRateLimit protects the public (no-auth) market-data endpoints.
func (s *Server) ipRateLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			host = r.RemoteAddr
		}
		if !s.ipLimiter.Allow(host) {
			respond.Error(w, http.StatusTooManyRequests, "rate limit exceeded")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// rateLimiter is a per-instance sliding-window limiter. It protects compute
// on THIS instance (each instance defends itself), so per-instance state does
// not break the stateless-API requirement — correctness-relevant limits
// (order rates) are enforced against the database.
type rateLimiter struct {
	mu     sync.Mutex
	window time.Duration
	max    int
	hits   map[string][]time.Time
}

func newRateLimiter(max int, window time.Duration) *rateLimiter {
	return &rateLimiter{window: window, max: max, hits: map[string][]time.Time{}}
}

func (l *rateLimiter) Allow(key string) bool {
	now := time.Now()
	cutoff := now.Add(-l.window)
	l.mu.Lock()
	defer l.mu.Unlock()
	kept := l.hits[key][:0]
	for _, t := range l.hits[key] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) >= l.max {
		l.hits[key] = kept
		return false
	}
	l.hits[key] = append(kept, now)
	// Opportunistic map GC.
	if len(l.hits) > 100_000 {
		for k, v := range l.hits {
			if len(v) == 0 || !v[len(v)-1].After(cutoff) {
				delete(l.hits, k)
			}
		}
	}
	return true
}
