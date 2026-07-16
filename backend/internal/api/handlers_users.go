package api

import (
	"net/http"

	"github.com/google/uuid"

	"github.com/pjol/THASSA/backend/internal/auth"
	"github.com/pjol/THASSA/backend/internal/notify"
	"github.com/pjol/THASSA/backend/internal/respond"
)

// handleGetUser returns a user page. Trades visibility is reflected in the
// payload; a private account's counts are public but content is not.
func (s *Server) handleGetUser(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	p, err := s.db.GetProfileByUsername(r.Context(), id.UserID, chiParam(r, "username"))
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to load user")
		return
	}
	if p == nil {
		respond.Error(w, http.StatusNotFound, "user not found")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"user": p})
}

// handleUserPosts returns a user's grid. The visibility predicate inside the
// query hides a private account's posts from non-approved viewers; we surface
// that as an explicit 403 for a cleaner client experience.
func (s *Server) handleUserPosts(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	targetID, ok := s.userIDByUsername(w, r)
	if !ok {
		return
	}
	canView, err := s.db.CanViewUser(r.Context(), id.UserID, targetID)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to load posts")
		return
	}
	if !canView {
		respond.Error(w, http.StatusForbidden, "this account is private")
		return
	}
	opts, ok := feedOpts(w, r, 24)
	if !ok {
		return
	}
	posts, next, err := s.db.UserPosts(r.Context(), id.UserID, targetID, opts)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to load posts")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"posts": posts, "next_cursor": next})
}

// handleUserTrades returns a user's fills + settled PnL. 403 when the target
// keeps trades private (owner always sees own) or the account itself is not
// visible to the viewer (spec §6.2).
func (s *Server) handleUserTrades(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	targetID, ok := s.userIDByUsername(w, r)
	if !ok {
		return
	}
	canView, err := s.db.CanViewTrades(r.Context(), id.UserID, targetID)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to load trades")
		return
	}
	if !canView {
		respond.Error(w, http.StatusForbidden, "this user's trades are private")
		return
	}
	opts, ok := feedOpts(w, r, 30)
	if !ok {
		return
	}
	trades, next, err := s.db.UserTrades(r.Context(), targetID, opts)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to load trades")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"trades": trades, "next_cursor": next})
}

// handleFollowers / handleFollowing list the social graph (only accepted
// edges; a private account's lists require visibility).
func (s *Server) handleFollowers(w http.ResponseWriter, r *http.Request) {
	s.followList(w, r, true)
}

func (s *Server) handleFollowing(w http.ResponseWriter, r *http.Request) {
	s.followList(w, r, false)
}

func (s *Server) followList(w http.ResponseWriter, r *http.Request, followers bool) {
	id, _ := auth.FromContext(r.Context())
	targetID, ok := s.userIDByUsername(w, r)
	if !ok {
		return
	}
	canView, err := s.db.CanViewUser(r.Context(), id.UserID, targetID)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to load list")
		return
	}
	if !canView {
		respond.Error(w, http.StatusForbidden, "this account is private")
		return
	}
	limit := parseLimit(r, 50)
	if followers {
		users, err := s.db.Followers(r.Context(), targetID, limit)
		if err != nil {
			respond.Error(w, http.StatusInternalServerError, "failed to load followers")
			return
		}
		respond.JSON(w, http.StatusOK, map[string]any{"followers": users})
		return
	}
	users, err := s.db.Following(r.Context(), targetID, limit)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to load following")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"following": users})
}

// handleFollow follows a user (pending when the target is private).
func (s *Server) handleFollow(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	targetID, err := uuid.Parse(chiParam(r, "id"))
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid user id")
		return
	}
	if targetID == id.UserID {
		respond.Error(w, http.StatusBadRequest, "cannot follow yourself")
		return
	}
	status, err := s.db.Follow(r.Context(), id.UserID, targetID)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to follow")
		return
	}
	kind := notify.KindNewFollower
	if status == "pending" {
		kind = notify.KindFollowRequest
	}
	s.notify(r, targetID, kind, map[string]any{"user_id": id.UserID})
	respond.JSON(w, http.StatusOK, map[string]any{"status": status})
}

// handleUnfollow removes the follow (or cancels a pending request).
func (s *Server) handleUnfollow(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	targetID, err := uuid.Parse(chiParam(r, "id"))
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid user id")
		return
	}
	if err := s.db.Unfollow(r.Context(), id.UserID, targetID); err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to unfollow")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) userIDByUsername(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	targetID, err := s.db.UserIDByUsername(r.Context(), chiParam(r, "username"))
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to resolve user")
		return uuid.Nil, false
	}
	if targetID == uuid.Nil {
		respond.Error(w, http.StatusNotFound, "user not found")
		return uuid.Nil, false
	}
	return targetID, true
}
