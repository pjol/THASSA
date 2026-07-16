// Package store is the query/repository layer. All SQL lives here, grouped by
// domain (users.go, posts.go, markets.go, …). HTTP handlers depend on this
// package and contain no SQL of their own.
package store

import (
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// URLResolver turns stored object keys into public serving URLs (S3/MinIO in
// production, this server's /uploads/* in dev).
type URLResolver interface {
	PublicURL(key string) string
}

type Store struct {
	pool *pgxpool.Pool
	urls URLResolver
}

func New(pool *pgxpool.Pool, urls URLResolver) *Store {
	return &Store{pool: pool, urls: urls}
}

// Pool exposes the underlying pool for the few call sites (ws auth, workers)
// that still operate at the connection level.
func (s *Store) Pool() *pgxpool.Pool { return s.pool }

func (s *Store) url(key string) string {
	if key == "" || s.urls == nil {
		return key
	}
	return s.urls.PublicURL(key)
}

func (s *Store) urlPtr(key *string) *string {
	if key == nil {
		return nil
	}
	u := s.url(*key)
	return &u
}

// visiblePred returns a SQL predicate: the viewer (bind param viewerParam,
// e.g. "$2") may see content authored by authorCol (e.g. "p.author_id").
// Private-account enforcement lives here, at the query layer: content of a
// private account is visible only to the owner and accepted followers.
func visiblePred(authorCol, viewerParam string) string {
	return fmt.Sprintf(`(%[1]s = %[2]s
		OR NOT EXISTS (SELECT 1 FROM users vu WHERE vu.id = %[1]s AND vu.is_private)
		OR EXISTS (SELECT 1 FROM follows vf
		           WHERE vf.follower_id = %[2]s AND vf.followee_id = %[1]s AND vf.status = 'accepted'))`,
		authorCol, viewerParam)
}

// tradesVisiblePred returns a SQL predicate: the viewer may see the trading
// data (positions, fills, PnL) of authorCol. Owner always sees own; otherwise
// the account itself must be visible AND trades_visibility must be 'public'.
func tradesVisiblePred(authorCol, viewerParam string) string {
	return fmt.Sprintf(`(%[1]s = %[2]s OR (
		(SELECT tu.trades_visibility FROM users tu WHERE tu.id = %[1]s) = 'public'
		AND %[3]s))`, authorCol, viewerParam, visiblePred(authorCol, viewerParam))
}
