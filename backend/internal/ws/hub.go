// Package ws implements the single realtime socket (/v1/ws): a gorilla
// websocket per client with channel-based subscribe frames per spec §6.4:
//
//	dm:{conversationId}   message.new, typing.start/stop, read
//	book:{marketId}       order-book deltas + trades
//	user:{me}             notifications + wallet/order state changes
//
// Frames are JSON {type, channel, payload}. Subscriptions to dm:* channels
// are authorized via the CanJoin callback (conversation membership).
package ws

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

// Frame is the wire shape in both directions.
type Frame struct {
	Type    string          `json:"type"`
	Channel string          `json:"channel,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// Hub fans events out to connected clients by channel. A user may hold
// several connections (multiple devices); each connection is auto-subscribed
// to its own user:{id} channel.
type Hub struct {
	mu    sync.RWMutex
	conns map[uuid.UUID]map[*Conn]struct{}   // by user
	subs  map[string]map[*Conn]struct{}      // by channel

	// CanJoin authorizes channel subscriptions (dm membership etc.). Nil
	// denies everything except the caller's own user channel.
	CanJoin func(ctx context.Context, userID uuid.UUID, channel string) bool
}

// NewHub constructs an empty hub.
func NewHub() *Hub {
	return &Hub{
		conns: map[uuid.UUID]map[*Conn]struct{}{},
		subs:  map[string]map[*Conn]struct{}{},
	}
}

// Conn is one client socket.
type Conn struct {
	ws       *websocket.Conn
	send     chan []byte
	userID   uuid.UUID
	channels map[string]struct{}
}

// UserID returns the authenticated owner of the connection.
func (c *Conn) UserID() uuid.UUID { return c.userID }

const (
	writeWait  = 10 * time.Second
	pongWait   = 60 * time.Second
	pingPeriod = 50 * time.Second
)

// Add registers a freshly-upgraded socket and returns the Conn. The caller
// must then run c.ReadPump (blocking) and the hub handles the write pump.
func (h *Hub) Add(ws *websocket.Conn, userID uuid.UUID) *Conn {
	c := &Conn{ws: ws, send: make(chan []byte, 64), userID: userID, channels: map[string]struct{}{}}
	h.mu.Lock()
	if h.conns[userID] == nil {
		h.conns[userID] = map[*Conn]struct{}{}
	}
	h.conns[userID][c] = struct{}{}
	// Auto-subscribe to the caller's own notification channel.
	own := "user:" + userID.String()
	if h.subs[own] == nil {
		h.subs[own] = map[*Conn]struct{}{}
	}
	h.subs[own][c] = struct{}{}
	c.channels[own] = struct{}{}
	h.mu.Unlock()
	go c.writePump()
	return c
}

// Remove drops a connection and all its subscriptions.
func (h *Hub) Remove(c *Conn) {
	h.mu.Lock()
	for ch := range c.channels {
		if set := h.subs[ch]; set != nil {
			delete(set, c)
			if len(set) == 0 {
				delete(h.subs, ch)
			}
		}
	}
	if set := h.conns[c.userID]; set != nil {
		delete(set, c)
		if len(set) == 0 {
			delete(h.conns, c.userID)
		}
	}
	h.mu.Unlock()
	close(c.send)
	_ = c.ws.Close()
}

// subscribe joins a channel after authorization.
func (h *Hub) subscribe(ctx context.Context, c *Conn, channel string) bool {
	if !validChannel(channel) {
		return false
	}
	// user:* is restricted to the owner; everything else goes through CanJoin.
	if strings.HasPrefix(channel, "user:") {
		if channel != "user:"+c.userID.String() {
			return false
		}
	} else if h.CanJoin == nil || !h.CanJoin(ctx, c.userID, channel) {
		return false
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.subs[channel] == nil {
		h.subs[channel] = map[*Conn]struct{}{}
	}
	h.subs[channel][c] = struct{}{}
	c.channels[channel] = struct{}{}
	return true
}

func (h *Hub) unsubscribe(c *Conn, channel string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if strings.HasPrefix(channel, "user:") {
		return // own channel is permanent
	}
	if set := h.subs[channel]; set != nil {
		delete(set, c)
		if len(set) == 0 {
			delete(h.subs, channel)
		}
	}
	delete(c.channels, channel)
}

func validChannel(ch string) bool {
	for _, p := range []string{"dm:", "book:", "user:"} {
		if strings.HasPrefix(ch, p) {
			_, err := uuid.Parse(strings.TrimPrefix(ch, p))
			return err == nil
		}
	}
	return false
}

// Publish sends {type, channel, payload} to every channel subscriber
// (best-effort, non-blocking; slow consumers drop frames).
func (h *Hub) Publish(channel, typ string, payload any) {
	b, err := marshalFrame(typ, channel, payload)
	if err != nil {
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.subs[channel] {
		select {
		case c.send <- b:
		default:
		}
	}
}

// PublishExcept is Publish minus one connection (e.g. the typing sender).
func (h *Hub) PublishExcept(channel, typ string, payload any, except *Conn) {
	b, err := marshalFrame(typ, channel, payload)
	if err != nil {
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.subs[channel] {
		if c == except {
			continue
		}
		select {
		case c.send <- b:
		default:
		}
	}
}

// SendToUser targets every live connection of a user (their user:{id} channel
// plus direct conns, covering multi-device).
func (h *Hub) SendToUser(userID uuid.UUID, typ string, payload any) {
	channel := "user:" + userID.String()
	b, err := marshalFrame(typ, channel, payload)
	if err != nil {
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.conns[userID] {
		select {
		case c.send <- b:
		default:
		}
	}
}

func marshalFrame(typ, channel string, payload any) ([]byte, error) {
	pb, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	return json.Marshal(Frame{Type: typ, Channel: channel, Payload: pb})
}

// ReadPump processes inbound frames until the socket closes. Supported client
// frames: subscribe/unsubscribe {channel}, typing.start/typing.stop on a dm
// channel (relayed to the other members), and read receipts.
func (h *Hub) ReadPump(ctx context.Context, c *Conn, onRead func(ctx context.Context, userID uuid.UUID, channel string)) {
	c.ws.SetReadLimit(4096)
	_ = c.ws.SetReadDeadline(time.Now().Add(pongWait))
	c.ws.SetPongHandler(func(string) error {
		return c.ws.SetReadDeadline(time.Now().Add(pongWait))
	})
	for {
		_, data, err := c.ws.ReadMessage()
		if err != nil {
			return
		}
		var f Frame
		if json.Unmarshal(data, &f) != nil {
			continue
		}
		switch f.Type {
		case "subscribe":
			ok := h.subscribe(ctx, c, f.Channel)
			b, _ := marshalFrame("subscribed", f.Channel, map[string]any{"ok": ok})
			select {
			case c.send <- b:
			default:
			}
		case "unsubscribe":
			h.unsubscribe(c, f.Channel)
		case "typing.start", "typing.stop":
			// Only relay typing on dm channels the sender has joined (join
			// implies membership was checked).
			if strings.HasPrefix(f.Channel, "dm:") {
				h.mu.RLock()
				_, joined := c.channels[f.Channel]
				h.mu.RUnlock()
				if joined {
					h.PublishExcept(f.Channel, f.Type, map[string]any{"user_id": c.userID}, c)
				}
			}
		case "read":
			if strings.HasPrefix(f.Channel, "dm:") && onRead != nil {
				h.mu.RLock()
				_, joined := c.channels[f.Channel]
				h.mu.RUnlock()
				if joined {
					onRead(ctx, c.userID, f.Channel)
					h.PublishExcept(f.Channel, "read", map[string]any{"user_id": c.userID}, c)
				}
			}
		}
	}
}

func (c *Conn) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer ticker.Stop()
	for {
		select {
		case msg, ok := <-c.send:
			_ = c.ws.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				_ = c.ws.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.ws.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			_ = c.ws.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.ws.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
