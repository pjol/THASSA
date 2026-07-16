package bus

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const pgChannel = "thassa_events"

// PGBus implements Bus over Postgres LISTEN/NOTIFY. NOTIFY payloads are
// limited to ~8KB; realtime frames are compact (ids + small payloads), and
// oversized events are dropped with a log line rather than failing the caller.
type PGBus struct {
	pool *pgxpool.Pool
}

func NewPG(pool *pgxpool.Pool) *PGBus { return &PGBus{pool: pool} }

func (b *PGBus) Publish(ctx context.Context, e Event) error {
	payload, err := json.Marshal(e)
	if err != nil {
		return err
	}
	if len(payload) > 7500 {
		log.Printf("bus: dropping oversized event on %s (%d bytes)", e.Channel, len(payload))
		return nil
	}
	_, err = b.pool.Exec(ctx, `SELECT pg_notify($1, $2)`, pgChannel, string(payload))
	return err
}

func (b *PGBus) Subscribe(ctx context.Context, fn func(Event)) error {
	go func() {
		for ctx.Err() == nil {
			if err := b.listen(ctx, fn); err != nil && ctx.Err() == nil {
				log.Printf("bus: listen error, reconnecting: %v", err)
				select {
				case <-time.After(2 * time.Second):
				case <-ctx.Done():
					return
				}
			}
		}
	}()
	return nil
}

// listen holds a dedicated connection in LISTEN mode until it errors or the
// context ends.
func (b *PGBus) listen(ctx context.Context, fn func(Event)) error {
	conn, err := b.pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, `LISTEN `+pgChannel); err != nil {
		return err
	}
	for {
		n, err := conn.Conn().WaitForNotification(ctx)
		if err != nil {
			return err
		}
		var e Event
		if json.Unmarshal([]byte(n.Payload), &e) == nil {
			fn(e)
		}
	}
}

func (b *PGBus) Close() error { return nil }
