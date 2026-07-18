package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"log"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/pjol/THASSA/backend/internal/auth"
	"github.com/pjol/THASSA/backend/internal/respond"
	"github.com/pjol/THASSA/backend/internal/store"
	"github.com/pjol/THASSA/backend/internal/structs"
)

// privyAuth verifies the bearer access token via the pluggable auth.Verifier
// (Privy today, Signet later) and stashes the verified claims. Credentials are
// only ever read from HEADERS, never query parameters — so tokens never leak
// into URLs, logs, or referrers. On the WebSocket upgrade, where browsers
// cannot set an Authorization header, the token rides the standard
// Sec-WebSocket-Protocol header instead (mobile sets Authorization directly).
func (s *Server) privyAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		wsToken, wsKey := wsProtocolCreds(r)
		token := bearerToken(r)
		if token == "" {
			token = wsToken
		}
		if token == "" {
			// Developer-API fallback (spec §6.9): the realtime socket also
			// accepts an API key (X-Thassa-Key header, or the ws subprotocol)
			// for book:{marketId} subscriptions.
			presented := presentedAPIKey(r)
			if presented == "" {
				presented = wsKey
			}
			if presented != "" {
				if id, _ := s.resolveAPIKey(r.Context(), presented); id != nil {
					next.ServeHTTP(w, r.WithContext(auth.WithIdentity(r.Context(), id)))
					return
				}
				respond.Error(w, http.StatusUnauthorized, "invalid api key")
				return
			}
			respond.Error(w, http.StatusUnauthorized, "unauthenticated")
			return
		}
		claims, err := s.verifier.Verify(r.Context(), token)
		if err != nil {
			respond.Error(w, http.StatusUnauthorized, "invalid token")
			return
		}
		next.ServeHTTP(w, r.WithContext(auth.WithClaims(r.Context(), claims)))
	})
}

func bearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if strings.HasPrefix(h, "Bearer ") {
		return strings.TrimPrefix(h, "Bearer ")
	}
	return ""
}

// wsProtocolCreds extracts a credential carried in the Sec-WebSocket-Protocol
// header, the header-safe way for browsers to authenticate a WebSocket (which
// otherwise can't set Authorization). Clients offer two subprotocols: a
// sentinel then the value — ["thassa-bearer", <jwt>] or ["thassa-key", <apiKey>].
// The server echoes only the sentinel (see wsUpgrader.Subprotocols), so the
// credential is never reflected back. Returns ("","") for non-WS requests.
func wsProtocolCreds(r *http.Request) (token, apiKey string) {
	h := r.Header.Get("Sec-WebSocket-Protocol")
	if h == "" {
		return "", ""
	}
	parts := strings.Split(h, ",")
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}
	if len(parts) < 2 {
		return "", ""
	}
	switch parts[0] {
	case "thassa-bearer":
		return parts[1], ""
	case "thassa-key":
		return "", parts[1]
	}
	return "", ""
}

// resolveIdentity maps the verified token subject (privy DID) to a local
// users row, lazily provisioning it on first contact (capturing the linked
// wallet claim), and attaches the Identity. §8.1: this DID — never anything
// client-supplied — is the only identity source for every downstream query.
func (s *Server) resolveIdentity(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Already resolved (API-key path): pass through.
		if _, ok := auth.FromContext(r.Context()); ok {
			next.ServeHTTP(w, r)
			return
		}
		claims, ok := auth.ClaimsFromContext(r.Context())
		if !ok || claims.Subject == "" {
			respond.Error(w, http.StatusUnauthorized, "unauthenticated")
			return
		}
		userID, username, wallet, err := s.db.UpsertUserByPrivyDID(r.Context(), claims.Subject, claims.Wallet)
		if err != nil {
			respond.Error(w, http.StatusInternalServerError, "identity resolution failed")
			return
		}

		// Email + admin resolution (spec §7c.1): token claim first, then the
		// Privy server API when an app secret is configured. Both sources are
		// verified. Best-effort — never fail the request on an API error.
		email, verified := claims.Email, claims.EmailVerified
		if email == "" && s.privyAPI.Enabled() {
			if apiEmail, apiErr := s.privyAPI.EmailForDID(r.Context(), claims.Subject); apiErr != nil {
				if !errors.Is(apiErr, auth.ErrPrivyAPIUnconfigured) {
					log.Printf("privy api: email lookup for %s failed: %v", claims.Subject, apiErr)
				}
			} else if apiEmail != "" {
				email, verified = apiEmail, true
			}
		}
		if email != "" {
			if err := s.db.SetUserEmail(r.Context(), userID, email, verified); err != nil {
				log.Printf("identity: persist email failed for %s: %v", userID, err)
			}
		}
		isAdmin := s.cfg.EmailIsAdmin(email, verified)

		id := &auth.Identity{
			UserID:        userID,
			PrivyDID:      claims.Subject,
			Wallet:        wallet,
			Username:      username,
			Email:         email,
			EmailVerified: verified,
			IsAdmin:       isAdmin,
		}
		next.ServeHTTP(w, r.WithContext(auth.WithIdentity(r.Context(), id)))
	})
}

// warpHeader is the impersonation header (spec §7c.2).
const warpHeader = "X-Thassa-Warp"

// WarpBackend is the persistence surface the warp middleware needs (an
// interface so it is unit-testable without Postgres; *store.Store satisfies it).
type WarpBackend interface {
	AdminUserSummary(ctx context.Context, userID uuid.UUID) (*structs.AdminUser, error)
	UserWallet(ctx context.Context, userID uuid.UUID) (string, error)
}

// warp implements the admin impersonation mechanism (spec §7c.2).
func (s *Server) warp(next http.Handler) http.Handler {
	return WarpMiddleware(s.db)(next)
}

// WarpMiddleware runs AFTER resolveIdentity. When X-Thassa-Warp: <targetUserId>
// is present:
//   - the REAL user must be is_admin (else 403);
//   - the target user must exist (else 404);
//   - the EFFECTIVE identity (what FromContext returns, driving every §8.1
//     data-access path) becomes the target, while the real admin identity is
//     retained via WithRealIdentity for admin endpoints + audit;
//   - the impersonation is read-only: mutating methods are rejected 403,
//     except the /v1/admin/* routes.
//
// No header ⇒ complete no-op.
func WarpMiddleware(db WarpBackend) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			raw := strings.TrimSpace(r.Header.Get(warpHeader))
			if raw == "" {
				next.ServeHTTP(w, r)
				return
			}
			real, ok := auth.FromContext(r.Context())
			if !ok {
				respond.Error(w, http.StatusUnauthorized, "unauthenticated")
				return
			}
			if !real.IsAdmin {
				respond.Error(w, http.StatusForbidden, "admin only")
				return
			}
			targetID, err := uuid.Parse(raw)
			if err != nil {
				respond.Error(w, http.StatusBadRequest, "invalid warp target")
				return
			}
			target, err := db.AdminUserSummary(r.Context(), targetID)
			if err != nil {
				respond.Error(w, http.StatusInternalServerError, "warp target lookup failed")
				return
			}
			if target == nil {
				respond.Error(w, http.StatusNotFound, "warp target not found")
				return
			}

			// Read-only while warped: block mutations except the admin routes.
			if isMutation(r.Method) && !strings.HasPrefix(r.URL.Path, "/v1/admin") {
				respond.Error(w, http.StatusForbidden, "read-only while warped")
				return
			}

			wallet, _ := db.UserWallet(r.Context(), target.ID)
			effective := &auth.Identity{
				UserID:   target.ID,
				Username: strDeref(target.Username),
				Wallet:   wallet,
				Email:    strDeref(target.Email),
			}
			log.Printf("warp: admin %s (%s) → target %s (%s)",
				real.Email, real.UserID, target.ID, strDeref(target.Username))

			ctx := auth.WithRealIdentity(r.Context(), real)
			ctx = auth.WithIdentity(ctx, effective)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// requireAdmin gates admin-only endpoints on the REAL identity (spec §7c.2):
// warping can never escalate, even into another admin.
func (s *Server) requireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		real, ok := auth.RealIdentity(r.Context())
		if !ok || !real.IsAdmin {
			respond.Error(w, http.StatusForbidden, "admin only")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func isMutation(method string) bool {
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return true
	}
	return false
}

func strDeref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// idempotency implements spec §6.7: mutating requests carrying an
// Idempotency-Key are executed once per (key, user); replays return the
// stored response, and reusing a key with a different request body/path 409s.
func (s *Server) idempotency(next http.Handler) http.Handler {
	return IdempotencyMiddleware(s.db)(next)
}

// IdemBackend is the persistence surface the middleware needs (interface so
// the middleware is unit-testable without Postgres; *store.Store satisfies it).
type IdemBackend interface {
	ClaimIdempotencyKey(ctx context.Context, key string, userID uuid.UUID, methodPath, requestHash string) (store.IdemClaim, error)
	SaveIdempotencyResponse(ctx context.Context, key string, userID uuid.UUID, status int, body []byte) error
}

// IdempotencyMiddleware builds the middleware around a backend.
func IdempotencyMiddleware(db IdemBackend) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			key := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
			if key == "" || r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
				next.ServeHTTP(w, r)
				return
			}
			if len(key) > 200 {
				respond.Error(w, http.StatusBadRequest, "idempotency key too long")
				return
			}
			id, ok := auth.FromContext(r.Context())
			if !ok {
				respond.Error(w, http.StatusUnauthorized, "unauthenticated")
				return
			}

			// Hash method+path+body; restore the body for the handler.
			body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 5<<20))
			if err != nil {
				respond.Error(w, http.StatusBadRequest, "invalid body")
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(body))
			methodPath := r.Method + " " + r.URL.Path
			reqHash := hashRequest(methodPath, body)

			claim, err := db.ClaimIdempotencyKey(r.Context(), key, id.UserID, methodPath, reqHash)
			if err != nil {
				respond.Error(w, http.StatusInternalServerError, "idempotency check failed")
				return
			}
			switch claim.State {
			case store.IdemReplay:
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Idempotency-Replayed", "true")
				w.WriteHeader(claim.Status)
				_, _ = w.Write(claim.Body)
				return
			case store.IdemConflict:
				respond.Error(w, http.StatusConflict, "idempotency key reused with a different request")
				return
			case store.IdemInflight:
				respond.Error(w, http.StatusConflict, "request with this idempotency key is in flight")
				return
			}

			rec := &responseRecorder{ResponseWriter: w, status: http.StatusOK}
			next.ServeHTTP(rec, r)
			if rec.status != 0 {
				_ = db.SaveIdempotencyResponse(r.Context(), key, id.UserID, rec.status, rec.buf.Bytes())
			}
		})
	}
}

// hashRequest fingerprints a request for idempotency comparison.
func hashRequest(methodPath string, body []byte) string {
	sum := sha256.Sum256(append([]byte(methodPath+"\n"), body...))
	return hex.EncodeToString(sum[:])
}

// responseRecorder tees the response so it can be stored for replays.
type responseRecorder struct {
	http.ResponseWriter
	status int
	buf    bytes.Buffer
	wrote  bool
}

func (r *responseRecorder) WriteHeader(status int) {
	if !r.wrote {
		r.status = status
		r.wrote = true
	}
	r.ResponseWriter.WriteHeader(status)
}

func (r *responseRecorder) Write(b []byte) (int, error) {
	if !r.wrote {
		r.wrote = true
	}
	r.buf.Write(b)
	return r.ResponseWriter.Write(b)
}

func chiParam(r *http.Request, key string) string {
	return chi.URLParam(r, key)
}
