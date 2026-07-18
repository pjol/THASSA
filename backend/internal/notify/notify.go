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
	// Social batch (spec §7d).
	KindPostMention         = "post.mention"           // tagged in a post caption
	KindPositionSwing       = "position.swing"         // own position moved >50%
	KindFollowingLargeEntry = "following.large_entry"  // a followee's big entry
	KindPostCommented       = "post.commented"
)

// Categories are the user-facing notification toggle groups
// (Settings → Notifications; users.notification_prefs keys).
var Categories = []string{"likes", "comments", "mentions", "follows", "messages", "markets", "trading"}

// CategoryOf maps a notification kind to its settings category. Kinds outside
// every category (admin/system) return "" and are always delivered.
func CategoryOf(kind string) string {
	switch kind {
	case KindPostLiked:
		return "likes"
	case KindPostCommented:
		return "comments"
	case KindPostMention:
		return "mentions"
	case KindNewFollower, KindFollowRequest, KindFollowAccept:
		return "follows"
	case KindDMMessage:
		return "messages"
	case KindMarketMatched, KindMarketSettled, KindOrderFilled, "market.open", "order.rejected":
		return "markets"
	case KindPositionSwing, KindFollowingLargeEntry:
		return "trading"
	}
	return ""
}

// Sender delivers realtime frames to a user — implemented by bus.Fanout so
// notifications reach WS connections on every instance (spec §6.7).
type Sender interface {
	SendToUser(userID uuid.UUID, typ string, payload any)
}

// Pusher is the optional push-notification leg (spec §7d.4), implemented by
// push.Service. It is best-effort and non-blocking on its own.
type Pusher interface {
	Push(userID uuid.UUID, kind string, payload map[string]any)
}

// Service persists notifications and delivers them over the realtime bus (WS)
// and, when configured, the push leg (Expo).
type Service struct {
	db     *store.Store
	sender Sender
	pusher Pusher
}

func New(db *store.Store, sender Sender, pusher Pusher) *Service {
	return &Service{db: db, sender: sender, pusher: pusher}
}

// Notify stores + fans out a single notification: WS fanout first, then the
// (best-effort, non-blocking) push leg (spec §7d.4). A kind whose settings
// category the user has toggled off is dropped entirely — not stored, not
// fanned out, not pushed.
func (s *Service) Notify(ctx context.Context, userID uuid.UUID, kind string, payload map[string]any) {
	if c := CategoryOf(kind); c != "" && !s.db.NotificationCategoryEnabled(ctx, userID, c) {
		return
	}
	if payload == nil {
		payload = map[string]any{}
	}
	n, err := s.db.InsertNotification(ctx, userID, kind, payload)
	if err != nil {
		return
	}
	s.sender.SendToUser(userID, kind, n)
	if s.pusher != nil {
		s.pusher.Push(userID, kind, payload)
	}
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
