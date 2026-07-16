// Package bus is the cross-instance pub/sub abstraction (spec §6.7): realtime
// events (WS fanout) go through Publish/Subscribe so an event produced on
// instance B reaches a websocket connected to instance A.
//
// Drivers: pg (Postgres LISTEN/NOTIFY, default — zero extra infra in dev) and
// redis (go-redis pub/sub). Selected via BUS_DRIVER.
package bus

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
)

// Event is the envelope carried on the bus. Channel follows the WS channel
// grammar (user:{id}, dm:{id}, book:{id}); Type is the frame type.
type Event struct {
	Channel string          `json:"channel"`
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

// Bus is the broker abstraction.
type Bus interface {
	// Publish sends an event to every instance (including the caller's own).
	Publish(ctx context.Context, e Event) error
	// Subscribe registers the delivery callback and starts the receive loop
	// (returns immediately; the loop runs until ctx is cancelled).
	Subscribe(ctx context.Context, fn func(Event)) error
	// Close releases driver resources.
	Close() error
}

// LocalDeliverer is what the bus delivers into on each instance — implemented
// by the ws hub bridge.
type LocalDeliverer interface {
	Publish(channel, typ string, payload any)
	SendToUser(userID uuid.UUID, typ string, payload any)
}

// Fanout is the produce side used by handlers/workers: it marshals payloads
// and publishes to the bus (never directly to the local hub, so behavior is
// identical with 1 or N instances).
type Fanout struct {
	bus Bus
}

func NewFanout(b Bus) *Fanout { return &Fanout{bus: b} }

// Publish emits {type, channel, payload} to all instances.
func (f *Fanout) Publish(channel, typ string, payload any) {
	b, err := json.Marshal(payload)
	if err != nil {
		return
	}
	_ = f.bus.Publish(context.Background(), Event{Channel: channel, Type: typ, Payload: b})
}

// SendToUser targets a user's own channel.
func (f *Fanout) SendToUser(userID uuid.UUID, typ string, payload any) {
	f.Publish("user:"+userID.String(), typ, payload)
}

// Bridge wires bus events into the local ws hub. Call once per instance.
func Bridge(ctx context.Context, b Bus, local LocalDeliverer) error {
	return b.Subscribe(ctx, func(e Event) {
		var payload any
		if len(e.Payload) > 0 {
			_ = json.Unmarshal(e.Payload, &payload)
		}
		if id, ok := userChannel(e.Channel); ok {
			local.SendToUser(id, e.Type, payload)
			return
		}
		local.Publish(e.Channel, e.Type, payload)
	})
}

func userChannel(ch string) (uuid.UUID, bool) {
	const p = "user:"
	if len(ch) > len(p) && ch[:len(p)] == p {
		if id, err := uuid.Parse(ch[len(p):]); err == nil {
			return id, true
		}
	}
	return uuid.Nil, false
}
