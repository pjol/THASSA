package ws

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

// §8.1 cross-user access: a connection may never subscribe to another user's
// notification channel, and dm/book subscriptions must pass the server-side
// CanJoin check with the CONNECTION's authenticated user — the client-claimed
// channel string is never trusted.
func TestSubscribeAuthorization(t *testing.T) {
	hub := NewHub()
	me := uuid.New()
	other := uuid.New()
	myDM := uuid.New()
	foreignDM := uuid.New()

	// CanJoin simulates the DB membership check: only myDM is joinable by me.
	hub.CanJoin = func(_ context.Context, userID uuid.UUID, channel string) bool {
		return userID == me && channel == "dm:"+myDM.String()
	}

	c := &Conn{userID: me, channels: map[string]struct{}{}, send: make(chan []byte, 1)}
	hub.mu.Lock()
	hub.conns[me] = map[*Conn]struct{}{c: {}}
	hub.mu.Unlock()

	ctx := context.Background()
	if !hub.subscribe(ctx, c, "dm:"+myDM.String()) {
		t.Fatal("member must be able to join their own dm channel")
	}
	if hub.subscribe(ctx, c, "dm:"+foreignDM.String()) {
		t.Fatal("non-member must NOT join a foreign dm channel")
	}
	if hub.subscribe(ctx, c, "user:"+other.String()) {
		t.Fatal("must NOT join another user's notification channel")
	}
	if !hub.subscribe(ctx, c, "user:"+me.String()) {
		t.Fatal("own user channel must be joinable")
	}
	if hub.subscribe(ctx, c, "admin:everything") {
		t.Fatal("unknown channel grammar must be rejected")
	}
	if hub.subscribe(ctx, c, "dm:not-a-uuid") {
		t.Fatal("malformed channel ids must be rejected")
	}
}

func TestPublishReachesOnlySubscribers(t *testing.T) {
	hub := NewHub()
	me := uuid.New()
	dm := uuid.New()
	hub.CanJoin = func(context.Context, uuid.UUID, string) bool { return true }

	sub := &Conn{userID: me, channels: map[string]struct{}{}, send: make(chan []byte, 4)}
	lurker := &Conn{userID: uuid.New(), channels: map[string]struct{}{}, send: make(chan []byte, 4)}
	hub.mu.Lock()
	hub.conns[sub.userID] = map[*Conn]struct{}{sub: {}}
	hub.conns[lurker.userID] = map[*Conn]struct{}{lurker: {}}
	hub.mu.Unlock()

	if !hub.subscribe(context.Background(), sub, "dm:"+dm.String()) {
		t.Fatal("subscribe failed")
	}
	hub.Publish("dm:"+dm.String(), "message.new", map[string]any{"x": 1})

	select {
	case <-sub.send:
	default:
		t.Fatal("subscriber did not receive the frame")
	}
	select {
	case <-lurker.send:
		t.Fatal("non-subscriber received the frame")
	default:
	}
}
