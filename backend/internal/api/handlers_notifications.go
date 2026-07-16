package api

import (
	"net/http"

	"github.com/google/uuid"

	"github.com/pjol/THASSA/backend/internal/auth"
	"github.com/pjol/THASSA/backend/internal/respond"
)

// handleListNotifications lists the caller's notifications (cursor-paginated).
func (s *Server) handleListNotifications(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	opts, ok := feedOpts(w, r, 30)
	if !ok {
		return
	}
	notifications, next, err := s.db.Notifications(r.Context(), id.UserID, opts)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to load notifications")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"notifications": notifications, "next_cursor": next})
}

type markReadRequest struct {
	IDs []string `json:"ids"` // empty = mark all read
}

// handleMarkNotificationsRead stamps the given ids (§8.1: scoped to the token
// user inside the UPDATE) or all when none given.
func (s *Server) handleMarkNotificationsRead(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req markReadRequest
	if err := respond.Decode(r, &req); err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid body")
		return
	}
	ids := make([]uuid.UUID, 0, len(req.IDs))
	for _, raw := range req.IDs {
		nid, err := uuid.Parse(raw)
		if err != nil {
			respond.Error(w, http.StatusBadRequest, "invalid notification id")
			return
		}
		ids = append(ids, nid)
	}
	if err := s.db.MarkNotificationsRead(r.Context(), id.UserID, ids); err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to mark read")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"ok": true})
}
