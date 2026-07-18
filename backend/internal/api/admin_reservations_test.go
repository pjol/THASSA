package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"

	"github.com/pjol/THASSA/backend/internal/auth"
)

// TestAdminReservationAuth verifies the username-reservation endpoints are
// gated on the REAL identity via requireAdmin (spec §7c): a non-admin never
// reaches the handler, an admin passes the gate, and a warp cannot escalate a
// non-admin real user into the admin routes.
func TestAdminReservationAuth(t *testing.T) {
	s := &Server{}
	reached := false
	probe := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		reached = true
		w.WriteHeader(http.StatusOK)
	})
	handler := s.requireAdmin(probe)

	call := func(effective, real *auth.Identity) (int, bool) {
		reached = false
		req := httptest.NewRequest(http.MethodPost, "/v1/admin/username-reservations", nil)
		ctx := auth.WithIdentity(req.Context(), effective)
		if real != nil {
			ctx = auth.WithRealIdentity(ctx, real)
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req.WithContext(ctx))
		return rec.Code, reached
	}

	admin := &auth.Identity{UserID: uuid.New(), IsAdmin: true}
	nonAdmin := &auth.Identity{UserID: uuid.New(), IsAdmin: false}

	if code, hit := call(nonAdmin, nil); code != http.StatusForbidden || hit {
		t.Errorf("non-admin: code=%d reached=%v, want 403 and not reached", code, hit)
	}
	if code, hit := call(admin, nil); code != http.StatusOK || !hit {
		t.Errorf("admin: code=%d reached=%v, want 200 and reached", code, hit)
	}
	// Warped: effective target is a non-admin, but the REAL user is the admin —
	// the gate consults the real identity and allows.
	if code, hit := call(nonAdmin, admin); code != http.StatusOK || !hit {
		t.Errorf("warped admin: code=%d reached=%v, want 200 and reached", code, hit)
	}
	// A non-admin real user warped into an admin must still be denied.
	if code, hit := call(admin, nonAdmin); code != http.StatusForbidden || hit {
		t.Errorf("non-admin real into admin: code=%d reached=%v, want 403 and not reached", code, hit)
	}
}
