// Command seed populates a dev database with demo users, follows, posts,
// stories, markets, orders, fills, positions, and conversations. Usable
// without any chain access via SEED_SKIP_CHAIN=true (default): markets get
// fake chain ids and mirrored book state, so the app is fully browsable.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math/rand"
	"os"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pjol/THASSA/backend/internal/config"
	"github.com/pjol/THASSA/backend/internal/db"
	"github.com/pjol/THASSA/backend/internal/sources"
)

type seedUser struct {
	id       uuid.UUID
	username string
	wallet   string
	private  bool
}

func main() {
	cfg := config.Load()
	skipChain := os.Getenv("SEED_SKIP_CHAIN") != "false" // default true
	ctx := context.Background()

	pool, err := db.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("db connect: %v", err)
	}
	defer pool.Close()
	if err := db.Migrate(ctx, pool); err != nil {
		log.Fatalf("migrate: %v", err)
	}

	registry := sources.Default()
	rng := rand.New(rand.NewSource(42))

	// --- users ---------------------------------------------------------------
	names := []struct {
		username, display, bio string
		private                bool
	}{
		{"maren", "Maren Voss", "surf forecasts + sports takes", false},
		{"kai", "Kai Ito", "onchain since 2019", false},
		{"petra", "Petra Lund", "weather nerd ⛈️", false},
		{"diego", "Diego Sol", "crypto markets, mostly wrong", false},
		{"nova", "Nova Reyes", "private account, public losses", true},
		{"sasha", "Sasha Kim", "news junkie", false},
	}
	users := make([]seedUser, 0, len(names))
	for i, n := range names {
		wallet := fmt.Sprintf("0x%040x", i+1)
		var id uuid.UUID
		err := pool.QueryRow(ctx, `
			INSERT INTO users (privy_did, wallet_address, username, display_name, bio, is_private, trades_visibility)
			VALUES ($1,$2,$3,$4,$5,$6,$7)
			ON CONFLICT (privy_did) DO UPDATE SET username=EXCLUDED.username
			RETURNING id`,
			"did:privy:seed-"+n.username, wallet, n.username, n.display, n.bio, n.private,
			map[bool]string{true: "private", false: "public"}[n.username == "diego"],
		).Scan(&id)
		if err != nil {
			log.Fatalf("seed user %s: %v", n.username, err)
		}
		users = append(users, seedUser{id: id, username: n.username, wallet: wallet, private: n.private})
	}

	// --- follows (nova is private: one accepted, one pending) ----------------
	follow := func(a, b int, status string) {
		_, err := pool.Exec(ctx, `
			INSERT INTO follows (follower_id, followee_id, status) VALUES ($1,$2,$3)
			ON CONFLICT (follower_id, followee_id) DO UPDATE SET status=$3`,
			users[a].id, users[b].id, status)
		if err != nil {
			log.Fatalf("seed follow: %v", err)
		}
	}
	follow(0, 1, "accepted")
	follow(0, 2, "accepted")
	follow(1, 0, "accepted")
	follow(2, 0, "accepted")
	follow(3, 0, "accepted")
	follow(0, 4, "accepted") // maren may see nova
	follow(1, 4, "pending")  // kai's request pending
	follow(5, 3, "accepted")

	// --- markets --------------------------------------------------------------
	type seedMarket struct {
		title, question string
		category        string
		status          string
		direction       *bool
		yes, no         int
		volume          int64
	}
	yes := true
	markets := []seedMarket{
		{"Lakers to win Friday", "Will the Los Angeles Lakers beat the Warriors on 2026-07-18?", "sports", "MATCHED", nil, 62, 40, 1_250_000_000},
		{"BTC above $150k", "Will the Coinbase BTC-USD spot price exceed $150,000 at any time before 2026-08-01?", "price", "OPEN", nil, 41, 60, 0},
		{"SF heatwave", "Will the NWS-reported high temperature in San Francisco exceed 90°F on 2026-07-20?", "weather", "SETTLED", &yes, 0, 0, 800_000_000},
		{"Fed cuts in September", "Will the Federal Reserve announce an interest-rate cut at its September 2026 meeting?", "news", "OPEN", nil, 55, 47, 0},
	}
	marketIDs := make([]uuid.UUID, len(markets))
	for i, m := range markets {
		sq, sqJSON, err := registry.BuildSettlementQuery(m.question, m.category)
		if err != nil {
			log.Fatal(err)
		}
		srcJSON, _ := json.Marshal(sq.Sources)
		var chainID *int64
		if skipChain {
			cid := int64(1000 + i)
			chainID = &cid
		}
		err = pool.QueryRow(ctx, `
			INSERT INTO markets (chain_market_id, creator_id, title, question, settlement_query,
				category, rule, sources, status, direction, yes_price_cents, no_price_cents, volume)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULLIF($11,0),NULLIF($12,0),$13)
			ON CONFLICT (chain_market_id) DO UPDATE SET status=EXCLUDED.status
			RETURNING id`,
			chainID, users[i%len(users)].id, m.title, m.question, sqJSON,
			sq.Category, sq.Rule, srcJSON, m.status, m.direction, m.yes, m.no, m.volume,
		).Scan(&marketIDs[i])
		if err != nil {
			log.Fatalf("seed market: %v", err)
		}
	}

	// --- orders / fills / positions -------------------------------------------
	for i, mid := range marketIDs {
		if markets[i].status == "SETTLED" {
			continue
		}
		for j := 0; j < 4; j++ {
			u := users[(i+j)%len(users)]
			side := []string{"yes", "no"}[j%2]
			price := 30 + rng.Intn(40)
			shares := int64(5 + rng.Intn(50))
			var orderID uuid.UUID
			err := pool.QueryRow(ctx, `
				INSERT INTO orders (market_id, user_id, side, price_cents, shares, filled_shares,
					status, chain_order_id, maker_address, max_cost, nonce, order_digest)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
				mid, u.id, side, price, shares, shares/2,
				map[bool]string{true: "PARTIAL", false: "RESTING"}[j == 0],
				int64(i*10+j+1), u.wallet, shares*int64(price)*10_000, int64(j),
				fmt.Sprintf("0xseed%036d", i*10+j)).Scan(&orderID)
			if err != nil {
				log.Fatalf("seed order: %v", err)
			}
			if j == 0 {
				_, _ = pool.Exec(ctx, `
					INSERT INTO fills (market_id, taker_order_id, taker_chain_order_id, maker_chain_order_id,
						price_cents, shares, fee, tx_hash, log_index)
					VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
					mid, orderID, int64(i*10+j+1), int64(i*10+j+2), price, shares/2,
					int64(price*(100-price))*(shares/2)*7/100, fmt.Sprintf("0xseedtx%d%d", i, j), j)
				_, _ = pool.Exec(ctx, `
					INSERT INTO positions (market_id, user_id, side, shares, avg_price_cents)
					VALUES ($1,$2,$3,$4,$5)
					ON CONFLICT (market_id, user_id, side) DO UPDATE SET shares=EXCLUDED.shares`,
					mid, u.id, side, shares/2, price)
			}
		}
	}
	// Settled market: winner + loser positions with realized pnl.
	_, _ = pool.Exec(ctx, `
		INSERT INTO positions (market_id, user_id, side, shares, avg_price_cents, realized_pnl)
		VALUES ($1,$2,'yes',20,45,11000000), ($1,$3,'no',20,55,-11000000)
		ON CONFLICT (market_id, user_id, side) DO NOTHING`,
		marketIDs[2], users[2].id, users[3].id)

	// --- posts (some with markets) ---------------------------------------------
	captions := []string{
		"golden hour at ocean beach 🌊", "who's taking my bet?", "heatwave incoming, positioned accordingly",
		"courtside tonight", "gm", "thoughts on the fed?",
	}
	for i, c := range captions {
		u := users[i%len(users)]
		var marketID *uuid.UUID
		if i%2 == 1 {
			marketID = &marketIDs[i%len(marketIDs)]
		}
		var postID uuid.UUID
		if err := pool.QueryRow(ctx, `
			INSERT INTO posts (author_id, caption, kind, market_id, like_count)
			VALUES ($1,$2,$3,$4,$5) RETURNING id`,
			u.id, c, []string{"photo", "photo", "video", "reel"}[i%4], marketID, rng.Intn(40),
		).Scan(&postID); err != nil {
			log.Fatalf("seed post: %v", err)
		}
		_, _ = pool.Exec(ctx, `
			INSERT INTO post_media (owner_id, post_id, position, kind, s3_key, status, width, height)
			VALUES ($1,$2,0,$3,$4,'ready',1080,1350)`,
			u.id, postID, map[bool]string{true: "video", false: "image"}[i%4 >= 2],
			fmt.Sprintf("media/%s/seed-%d.jpg", u.id, i))
		_, _ = pool.Exec(ctx, `
			INSERT INTO comments (post_id, author_id, body) VALUES ($1,$2,$3)`,
			postID, users[(i+1)%len(users)].id, "love this 🔥")
	}

	// --- stories ----------------------------------------------------------------
	for i := 0; i < 3; i++ {
		u := users[i]
		_, _ = pool.Exec(ctx, `
			INSERT INTO stories (author_id, kind, s3_key, width, height, expires_at)
			VALUES ($1,'image',$2,1080,1920,$3)`,
			u.id, fmt.Sprintf("media/%s/story-%d.jpg", u.id, i), time.Now().Add(20*time.Hour))
	}

	// --- conversations ------------------------------------------------------------
	var convID uuid.UUID
	if err := pool.QueryRow(ctx,
		`INSERT INTO conversations (kind) VALUES ('dm') RETURNING id`).Scan(&convID); err == nil {
		for _, u := range users[:2] {
			_, _ = pool.Exec(ctx, `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, convID, u.id)
		}
		lines := []string{"yo, did you see the lakers market?", "taking the yes side rn", "bold. i'm fading you"}
		for i, l := range lines {
			_, _ = pool.Exec(ctx, `INSERT INTO messages (conversation_id, sender_id, body) VALUES ($1,$2,$3)`,
				convID, users[i%2].id, l)
		}
	}

	countRows(ctx, pool)
	log.Printf("seed complete (skip_chain=%v)", skipChain)
}

func countRows(ctx context.Context, pool *pgxpool.Pool) {
	for _, t := range []string{"users", "follows", "posts", "markets", "orders", "positions", "messages", "stories"} {
		var n int
		_ = pool.QueryRow(ctx, "SELECT count(*) FROM "+t).Scan(&n)
		log.Printf("  %-10s %d", t, n)
	}
}
