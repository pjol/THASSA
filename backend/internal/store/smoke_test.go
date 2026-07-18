package store

import (
	"context"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TestQuerySmoke exercises every read query against a real (dev) database so
// SQL/scan drift — added columns, renamed fields, arity mismatches — surfaces
// as a test failure instead of a runtime 500. Skipped unless SMOKE_DATABASE_URL
// is set:
//
//	SMOKE_DATABASE_URL=postgres://... go test ./internal/store -run TestQuerySmoke
func TestQuerySmoke(t *testing.T) {
	dsn := os.Getenv("SMOKE_DATABASE_URL")
	if dsn == "" {
		t.Skip("SMOKE_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()
	s := New(pool, nil)

	// Any seed user works; fall back to a random id (queries must still run).
	var uid uuid.UUID
	if err := pool.QueryRow(ctx,
		`SELECT id FROM users ORDER BY created_at LIMIT 1`).Scan(&uid); err != nil {
		uid = uuid.New()
	}
	var mid uuid.UUID
	_ = pool.QueryRow(ctx, `SELECT id FROM markets LIMIT 1`).Scan(&mid)
	var pid uuid.UUID
	_ = pool.QueryRow(ctx, `SELECT id FROM posts LIMIT 1`).Scan(&pid)
	var cid uuid.UUID
	_ = pool.QueryRow(ctx, `SELECT conversation_id FROM conversation_members WHERE user_id=$1 LIMIT 1`, uid).Scan(&cid)

	check := func(name string, err error) {
		t.Helper()
		if err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}

	_, _, err = s.Feed(ctx, uid, FeedOpts{Limit: 10})
	check("Feed", err)
	_, _, err = s.ExplorePosts(ctx, uid, FeedOpts{Limit: 10})
	check("ExplorePosts", err)
	_, err = s.ExploreMarkets(ctx, 10, 0, "active", "trending")
	check("ExploreMarkets(active,trending)", err)
	_, err = s.ExploreMarkets(ctx, 10, 0, "all", "volume")
	check("ExploreMarkets(all,volume)", err)
	_, err = s.ExploreMarkets(ctx, 10, 0, "settled", "newest")
	check("ExploreMarkets(settled,newest)", err)
	_, err = s.SearchMarkets(ctx, "lakers", 10)
	check("SearchMarkets", err)
	_, err = s.SearchGeneratedCandidates(ctx, "lakers", 5)
	check("SearchGeneratedCandidates", err)
	_, err = s.SearchUsers(ctx, "ma", 10)
	check("SearchUsers", err)
	_, err = s.GetMe(ctx, uid)
	check("GetMe", err)
	_, _, err = s.UserPosts(ctx, uid, uid, FeedOpts{Limit: 10})
	check("UserPosts", err)
	_, _, err = s.UserTrades(ctx, uid, FeedOpts{Limit: 10})
	check("UserTrades", err)
	_, err = s.CanViewTrades(ctx, uid, uid)
	check("CanViewTrades", err)
	_, err = s.Conversations(ctx, uid, 10, 3, 10)
	check("Conversations", err)
	if cid != uuid.Nil {
		_, _, err = s.Messages(ctx, cid, FeedOpts{Limit: 20})
		check("Messages", err)
	}
	if mid != uuid.Nil {
		_, err = s.GetMarket(ctx, uid, mid)
		check("GetMarket", err)
		_, err = s.MarketBook(ctx, mid)
		check("MarketBook", err)
		_, err = s.MarketSummaryByID(ctx, mid)
		check("MarketSummaryByID", err)
	}
	if pid != uuid.Nil {
		_, err = s.GetPost(ctx, uid, pid)
		check("GetPost", err)
	}
	_, _, err = s.Notifications(ctx, uid, FeedOpts{Limit: 20})
	check("Notifications", err)
	_, err = s.ActiveStories(ctx, uid)
	check("ActiveStories", err)
}
