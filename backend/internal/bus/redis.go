package bus

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
)

const redisChannel = "thassa:events"

// RedisBus implements Bus over Redis pub/sub (BUS_DRIVER=redis).
type RedisBus struct {
	client *redis.Client
}

// NewRedis dials Redis from a URL (redis://host:port/db) and verifies
// connectivity.
func NewRedis(ctx context.Context, url string) (*RedisBus, error) {
	opts, err := redis.ParseURL(url)
	if err != nil {
		return nil, err
	}
	client := redis.NewClient(opts)
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := client.Ping(pingCtx).Err(); err != nil {
		return nil, err
	}
	return &RedisBus{client: client}, nil
}

func (b *RedisBus) Publish(ctx context.Context, e Event) error {
	payload, err := json.Marshal(e)
	if err != nil {
		return err
	}
	return b.client.Publish(ctx, redisChannel, payload).Err()
}

func (b *RedisBus) Subscribe(ctx context.Context, fn func(Event)) error {
	sub := b.client.Subscribe(ctx, redisChannel)
	// Force the subscription to be established before returning.
	if _, err := sub.Receive(ctx); err != nil {
		return err
	}
	ch := sub.Channel()
	go func() {
		defer sub.Close()
		for {
			select {
			case msg, ok := <-ch:
				if !ok {
					if ctx.Err() == nil {
						log.Printf("bus: redis subscription closed")
					}
					return
				}
				var e Event
				if json.Unmarshal([]byte(msg.Payload), &e) == nil {
					fn(e)
				}
			case <-ctx.Done():
				return
			}
		}
	}()
	return nil
}

func (b *RedisBus) Close() error { return b.client.Close() }
