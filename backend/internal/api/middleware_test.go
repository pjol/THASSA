package api

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"

	"github.com/pjol/THASSA/backend/internal/auth"
	"github.com/pjol/THASSA/backend/internal/store"
)

// fakeIdemBackend is an in-memory IdemBackend (per spec §6.7 the middleware is
// unit-tested without Postgres).
type fakeIdemBackend struct {
	mu   sync.Mutex
	rows map[string]*fakeIdemRow
}

type fakeIdemRow struct {
	methodPath, requestHash string
	status                  *int
	body                    []byte
}

func newFakeIdemBackend() *fakeIdemBackend {
	return &fakeIdemBackend{rows: map[string]*fakeIdemRow{}}
}

func (f *fakeIdemBackend) key(key string, userID uuid.UUID) string {
	return key + "|" + userID.String()
}

func (f *fakeIdemBackend) ClaimIdempotencyKey(_ context.Context, key string, userID uuid.UUID, methodPath, requestHash string) (store.IdemClaim, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	k := f.key(key, userID)
	row, ok := f.rows[k]
	if !ok {
		f.rows[k] = &fakeIdemRow{methodPath: methodPath, requestHash: requestHash}
		return store.IdemClaim{State: store.IdemNew}, nil
	}
	if row.methodPath != methodPath || row.requestHash != requestHash {
		return store.IdemClaim{State: store.IdemConflict}, nil
	}
	if row.status == nil {
		return store.IdemClaim{State: store.IdemInflight}, nil
	}
	return store.IdemClaim{State: store.IdemReplay, Status: *row.status, Body: row.body}, nil
}

func (f *fakeIdemBackend) SaveIdempotencyResponse(_ context.Context, key string, userID uuid.UUID, status int, body []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if row, ok := f.rows[f.key(key, userID)]; ok {
		row.status = &status
		row.body = body
	}
	return nil
}

func idemHandler(t *testing.T, executions *int) http.Handler {
	t.Helper()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*executions++
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		fmt.Fprintf(w, `{"execution":%d}`, *executions)
	})
}

func doIdem(h http.Handler, userID uuid.UUID, method, path, body, key string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if key != "" {
		req.Header.Set("Idempotency-Key", key)
	}
	req = req.WithContext(auth.WithIdentity(req.Context(), &auth.Identity{UserID: userID}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestIdempotencyReplay(t *testing.T) {
	backend := newFakeIdemBackend()
	executions := 0
	h := IdempotencyMiddleware(backend)(idemHandler(t, &executions))
	user := uuid.New()

	first := doIdem(h, user, http.MethodPost, "/v1/orders", `{"shares":5}`, "key-1")
	if first.Code != http.StatusCreated || executions != 1 {
		t.Fatalf("first: code=%d executions=%d", first.Code, executions)
	}
	// Exact replay: handler NOT re-executed, stored body returned.
	second := doIdem(h, user, http.MethodPost, "/v1/orders", `{"shares":5}`, "key-1")
	if executions != 1 {
		t.Fatalf("replay re-executed the handler (%d)", executions)
	}
	if second.Code != http.StatusCreated || second.Body.String() != first.Body.String() {
		t.Fatalf("replay mismatch: %d %q vs %q", second.Code, second.Body.String(), first.Body.String())
	}
	if second.Header().Get("Idempotency-Replayed") != "true" {
		t.Fatal("replay must be marked")
	}
}

func TestIdempotencyConflict(t *testing.T) {
	backend := newFakeIdemBackend()
	executions := 0
	h := IdempotencyMiddleware(backend)(idemHandler(t, &executions))
	user := uuid.New()

	doIdem(h, user, http.MethodPost, "/v1/orders", `{"shares":5}`, "key-1")
	// Same key, DIFFERENT body → 409, handler not executed again.
	conflict := doIdem(h, user, http.MethodPost, "/v1/orders", `{"shares":9}`, "key-1")
	if conflict.Code != http.StatusConflict || executions != 1 {
		t.Fatalf("conflict: code=%d executions=%d", conflict.Code, executions)
	}
	// Same key, different PATH → also a conflict.
	pathConflict := doIdem(h, user, http.MethodPost, "/v1/wallet/send", `{"shares":5}`, "key-1")
	if pathConflict.Code != http.StatusConflict {
		t.Fatalf("path conflict: code=%d", pathConflict.Code)
	}
}

func TestIdempotencyScopedPerUser(t *testing.T) {
	// §8.1: idempotency keys are scoped by the token user — another user
	// reusing the same key neither replays nor conflicts.
	backend := newFakeIdemBackend()
	executions := 0
	h := IdempotencyMiddleware(backend)(idemHandler(t, &executions))

	doIdem(h, uuid.New(), http.MethodPost, "/v1/orders", `{"shares":5}`, "shared-key")
	other := doIdem(h, uuid.New(), http.MethodPost, "/v1/orders", `{"shares":5}`, "shared-key")
	if other.Code != http.StatusCreated || executions != 2 {
		t.Fatalf("cross-user: code=%d executions=%d", other.Code, executions)
	}
}

func TestIdempotencyInflight(t *testing.T) {
	backend := newFakeIdemBackend()
	// Pre-claim the key without a stored response = first request in flight.
	user := uuid.New()
	_, _ = backend.ClaimIdempotencyKey(context.Background(), "key-1", user,
		"POST /v1/orders", reqHashFor("POST /v1/orders", `{"a":1}`))

	executions := 0
	h := IdempotencyMiddleware(backend)(idemHandler(t, &executions))
	rec := doIdem(h, user, http.MethodPost, "/v1/orders", `{"a":1}`, "key-1")
	if rec.Code != http.StatusConflict || executions != 0 {
		t.Fatalf("inflight: code=%d executions=%d", rec.Code, executions)
	}
}

func TestIdempotencySkipsGETAndKeyless(t *testing.T) {
	backend := newFakeIdemBackend()
	executions := 0
	h := IdempotencyMiddleware(backend)(idemHandler(t, &executions))
	user := uuid.New()

	doIdem(h, user, http.MethodGet, "/v1/feed", "", "key-1")
	doIdem(h, user, http.MethodPost, "/v1/orders", `{}`, "")
	doIdem(h, user, http.MethodPost, "/v1/orders", `{}`, "")
	if executions != 3 {
		t.Fatalf("GET/keyless requests must pass through, executions=%d", executions)
	}
}

func TestIdempotencyRequiresIdentity(t *testing.T) {
	backend := newFakeIdemBackend()
	executions := 0
	h := IdempotencyMiddleware(backend)(idemHandler(t, &executions))
	req := httptest.NewRequest(http.MethodPost, "/v1/orders", strings.NewReader(`{}`))
	req.Header.Set("Idempotency-Key", "key-1")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized || executions != 0 {
		t.Fatalf("missing identity: code=%d executions=%d", rec.Code, executions)
	}
}

// reqHashFor mirrors the middleware's hash so the inflight test can pre-claim.
func reqHashFor(methodPath, body string) string {
	return hashRequest(methodPath, []byte(body))
}
