// Package leader elects fleet singletons (relayer batcher, settlement
// submitter) via Postgres advisory locks (spec §6.7): exactly one holder per
// lock name across all instances; the rest stay hot-standby and re-try.
package leader

import (
	"context"
	"hash/fnv"

	"github.com/jackc/pgx/v5/pgxpool"
)

// LockID derives the stable 64-bit advisory lock id for a worker name
// (namespaced so different workers never collide on the same lock).
func LockID(name string) int64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte("thassa:leader:" + name))
	return int64(h.Sum64())
}

// Elector holds (or tries to hold) one advisory lock on a dedicated pooled
// connection. Session-scoped locks release automatically when the connection
// drops, so a crashed leader loses leadership without cleanup.
type Elector struct {
	pool *pgxpool.Pool
	name string
	id   int64
	conn *pgxpool.Conn
}

func New(pool *pgxpool.Pool, name string) *Elector {
	return &Elector{pool: pool, name: name, id: LockID(name)}
}

// TryAcquire attempts to become (or confirm being) the leader. Non-blocking.
func (e *Elector) TryAcquire(ctx context.Context) (bool, error) {
	if e.conn != nil {
		// Verify the held connection is still alive; a dead connection means
		// the session lock is gone and leadership was lost.
		if err := e.conn.Ping(ctx); err != nil {
			e.Release()
		} else {
			return true, nil
		}
	}
	conn, err := e.pool.Acquire(ctx)
	if err != nil {
		return false, err
	}
	var got bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, e.id).Scan(&got); err != nil {
		conn.Release()
		return false, err
	}
	if !got {
		conn.Release()
		return false, nil
	}
	e.conn = conn
	return true, nil
}

// Release gives up leadership (unlocks + returns the connection).
func (e *Elector) Release() {
	if e.conn == nil {
		return
	}
	_, _ = e.conn.Exec(context.Background(), `SELECT pg_advisory_unlock($1)`, e.id)
	e.conn.Release()
	e.conn = nil
}
