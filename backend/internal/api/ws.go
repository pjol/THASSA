package api

import (
	"context"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"

	"github.com/pjol/THASSA/backend/internal/auth"
)

var wsUpgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	// Auth is enforced by the token middleware before the upgrade; native
	// clients send no meaningful Origin.
	CheckOrigin: func(_ *http.Request) bool { return true },
}

// handleWS upgrades to the single realtime socket (spec §6.4). It runs inside
// the authed group (Authorization header or ?token=), so the identity is
// already resolved. Channel subscriptions (dm:/book:/user:) are authorized in
// canJoinChannel with the CONNECTION's authenticated user (§8.1).
func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	id, ok := auth.FromContext(r.Context())
	if !ok {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	c := s.hub.Add(conn, id.UserID)
	// Blocks until the socket closes. Read receipts persist via the store.
	s.hub.ReadPump(r.Context(), c, func(ctx context.Context, userID uuid.UUID, channel string) {
		if convID, err := uuid.Parse(strings.TrimPrefix(channel, "dm:")); err == nil {
			_ = s.db.MarkConversationRead(ctx, convID, userID)
		}
	})
	s.hub.Remove(c)
}

// canJoinChannel authorizes ws subscribe frames:
//   - dm:{conversationId}: conversation membership (DB-checked);
//   - book:{marketId}: public market data — any authenticated user;
//   - user:{id}: only the owner (enforced in the hub itself).
func (s *Server) canJoinChannel(ctx context.Context, userID uuid.UUID, channel string) bool {
	switch {
	case strings.HasPrefix(channel, "dm:"):
		convID, err := uuid.Parse(strings.TrimPrefix(channel, "dm:"))
		if err != nil {
			return false
		}
		ok, err := s.db.IsConversationMember(ctx, convID, userID)
		return err == nil && ok
	case strings.HasPrefix(channel, "book:"):
		marketID, err := uuid.Parse(strings.TrimPrefix(channel, "book:"))
		if err != nil {
			return false
		}
		m, err := s.db.MarketSummaryByID(ctx, marketID)
		return err == nil && m != nil
	}
	return false
}
