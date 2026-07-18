package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/pjol/THASSA/backend/internal/auth"
	"github.com/pjol/THASSA/backend/internal/respond"
	"github.com/pjol/THASSA/backend/internal/store"
)

// handleAdminSearchUsers searches users by email or username (spec §7c.2).
// Real-admin-gated via requireAdmin; never warp-affected.
func (s *Server) handleAdminSearchUsers(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	users, err := s.db.AdminSearchUsers(r.Context(), q, 25)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to search users")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"users": users})
}

type adminWarpRequest struct {
	UserID string `json:"user_id"`
}

// handleAdminWarp validates the target user exists and returns its summary.
// This is a UX convenience — the X-Thassa-Warp header is the real mechanism
// (spec §7c.2). Uses the REAL admin identity (requireAdmin already gated it).
func (s *Server) handleAdminWarp(w http.ResponseWriter, r *http.Request) {
	var req adminWarpRequest
	if err := respond.Decode(r, &req); err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid body")
		return
	}
	targetID, err := uuid.Parse(strings.TrimSpace(req.UserID))
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid user id")
		return
	}
	target, err := s.db.AdminUserSummary(r.Context(), targetID)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to load user")
		return
	}
	if target == nil {
		respond.Error(w, http.StatusNotFound, "user not found")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"user": target})
}

// handleAdminUnwarp is a server-side no-op (spec §7c.2): the client simply
// drops the X-Thassa-Warp header. Exists so the client has an endpoint to call.
func (s *Server) handleAdminUnwarp(w http.ResponseWriter, _ *http.Request) {
	respond.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleAdminListReservations lists/searches the username whitelist (spec §7c).
// Real-admin-gated via requireAdmin.
func (s *Server) handleAdminListReservations(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	rows, err := s.db.ListUsernameReservations(r.Context(), q, 100)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to list reservations")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"reservations": rows})
}

type adminReservationRequest struct {
	Username string `json:"username"`
	Email    string `json:"email"`
}

// handleAdminUpsertReservation whitelists an email for a username (spec §7c).
// Validates the username format + lowercases both fields, then upserts. Returns
// 409 with an admin-facing message when the username is already in use.
func (s *Server) handleAdminUpsertReservation(w http.ResponseWriter, r *http.Request) {
	real, _ := auth.RealIdentity(r.Context()) // requireAdmin already gated
	var req adminReservationRequest
	if err := respond.Decode(r, &req); err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid body")
		return
	}
	username := strings.ToLower(strings.TrimSpace(req.Username))
	email := strings.ToLower(strings.TrimSpace(req.Email))
	if !usernameRE.MatchString(username) {
		respond.Error(w, http.StatusBadRequest, "username must be 1-30 chars: a-z 0-9 _ .")
		return
	}
	if !strings.Contains(email, "@") || len(email) < 3 {
		respond.Error(w, http.StatusBadRequest, "enter a valid email")
		return
	}
	row, err := s.db.UpsertUsernameReservation(r.Context(), username, email, real.UserID)
	if errors.Is(err, store.ErrUsernameInUse) {
		respond.Error(w, http.StatusConflict, "that username is already in use by a user — you can't whitelist it")
		return
	}
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to save reservation")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"reservation": row})
}

// handleAdminDeleteReservation removes a whitelist entry (spec §7c). The name
// reverts to default rules (still reserved-by-default when 1–4 chars).
func (s *Server) handleAdminDeleteReservation(w http.ResponseWriter, r *http.Request) {
	username := strings.ToLower(strings.TrimSpace(chiParam(r, "username")))
	if username == "" {
		respond.Error(w, http.StatusBadRequest, "username required")
		return
	}
	ok, err := s.db.DeleteUsernameReservation(r.Context(), username)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to delete reservation")
		return
	}
	if !ok {
		respond.Error(w, http.StatusNotFound, "reservation not found")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"ok": true})
}
