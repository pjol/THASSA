// Package notify creates in-app notifications and fans them out over the
// websocket (user:{id} channel). Push delivery (Expo/APNs) can plug in later
// via the push_tokens table without touching call sites.
package notify

import (
	"context"

	"github.com/google/uuid"

	"github.com/pjol/THASSA/backend/internal/store"
)

// Kinds (spec §6.4 / §5 microcopy).
const (
	KindMarketMatched = "market.matched" // "Your bet was taken."
	KindMarketSettled = "market.settled"
	KindOrderFilled   = "order.filled"
	KindDMMessage     = "dm.message"
	KindPostLiked     = "post.liked"
	KindFollowRequest = "follow.request"
	KindFollowAccept  = "follow.accepted"
	KindNewFollower   = "follow.new"
)

// Sender delivers realtime frames to a user — implemented by bus.Fanout so
// notifications reach WS connections on every instance (spec §6.7).
type Sender interface {
	SendToUser(userID uuid.UUID, typ string, payload any)
}

// Service persists notifications and pushes them over the realtime bus.
type Service struct {
	db     *store.Store
	sender Sender
}

func New(db *store.Store, sender Sender) *Service {
	return &Service{db: db, sender: sender}
}

// Notify stores + fans out a single notification (best-effort on the WS leg).
func (s *Service) Notify(ctx context.Context, userID uuid.UUID, kind string, payload map[string]any) {
	if payload == nil {
		payload = map[string]any{}
	}
	n, err := s.db.InsertNotification(ctx, userID, kind, payload)
	if err != nil {
		return
	}
	s.sender.SendToUser(userID, kind, n)
}

// NotifyMany fans a notification out to several users.
func (s *Service) NotifyMany(ctx context.Context, userIDs []uuid.UUID, kind string, payload map[string]any) {
	seen := map[uuid.UUID]bool{}
	for _, u := range userIDs {
		if u == uuid.Nil || seen[u] {
			continue
		}
		seen[u] = true
		s.Notify(ctx, u, kind, payload)
	}
}
