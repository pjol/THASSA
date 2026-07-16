package api

import (
	"errors"
	"fmt"
	"net/http"
	"path"
	"regexp"
	"time"

	"github.com/google/uuid"

	"github.com/pjol/THASSA/backend/internal/auth"
	"github.com/pjol/THASSA/backend/internal/notify"
	"github.com/pjol/THASSA/backend/internal/respond"
	"github.com/pjol/THASSA/backend/internal/store"
	"github.com/pjol/THASSA/backend/internal/structs"
)

// handleGetMe returns the caller's own profile.
func (s *Server) handleGetMe(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	me, err := s.db.GetMe(r.Context(), id.UserID)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to load profile")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"user": me})
}

var usernameRE = regexp.MustCompile(`^[a-z0-9_.]{3,30}$`)

type updateMeRequest struct {
	Username    *string        `json:"username"`
	DisplayName *string        `json:"display_name"`
	Bio         *string        `json:"bio"`
	AvatarURL   *string        `json:"avatar_url"`
	Links       []structs.Link `json:"links"`
}

// handleUpdateMe applies profile edits (username, bio, links, avatar).
func (s *Server) handleUpdateMe(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req updateMeRequest
	if err := respond.Decode(r, &req); err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid body")
		return
	}
	if req.Username != nil && !usernameRE.MatchString(*req.Username) {
		respond.Error(w, http.StatusBadRequest, "username must be 3-30 chars: a-z 0-9 _ .")
		return
	}
	if req.Bio != nil && len(*req.Bio) > 500 {
		respond.Error(w, http.StatusBadRequest, "bio too long")
		return
	}
	if len(req.Links) > 10 {
		respond.Error(w, http.StatusBadRequest, "too many links")
		return
	}
	err := s.db.UpdateMe(r.Context(), id.UserID, store.UpdateMeParams{
		Username:    req.Username,
		DisplayName: req.DisplayName,
		Bio:         req.Bio,
		AvatarURL:   req.AvatarURL,
		Links:       req.Links,
	})
	if errors.Is(err, store.ErrUsernameTaken) {
		respond.Error(w, http.StatusConflict, "username taken")
		return
	}
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to update profile")
		return
	}
	me, err := s.db.GetMe(r.Context(), id.UserID)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to load profile")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"user": me})
}

type updateSettingsRequest struct {
	IsPrivate        *bool   `json:"is_private"`
	TradesVisibility *string `json:"trades_visibility"`
}

// handleUpdateSettings toggles account privacy + trades visibility.
func (s *Server) handleUpdateSettings(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req updateSettingsRequest
	if err := respond.Decode(r, &req); err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid body")
		return
	}
	if req.TradesVisibility != nil && *req.TradesVisibility != "public" && *req.TradesVisibility != "private" {
		respond.Error(w, http.StatusBadRequest, "trades_visibility must be public or private")
		return
	}
	if err := s.db.UpdateSettings(r.Context(), id.UserID, req.IsPrivate, req.TradesVisibility); err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to update settings")
		return
	}
	me, err := s.db.GetMe(r.Context(), id.UserID)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to load profile")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"user": me})
}

type setAvatarRequest struct {
	MediaID *string `json:"media_id"`
	URL     *string `json:"url"`
}

// handleSetAvatar sets the avatar from an uploaded media id (preferred) or a
// previously-presigned public URL.
func (s *Server) handleSetAvatar(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req setAvatarRequest
	if err := respond.Decode(r, &req); err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid body")
		return
	}
	var url string
	switch {
	case req.MediaID != nil:
		mid, err := uuid.Parse(*req.MediaID)
		if err != nil {
			respond.Error(w, http.StatusBadRequest, "invalid media id")
			return
		}
		media, ownerID, _, err := s.db.GetMedia(r.Context(), mid)
		if err != nil || media == nil {
			respond.Error(w, http.StatusNotFound, "media not found")
			return
		}
		if ownerID != id.UserID { // §8.1: ownership from the token id only
			respond.Error(w, http.StatusNotFound, "media not found")
			return
		}
		url = media.URL
	case req.URL != nil && *req.URL != "":
		url = *req.URL
	default:
		respond.Error(w, http.StatusBadRequest, "media_id or url required")
		return
	}
	if err := s.db.SetAvatar(r.Context(), id.UserID, url); err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to set avatar")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"avatar_url": url})
}

// handleBadges returns the bottom-bar counters.
func (s *Server) handleBadges(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	notifications, messages, err := s.db.Badges(r.Context(), id.UserID)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to load badges")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{
		"badges": map[string]int{"notifications": notifications, "messages": messages},
	})
}

// handleListFollowRequests lists pending requests to follow the caller.
func (s *Server) handleListFollowRequests(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	reqs, err := s.db.FollowRequests(r.Context(), id.UserID)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to list follow requests")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"follow_requests": reqs})
}

func (s *Server) handleApproveFollowRequest(w http.ResponseWriter, r *http.Request) {
	s.resolveFollowRequest(w, r, true)
}

func (s *Server) handleDenyFollowRequest(w http.ResponseWriter, r *http.Request) {
	s.resolveFollowRequest(w, r, false)
}

func (s *Server) resolveFollowRequest(w http.ResponseWriter, r *http.Request, approve bool) {
	id, _ := auth.FromContext(r.Context())
	reqID, err := uuid.Parse(chiParam(r, "id"))
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid request id")
		return
	}
	// §8.1: the UPDATE/DELETE is scoped to followee_id = token user.
	followerID, ok, err := s.db.ResolveFollowRequest(r.Context(), reqID, id.UserID, approve)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to resolve follow request")
		return
	}
	if !ok {
		respond.Error(w, http.StatusNotFound, "follow request not found")
		return
	}
	if approve {
		s.notify(r, followerID, notify.KindFollowAccept, map[string]any{"user_id": id.UserID})
	}
	respond.JSON(w, http.StatusOK, map[string]any{"ok": true, "approved": approve})
}

type pushTokenRequest struct {
	Token    string `json:"token"`
	Platform string `json:"platform"`
}

// handleRegisterPushToken stores a device push token.
func (s *Server) handleRegisterPushToken(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req pushTokenRequest
	if err := respond.Decode(r, &req); err != nil || req.Token == "" {
		respond.Error(w, http.StatusBadRequest, "invalid body")
		return
	}
	if req.Platform == "" {
		req.Platform = "expo"
	}
	if err := s.db.RegisterPushToken(r.Context(), id.UserID, req.Token, req.Platform); err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to register push token")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleRemovePushToken deletes the caller's push token.
func (s *Server) handleRemovePushToken(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req pushTokenRequest
	if err := respond.Decode(r, &req); err != nil || req.Token == "" {
		respond.Error(w, http.StatusBadRequest, "invalid body")
		return
	}
	// §8.1: delete is scoped to the token's owner.
	if _, err := s.pool.Exec(r.Context(),
		`DELETE FROM push_tokens WHERE token=$1 AND user_id=$2`, req.Token, id.UserID); err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to remove push token")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

// notify persists + fans out via the bus (works across instances).
func (s *Server) notify(r *http.Request, userID uuid.UUID, kind string, payload map[string]any) {
	n, err := s.db.InsertNotification(r.Context(), userID, kind, payload)
	if err != nil {
		return
	}
	s.fanout.SendToUser(userID, kind, n)
}

// uploadKey builds an unguessable object key: {scope}/{userID}/{unixnano}-{uuid}{ext}.
func uploadKey(scope string, userID uuid.UUID, filename string) string {
	ext := path.Ext(filename)
	if len(ext) > 10 {
		ext = ""
	}
	return fmt.Sprintf("%s/%s/%d-%s%s", scope, userID, time.Now().UnixNano(), uuid.NewString(), ext)
}
