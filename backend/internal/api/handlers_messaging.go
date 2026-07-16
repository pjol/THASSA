package api

import (
	"net/http"

	"github.com/google/uuid"

	"github.com/pjol/THASSA/backend/internal/auth"
	"github.com/pjol/THASSA/backend/internal/notify"
	"github.com/pjol/THASSA/backend/internal/respond"
)

// handleListConversations lists the caller's threads; the top conversations
// inline their most recent messages so the client can pre-fetch threads for
// instant open (spec §6.3).
func (s *Server) handleListConversations(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	conversations, err := s.db.Conversations(r.Context(), id.UserID, parseLimit(r, 30), 8, 25)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to list conversations")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"conversations": conversations})
}

type createConversationRequest struct {
	Kind      string   `json:"kind"` // dm | group (dm default)
	MemberIDs []string `json:"member_ids"`
}

// handleCreateConversation starts (or reuses, for DMs) a thread. §8.1: the
// creator is always the token user.
func (s *Server) handleCreateConversation(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req createConversationRequest
	if err := respond.Decode(r, &req); err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid body")
		return
	}
	if req.Kind == "" {
		req.Kind = "dm"
	}
	if req.Kind != "dm" && req.Kind != "group" {
		respond.Error(w, http.StatusBadRequest, "kind must be dm or group")
		return
	}
	if len(req.MemberIDs) == 0 || len(req.MemberIDs) > 50 {
		respond.Error(w, http.StatusBadRequest, "conversations need 1-50 other members")
		return
	}
	memberIDs := make([]uuid.UUID, 0, len(req.MemberIDs))
	for _, m := range req.MemberIDs {
		mid, err := uuid.Parse(m)
		if err != nil {
			respond.Error(w, http.StatusBadRequest, "invalid member id")
			return
		}
		memberIDs = append(memberIDs, mid)
	}
	convID, err := s.db.GetOrCreateConversation(r.Context(), id.UserID, req.Kind, memberIDs)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to create conversation")
		return
	}
	respond.JSON(w, http.StatusCreated, map[string]any{"id": convID})
}

// requireMembership gates a conversation route on the caller's membership
// (§8.1: checked in the query against the token user id).
func (s *Server) requireMembership(w http.ResponseWriter, r *http.Request) (uuid.UUID, uuid.UUID, bool) {
	id, _ := auth.FromContext(r.Context())
	convID, err := uuid.Parse(chiParam(r, "id"))
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid conversation id")
		return uuid.Nil, uuid.Nil, false
	}
	ok, err := s.db.IsConversationMember(r.Context(), convID, id.UserID)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "membership check failed")
		return uuid.Nil, uuid.Nil, false
	}
	if !ok {
		respond.Error(w, http.StatusForbidden, "not a member of this conversation")
		return uuid.Nil, uuid.Nil, false
	}
	return convID, id.UserID, true
}

// handleListMessages returns a thread's messages (cursor-paginated).
func (s *Server) handleListMessages(w http.ResponseWriter, r *http.Request) {
	convID, userID, ok := s.requireMembership(w, r)
	if !ok {
		return
	}
	_ = userID
	opts, ok := feedOpts(w, r, 50)
	if !ok {
		return
	}
	messages, next, err := s.db.Messages(r.Context(), convID, opts)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to load messages")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"messages": messages, "next_cursor": next})
}

type sendMessageRequest struct {
	Body      *string `json:"body"`
	MediaID   *string `json:"media_id"`
	ReplyToID *string `json:"reply_to_id"`
}

// handleSendMessage sends text and/or one media attachment, fanning out over
// the bus to the dm channel + member notification channels.
func (s *Server) handleSendMessage(w http.ResponseWriter, r *http.Request) {
	convID, userID, ok := s.requireMembership(w, r)
	if !ok {
		return
	}
	var req sendMessageRequest
	if err := respond.Decode(r, &req); err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid body")
		return
	}
	if (req.Body == nil || *req.Body == "") && (req.MediaID == nil || *req.MediaID == "") {
		respond.Error(w, http.StatusBadRequest, "message needs text or media")
		return
	}
	if req.Body != nil && len(*req.Body) > 4000 {
		respond.Error(w, http.StatusBadRequest, "message too long")
		return
	}
	var mediaID, replyToID *uuid.UUID
	if req.MediaID != nil && *req.MediaID != "" {
		mid, err := uuid.Parse(*req.MediaID)
		if err != nil {
			respond.Error(w, http.StatusBadRequest, "invalid media id")
			return
		}
		mediaID = &mid
	}
	if req.ReplyToID != nil && *req.ReplyToID != "" {
		rid, err := uuid.Parse(*req.ReplyToID)
		if err != nil {
			respond.Error(w, http.StatusBadRequest, "invalid reply id")
			return
		}
		replyToID = &rid
	}

	msg, err := s.db.SendMessage(r.Context(), convID, userID, req.Body, mediaID, replyToID)
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "failed to send message")
		return
	}

	// Realtime: dm channel (thread views) + per-user notifications.
	s.fanout.Publish("dm:"+convID.String(), "message.new", msg)
	if memberIDs, err := s.db.ConversationMemberIDs(r.Context(), convID); err == nil {
		preview := "📷 Media"
		if req.Body != nil && *req.Body != "" {
			preview = *req.Body
			if len(preview) > 120 {
				preview = preview[:120] + "…"
			}
		}
		for _, m := range memberIDs {
			if m == userID {
				continue
			}
			s.notify(r, m, notify.KindDMMessage, map[string]any{
				"conversation_id": convID, "message_id": msg.ID,
				"sender_id": userID, "preview": preview,
			})
		}
	}
	respond.JSON(w, http.StatusCreated, map[string]any{"message": msg})
}

// handleMarkConversationRead stamps the caller's read pointer and pushes the
// read receipt to the thread.
func (s *Server) handleMarkConversationRead(w http.ResponseWriter, r *http.Request) {
	convID, userID, ok := s.requireMembership(w, r)
	if !ok {
		return
	}
	if err := s.db.MarkConversationRead(r.Context(), convID, userID); err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to mark read")
		return
	}
	s.fanout.Publish("dm:"+convID.String(), "read", map[string]any{"user_id": userID})
	respond.JSON(w, http.StatusOK, map[string]any{"ok": true})
}
