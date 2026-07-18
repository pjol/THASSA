package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"

	"github.com/pjol/THASSA/backend/internal/auth"
	"github.com/pjol/THASSA/backend/internal/structs"
)

// fakeWarpBackend is an in-memory WarpBackend (the warp middleware is
// unit-tested without Postgres, mirroring the idempotency middleware tests).
type fakeWarpBackend struct {
	users map[uuid.UUID]*structs.AdminUser
}

func (f *fakeWarpBackend) AdminUserSummary(_ context.Context, id uuid.UUID) (*structs.AdminUser, error) {
	return f.users[id], nil // nil when absent ⇒ 404
}

func (f *fakeWarpBackend) UserWallet(_ context.Context, _ uuid.UUID) (string, error) {
	return "", nil
}

func strp(s string) *string { return &s }

// warpProbe is the terminal handler: it reports the effective + real identities
// the middleware chose, so tests can assert the swap.
func warpProbe(w http.ResponseWriter, r *http.Request) {
	eff, _ := auth.FromContext(r.Context())
	real, _ := auth.RealIdentity(r.Context())
	_ = json.NewEncoder(w).Encode(map[string]any{
		"effective_id": eff.UserID.String(),
		"real_id":      real.UserID.String(),
		"real_admin":   real.IsAdmin,
		"warped":       auth.IsWarped(r.Context()),
	})
}

// withIdentity injects a caller identity, simulating resolveIdentity.
func withIdentity(id *auth.Identity, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r.WithContext(auth.WithIdentity(r.Context(), id)))
	})
}

func doWarp(h http.Handler, method, path, warpTarget string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	if warpTarget != "" {
		req.Header.Set(warpHeader, warpTarget)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestWarp(t *testing.T) {
	adminID := uuid.New()
	targetID := uuid.New()
	admin := &auth.Identity{UserID: adminID, Email: "admin@thassa.io", IsAdmin: true}
	nonAdmin := &auth.Identity{UserID: adminID, Email: "user@thassa.io", IsAdmin: false}

	backend := &fakeWarpBackend{users: map[uuid.UUID]*structs.AdminUser{
		targetID: {ID: targetID, Username: strp("target"), Email: strp("target@thassa.io")},
	}}
	chain := func(id *auth.Identity) http.Handler {
		return withIdentity(id, WarpMiddleware(backend)(http.HandlerFunc(warpProbe)))
	}

	t.Run("no header is a no-op", func(t *testing.T) {
		rec := doWarp(chain(admin), http.MethodGet, "/v1/feed", "")
		if rec.Code != http.StatusOK {
			t.Fatalf("code = %d", rec.Code)
		}
		var body map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		if body["warped"] != false {
			t.Errorf("expected not warped")
		}
		if body["effective_id"] != adminID.String() {
			t.Errorf("effective_id = %v, want admin", body["effective_id"])
		}
	})

	t.Run("non-admin with header is 403", func(t *testing.T) {
		rec := doWarp(chain(nonAdmin), http.MethodGet, "/v1/feed", targetID.String())
		if rec.Code != http.StatusForbidden {
			t.Fatalf("code = %d, want 403", rec.Code)
		}
	})

	t.Run("admin warp switches effective id, keeps real id", func(t *testing.T) {
		rec := doWarp(chain(admin), http.MethodGet, "/v1/feed", targetID.String())
		if rec.Code != http.StatusOK {
			t.Fatalf("code = %d", rec.Code)
		}
		var body map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		if body["effective_id"] != targetID.String() {
			t.Errorf("effective_id = %v, want target", body["effective_id"])
		}
		if body["real_id"] != adminID.String() {
			t.Errorf("real_id = %v, want admin", body["real_id"])
		}
		if body["real_admin"] != true {
			t.Errorf("real_admin should stay true")
		}
		if body["warped"] != true {
			t.Errorf("expected warped")
		}
	})

	t.Run("mutation while warped is 403", func(t *testing.T) {
		for _, m := range []string{http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete} {
			rec := doWarp(chain(admin), m, "/v1/posts", targetID.String())
			if rec.Code != http.StatusForbidden {
				t.Errorf("%s while warped = %d, want 403", m, rec.Code)
			}
		}
	})

	t.Run("mutation on admin route allowed while warped", func(t *testing.T) {
		rec := doWarp(chain(admin), http.MethodPost, "/v1/admin/warp", targetID.String())
		if rec.Code != http.StatusOK {
			t.Fatalf("admin route while warped = %d, want 200", rec.Code)
		}
	})

	t.Run("missing target is 404", func(t *testing.T) {
		rec := doWarp(chain(admin), http.MethodGet, "/v1/feed", uuid.New().String())
		if rec.Code != http.StatusNotFound {
			t.Fatalf("code = %d, want 404", rec.Code)
		}
	})

	t.Run("invalid target id is 400", func(t *testing.T) {
		rec := doWarp(chain(admin), http.MethodGet, "/v1/feed", "not-a-uuid")
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("code = %d, want 400", rec.Code)
		}
	})
}

// TestRequireAdmin verifies admin endpoints gate on the REAL identity, so a
// warp cannot escalate even into another admin.
func TestRequireAdmin(t *testing.T) {
	guard := func(id *auth.Identity, real *auth.Identity) *httptest.ResponseRecorder {
		s := &Server{}
		h := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
		req := httptest.NewRequest(http.MethodGet, "/v1/admin/users", nil)
		ctx := auth.WithIdentity(req.Context(), id)
		if real != nil {
			ctx = auth.WithRealIdentity(ctx, real)
		}
		rec := httptest.NewRecorder()
		s.requireAdmin(h).ServeHTTP(rec, req.WithContext(ctx))
		return rec
	}

	admin := &auth.Identity{UserID: uuid.New(), IsAdmin: true}
	nonAdmin := &auth.Identity{UserID: uuid.New(), IsAdmin: false}

	if rec := guard(admin, nil); rec.Code != http.StatusOK {
		t.Errorf("admin (no warp) = %d, want 200", rec.Code)
	}
	if rec := guard(nonAdmin, nil); rec.Code != http.StatusForbidden {
		t.Errorf("non-admin = %d, want 403", rec.Code)
	}
	// Warped: effective identity is a non-admin target, but the REAL identity
	// is the admin — requireAdmin must consult the real one and allow.
	if rec := guard(nonAdmin, admin); rec.Code != http.StatusOK {
		t.Errorf("warped admin = %d, want 200 (real identity gates)", rec.Code)
	}
	// Warped into an admin by a non-admin real user must still be denied.
	if rec := guard(admin, nonAdmin); rec.Code != http.StatusForbidden {
		t.Errorf("non-admin real warped into admin = %d, want 403", rec.Code)
	}
}
