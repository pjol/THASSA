package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/pjol/THASSA/backend/internal/auth"
	"github.com/pjol/THASSA/backend/internal/respond"
	"github.com/pjol/THASSA/backend/internal/store"
)

// privyAuth verifies the bearer access token via the pluggable auth.Verifier
// (Privy today, Signet later) and stashes the verified claims. The WS path
// also accepts ?token= because browsers cannot set headers on WebSocket
// upgrade requests.
func (s *Server) privyAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := bearerToken(r)
		if token == "" {
			token = r.URL.Query().Get("token")
		}
		if token == "" {
			// Developer-API fallback (spec §6.9): the realtime socket also
			// accepts X-Thassa-Key/?key= (book:{marketId} subscriptions).
			if presented := presentedAPIKey(r); presented != "" {
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
		id := &auth.Identity{UserID: userID, PrivyDID: claims.Subject, Wallet: wallet, Username: username}
		next.ServeHTTP(w, r.WithContext(auth.WithIdentity(r.Context(), id)))
	})
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
