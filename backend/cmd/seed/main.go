// Command seed populates a dev database with a comprehensive, all-feature set
// of demo data so every screen in the app is browsable/demoable, and can tear
// that data back out again — leaving any real data (and the DB volume) intact.
//
// Usage (both invoked by boot.sh):
//
//	go run ./cmd/seed          seed: idempotently tear down prior seed data, then
//	                           insert a fresh set (re-running never duplicates).
//	go run ./cmd/seed --down   teardown only: delete exactly the seeded data.
//
// TAGGING. Every seeded user gets a recognizable privy_did of the form
// "seed:<slug>". Real users authenticate through Privy and have DIDs like
// "did:privy:…", so `privy_did LIKE 'seed:%'` uniquely identifies seed users.
// Teardown deletes those users; almost every owned row is reached by ON DELETE
// CASCADE from users(id). The two exceptions are handled explicitly first:
//   - conversations have no user FK (only conversation_members/messages cascade),
//     so seeded conversations are deleted directly.
//   - username_reservations.created_by is ON DELETE SET NULL (not CASCADE), so
//     seeded reservation rows are deleted by their known usernames.
//
// Teardown is a no-op when nothing is seeded and never touches non-seed rows.
//
// The whole up-flow (teardown + insert) runs in ONE transaction, so a re-seed is
// atomic: a mid-insert failure rolls back to the pre-run state rather than
// leaving the DB half-cleared.
//
// Chain access is never required: with SEED_SKIP_CHAIN=true (the boot.sh
// default) markets get fake chain ids and mirrored book state (prices, orders,
// fills, positions), so order books and PnL render without an indexer.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math/rand"
	"os"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pjol/THASSA/backend/internal/config"
	"github.com/pjol/THASSA/backend/internal/db"
	"github.com/pjol/THASSA/backend/internal/sources"
	"github.com/pjol/THASSA/backend/internal/structs"
)

// reservedUsernames are the username_reservations rows this seeder inserts. They
// are the teardown tag for that table (created_by is SET-NULL, not CASCADE, so
// the rows are not removed by deleting the seed users).
var reservedUsernames = []string{"thassa", "founder"}

func main() {
	down := flag.Bool("down", false, "tear down seeded data only, then exit")
	flag.Parse()

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

	tx, err := pool.Begin(ctx)
	if err != nil {
		log.Fatalf("begin: %v", err)
	}
	// On any log.Fatal below the process exits and the uncommitted tx is rolled
	// back by the server; on the happy path we Commit explicitly.
	defer tx.Rollback(ctx)

	s := &seeder{ctx: ctx, tx: tx, rng: rand.New(rand.NewSource(42)),
		registry: sources.Default(), skipChain: skipChain}

	if *down {
		s.teardown()
		if err := tx.Commit(ctx); err != nil {
			log.Fatalf("commit: %v", err)
		}
		log.Printf("seed teardown complete (removed all privy_did LIKE 'seed:%%')")
		return
	}

	// On-chain deployment target (nil ⇒ fake-chain markets only). Built before
	// seeding so seedUsers can back a few seed users with real funded wallets.
	if !skipChain {
		s.deployer = newLiveDeployer(ctx, cfg, pool, parseFundedKeys(cfg))
	}

	// Up-flow: tear down any prior seed data first (idempotent), then insert.
	s.teardown()
	s.seed()
	if err := tx.Commit(ctx); err != nil {
		log.Fatalf("commit: %v", err)
	}

	// Second phase (post-commit): create the live OPEN/MATCHED markets for real
	// on-chain and mirror them into the now-committed DB, replacing their
	// fake-chain placeholder books. Best-effort — a failure keeps the fake book.
	if s.deployer != nil {
		s.deployer.deployAll(s.livePlans)
	}

	s.summary(ctx, pool)
	log.Printf("seed complete (skip_chain=%v, on_chain=%v)", skipChain, s.deployer != nil)
}

type seeder struct {
	ctx       context.Context
	tx        pgx.Tx
	rng       *rand.Rand
	registry  *sources.Registry
	skipChain bool

	users   []seedUser
	markets []seedMarket
	posts   []uuid.UUID

	// On-chain deployment (nil ⇒ fake-chain markets only). livePlans records the
	// OPEN/MATCHED markets to create for real after commit.
	deployer  *liveDeployer
	livePlans []liveMarketPlan
}

type seedUser struct {
	id       uuid.UUID
	username string
	wallet   string
	private  bool
}

type seedMarket struct {
	id     uuid.UUID
	status string
	title  string
}

// exec/queryID are thin fatal-on-error helpers so the body reads linearly; a
// failure aborts the process and the transaction rolls back.
func (s *seeder) exec(sql string, args ...any) {
	if _, err := s.tx.Exec(s.ctx, sql, args...); err != nil {
		log.Fatalf("exec failed: %v\n  sql: %s", err, strings.TrimSpace(sql))
	}
}

func (s *seeder) queryID(sql string, args ...any) uuid.UUID {
	var id uuid.UUID
	if err := s.tx.QueryRow(s.ctx, sql, args...).Scan(&id); err != nil {
		log.Fatalf("queryID failed: %v\n  sql: %s", err, strings.TrimSpace(sql))
	}
	return id
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

// teardown removes exactly the seeded data. Order matters only for the two
// tables not reached by user-cascade (conversations, username_reservations);
// everything else falls out of the final DELETE FROM users via ON DELETE
// CASCADE. Safe to run when nothing is seeded.
func (s *seeder) teardown() {
	const seedUsers = `(SELECT id FROM users WHERE privy_did LIKE 'seed:%')`

	// 1. Conversations have no user FK — delete any conversation that has a seed
	//    member (cascades conversation_members + messages). Must run before the
	//    user delete, which would otherwise orphan them.
	s.exec(`DELETE FROM conversations WHERE id IN (
		SELECT conversation_id FROM conversation_members WHERE user_id IN ` + seedUsers + `)`)

	// 2. username_reservations.created_by is ON DELETE SET NULL, so the rows
	//    survive a user delete. Remove the ones this seeder inserts, by username.
	s.exec(`DELETE FROM username_reservations WHERE username = ANY($1)`, reservedUsernames)

	// 3. markets.settle_requested_by is a plain NO ACTION FK, and its check
	//    trigger can fire before the creator-cascade removes the market when the
	//    requesting user happens to be deleted first — so clear the reference
	//    up front rather than relying on in-statement cascade order.
	s.exec(`UPDATE markets SET settle_requested_by = NULL WHERE settle_requested_by IN ` + seedUsers)

	// 4. Delete the seed users. CASCADE handles the rest:
	//    follows, posts (+post_media, post_mentions, comments, comment_mentions),
	//    markets (+orders, fills, positions, market comments), stories
	//    (+story_views), likes, reactions, notifications, push_tokens, api_keys,
	//    onramp_sessions, market_generation_logs, user_entry_stats,
	//    follow_entry_agg, idempotency_keys, conversation_members, messages.
	s.exec(`DELETE FROM users WHERE privy_did LIKE 'seed:%'`)
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

func (s *seeder) seed() {
	s.seedUsers()
	s.seedUsernameReservations()
	s.seedFollows()
	s.seedMarkets()
	s.seedBook()
	s.seedPosts()
	s.seedStories()
	s.seedConversations()
	s.seedNotifications()
	s.seedDevSurfaces()
	s.reconcile()
}

func ptr[T any](v T) *T { return &v }

// utf16Len returns the number of UTF-16 code units in s — the offset unit used
// by post/comment @-mention start/len (spec §7d.2), matching the mobile client's
// string indexing. ASCII prefixes count 1 each; astral emoji count 2.
func utf16Len(s string) int { return len(utf16.Encode([]rune(s))) }

// mentionsFor scans caption for each "@<username>" token and returns the wire
// [{user_id,start,len}] payload with correct UTF-16 offsets.
func mentionsFor(caption string, subs map[string]uuid.UUID) []structs.MentionInput {
	var out []structs.MentionInput
	for name, id := range subs {
		tok := "@" + name
		idx := strings.Index(caption, tok)
		if idx < 0 {
			continue
		}
		out = append(out, structs.MentionInput{
			UserID: id,
			Start:  utf16Len(caption[:idx]),
			Len:    utf16Len(tok),
		})
	}
	return out
}

func jsonb(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		log.Fatalf("marshal: %v", err)
	}
	return b
}

// --- users -----------------------------------------------------------------

func (s *seeder) seedUsers() {
	type u struct {
		username string
		display  *string // nil ⇒ username-only profile (no display name)
		bio      *string
		avatar   *string // nil ⇒ no avatar (initial/placeholder path)
		links    []string
		private  bool
		trades   string // 'public' | 'private'
		email    *string
		verified bool
	}
	rows := []u{
		{"maren", ptr("Maren Voss"), ptr("surf forecasts + sports takes 🏄"), ptr("https://i.pravatar.cc/300?u=maren"),
			[]string{"https://maren.example", "https://twitter.com/maren"}, false, "public", ptr("peej@thassa.example"), true},
		{"kai", ptr("Kai Ito"), ptr("onchain since 2019"), ptr("https://i.pravatar.cc/300?u=kai"),
			[]string{"https://kai.dev"}, false, "public", nil, false},
		{"petra", ptr("Petra Lund"), ptr("weather nerd ⛈️"), ptr("https://i.pravatar.cc/300?u=petra"),
			nil, false, "public", nil, false},
		{"diego", ptr("Diego Sol"), ptr("crypto markets, mostly wrong"), ptr("https://i.pravatar.cc/300?u=diego"),
			nil, false, "private", nil, false}, // public account, private trades
		{"nova", ptr("Nova Reyes"), ptr("private account, public losses"), ptr("https://i.pravatar.cc/300?u=nova"),
			nil, true, "public", nil, false}, // private account
		{"sasha", ptr("Sasha Kim"), ptr("news junkie"), ptr("https://i.pravatar.cc/300?u=sasha"),
			[]string{"https://sasha.news"}, false, "public", nil, false},
		{"tomo", nil, ptr("just here for the reels"), ptr("https://i.pravatar.cc/300?u=tomo"),
			nil, false, "public", nil, false}, // username-only (no display name)
		{"lena", nil, nil, nil, // username-only, no bio, no avatar
			nil, false, "public", nil, false},
		{"bex", ptr("Bex Arnold"), ptr("locked down 🔒"), ptr("https://i.pravatar.cc/300?u=bex"),
			nil, true, "public", nil, false}, // second private account
		{"juno", nil, ptr("weekend degen"), ptr("https://i.pravatar.cc/300?u=juno"),
			[]string{"https://juno.gg"}, false, "public", nil, false}, // username-only
		{"rafe", ptr("Rafe Mercer"), ptr("courtside most nights"), ptr("https://i.pravatar.cc/300?u=rafe"),
			nil, false, "public", nil, false},
		{"ivy", ptr("Ivy Chen"), ptr("markets + macro"), ptr("https://i.pravatar.cc/300?u=ivy"),
			[]string{"https://ivy.capital"}, false, "public", ptr("ivy@thassa.example"), true},
	}
	s.users = make([]seedUser, 0, len(rows))
	for i, r := range rows {
		// Back a few seed users with real funded dev wallets when deploying
		// on-chain, so the DB creator/maker is a seed user with a live balance.
		wallet := fmt.Sprintf("0x%040x", i+1)
		if s.deployer != nil {
			if addr, ok := s.deployer.addrForUser(r.username); ok {
				wallet = strings.ToLower(addr.Hex())
			}
		}
		links := r.links
		if links == nil {
			links = []string{} // marshal to [] (JSON null would defeat DEFAULT '[]')
		}
		id := s.queryID(`
			INSERT INTO users (privy_did, wallet_address, username, display_name, bio, avatar_url,
				links, is_private, trades_visibility, email, email_verified)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
			"seed:"+r.username, wallet, r.username, r.display, r.bio, r.avatar,
			jsonb(links), r.private, r.trades, r.email, r.verified)
		s.users = append(s.users, seedUser{id: id, username: r.username, wallet: wallet, private: r.private})
	}
}

// u returns the seed user index by username, for readable references below.
func (s *seeder) u(name string) seedUser {
	for _, x := range s.users {
		if x.username == name {
			return x
		}
	}
	log.Fatalf("unknown seed user %q", name)
	return seedUser{}
}

// --- username reservations (admin whitelist) -------------------------------

func (s *seeder) seedUsernameReservations() {
	admin := s.u("maren").id
	s.exec(`INSERT INTO username_reservations (username, email, created_by) VALUES ($1,$2,$3)`,
		"thassa", "peej@thassa.example", admin)
	s.exec(`INSERT INTO username_reservations (username, email, created_by) VALUES ($1,$2,$3)`,
		"founder", "ivy@thassa.example", admin)
}

// --- follows ---------------------------------------------------------------

func (s *seeder) seedFollows() {
	follow := func(a, b, status string) {
		s.exec(`INSERT INTO follows (follower_id, followee_id, status) VALUES ($1,$2,$3)
			ON CONFLICT (follower_id, followee_id) DO NOTHING`,
			s.u(a).id, s.u(b).id, status)
	}
	// Accepted graph — maren is the well-connected primary demo user.
	accepted := [][2]string{
		{"maren", "kai"}, {"maren", "petra"}, {"maren", "diego"}, {"maren", "sasha"},
		{"maren", "tomo"}, {"maren", "rafe"}, {"maren", "ivy"},
		{"kai", "maren"}, {"petra", "maren"}, {"diego", "maren"}, {"sasha", "maren"},
		{"tomo", "maren"}, {"rafe", "maren"}, {"ivy", "maren"}, {"lena", "maren"}, {"juno", "maren"},
		{"kai", "petra"}, {"petra", "diego"}, {"diego", "sasha"}, {"sasha", "rafe"},
		{"rafe", "ivy"}, {"ivy", "kai"},
		{"maren", "nova"}, {"sasha", "nova"}, // accepted into private nova
	}
	for _, e := range accepted {
		follow(e[0], e[1], "accepted")
	}
	// Pending follow requests to private accounts (populate the requests UI).
	pending := [][2]string{
		{"kai", "nova"}, {"petra", "nova"}, {"diego", "nova"}, // requests to nova
		{"rafe", "bex"}, {"maren", "bex"}, {"ivy", "bex"}, // requests to bex
	}
	for _, e := range pending {
		follow(e[0], e[1], "pending")
	}
}

// --- markets ---------------------------------------------------------------

func (s *seeder) seedMarkets() {
	type m struct {
		title, question string
		category        string
		status          string
		direction       *bool
		yes, no         int
		volume          int64
		creator         string
		settleReqBy     string // for SETTLING markets
	}
	defs := []m{
		{"Lakers to win Friday", "Will the Los Angeles Lakers beat the Warriors on 2026-07-18?",
			"sports", "MATCHED", nil, 62, 40, 1_250_000_000, "rafe", ""},
		{"BTC above $150k", "Will the Coinbase BTC-USD spot price exceed $150,000 at any time before 2026-08-01?",
			"price", "OPEN", nil, 41, 60, 0, "kai", ""},
		{"SF heatwave", "Will the NWS-reported high temperature in San Francisco exceed 90°F on 2026-07-20?",
			"weather", "SETTLED", ptr(true), 100, 0, 800_000_000, "petra", ""},
		{"Fed cuts in September", "Will the Federal Reserve announce an interest-rate cut at its September 2026 meeting?",
			"news", "OPEN", nil, 55, 47, 0, "sasha", ""},
		{"Warriors take the title", "Will the Golden State Warriors win the 2026 NBA championship?",
			"sports", "SETTLING", nil, 48, 53, 500_000_000, "rafe", "diego"},
		{"Doubleheader postponed", "Will the scheduled 2026-07-19 doubleheader be postponed due to weather?",
			"general", "VOID", nil, 50, 50, 0, "diego", ""},
	}
	s.markets = make([]seedMarket, 0, len(defs))
	for i, d := range defs {
		sq, sqJSON, err := s.registry.BuildSettlementQuery(d.question, d.category)
		if err != nil {
			log.Fatalf("build settlement query: %v", err)
		}
		// Every market gets a placeholder chain id + fake book up front so it
		// renders; the live OPEN/MATCHED ones are then upgraded to a real
		// chain_market_id + book in the post-commit on-chain phase. Placeholder
		// ids (1000+) never collide with real anvil ids (small, start at 1).
		chainID := ptr(int64(1000 + i))
		var settleBy *uuid.UUID
		var settleClaimed *time.Time
		if d.settleReqBy != "" {
			settleBy = ptr(s.u(d.settleReqBy).id)
			settleClaimed = ptr(time.Now().Add(-30 * time.Minute))
		}
		id := s.queryID(`
			INSERT INTO markets (chain_market_id, creator_id, title, question, settlement_query,
				category, rule, sources, status, direction, yes_price_cents, no_price_cents, volume,
				settle_requested_by, settle_claimed_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULLIF($11,0),NULLIF($12,0),$13,$14,$15)
			RETURNING id`,
			chainID, s.u(d.creator).id, d.title, d.question, sqJSON,
			sq.Category, sq.Rule, jsonb(sq.Sources), d.status, d.direction, d.yes, d.no, d.volume,
			settleBy, settleClaimed)
		s.markets = append(s.markets, seedMarket{id: id, status: d.status, title: d.title})

		// Queue this market for real on-chain creation when it is a live
		// OPEN/MATCHED market and its creator + at least one OTHER order maker
		// are backed by funded wallets. Otherwise it stays a fake-chain market.
		if plan, ok := s.livePlanFor(d.title, id, s.u(d.creator).id, d.creator, d.question, sqJSON); ok {
			s.livePlans = append(s.livePlans, plan)
		}
	}
}

// liveMarketSpecs defines, per market title, the opening order (by the market
// creator) and a couple of orders from OTHER seed users that add live depth.
// OPEN markets get non-crossing resting orders (a takeable book); the MATCHED
// market gets a crossing order that fully takes the opening bet on-chain.
var liveMarketSpecs = map[string]struct {
	opening liveOrderSpec
	takers  []liveOrderSpec
	matched bool
}{
	"BTC above $150k": {
		opening: liveOrderSpec{makerUser: "kai", side: "yes", price: 55, shares: 100},
		takers: []liveOrderSpec{
			{makerUser: "petra", side: "no", price: 40, shares: 120},
			{makerUser: "diego", side: "yes", price: 45, shares: 80},
		},
	},
	"Fed cuts in September": {
		opening: liveOrderSpec{makerUser: "sasha", side: "yes", price: 52, shares: 100},
		takers: []liveOrderSpec{
			{makerUser: "maren", side: "no", price: 43, shares: 120},
			{makerUser: "diego", side: "yes", price: 40, shares: 80},
		},
	},
	"Lakers to win Friday": {
		opening: liveOrderSpec{makerUser: "rafe", side: "yes", price: 60, shares: 100},
		takers:  []liveOrderSpec{{makerUser: "diego", side: "no", price: 40, shares: 100}},
		matched: true,
	},
}

// livePlanFor returns the on-chain deployment plan for a market when live
// deployment is enabled and the creator plus at least one OTHER order maker are
// backed by funded wallets. Otherwise the market stays fake-chain.
func (s *seeder) livePlanFor(title string, marketID, creatorID uuid.UUID, creator, question, settlement string) (liveMarketPlan, bool) {
	if s.deployer == nil {
		return liveMarketPlan{}, false
	}
	spec, ok := liveMarketSpecs[title]
	if !ok || !s.deployer.isFunded(creator) {
		return liveMarketPlan{}, false
	}
	var takers []liveOrderSpec
	for _, t := range spec.takers {
		if s.deployer.isFunded(t.makerUser) {
			takers = append(takers, t)
		}
	}
	if len(takers) == 0 {
		return liveMarketPlan{}, false // no funded counterparty ⇒ keep fake book
	}
	return liveMarketPlan{
		marketID:   marketID,
		creatorID:  creatorID,
		creator:    creator,
		question:   question,
		settlement: settlement,
		opening:    spec.opening,
		takers:     takers,
		matched:    spec.matched,
	}, true
}

// market returns the seed market by title.
func (s *seeder) market(title string) seedMarket {
	for _, m := range s.markets {
		if m.title == title {
			return m
		}
	}
	log.Fatalf("unknown seed market %q", title)
	return seedMarket{}
}

// --- orders / fills / positions --------------------------------------------

func (s *seeder) seedBook() {
	digest := 0
	chainOrd := int64(0)
	fillLog := 0
	nextDigest := func() string { digest++; return fmt.Sprintf("0xseeddigest%050d", digest) }
	nextChain := func() int64 { chainOrd++; return chainOrd }

	for mi, m := range s.markets {
		if m.status == "VOID" {
			continue // no book on a voided market
		}
		settled := m.status == "SETTLED"
		// Best resting bid per side, to mirror coherent ASK prices onto the
		// market row afterwards (yes ask = 100 − best NO bid, and vice versa)
		// so the YES/NO buttons agree with the seeded book.
		bestYesBid, bestNoBid := 0, 0
		// Build a small resting/partial/filled book plus matched fills + positions.
		for j := 0; j < 4; j++ {
			trader := s.users[(mi+j)%len(s.users)]
			side := []string{"yes", "no"}[j%2]
			// 30..49 per side: yes+no ≤ 98 < 100, so the resting book can
			// never be crossed (crossed orders would have matched on-chain)
			// and the mirrored asks stay coherent (each ask ≥ 51¢, sum ≥ 102).
			price := 30 + s.rng.Intn(20)
			shares := int64(10 + s.rng.Intn(90))
			status := []string{"PARTIAL", "RESTING", "FILLED", "RESTING"}[j]
			if settled {
				status = "FILLED"
			}
			if !settled && (status == "RESTING" || status == "PARTIAL") {
				if side == "yes" && price > bestYesBid {
					bestYesBid = price
				}
				if side == "no" && price > bestNoBid {
					bestNoBid = price
				}
			}
			filled := shares / 2
			if status == "FILLED" {
				filled = shares
			}
			oid := s.queryID(`
				INSERT INTO orders (market_id, user_id, side, price_cents, shares, filled_shares,
					status, chain_order_id, maker_address, max_cost, nonce, order_digest, is_market_create)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
				m.id, trader.id, side, price, shares, filled, status, nextChain(),
				trader.wallet, shares*int64(price)*10_000, int64(j), nextDigest(), j == 0)

			if filled > 0 {
				// A matched fill (unique (tx_hash, log_index)).
				fillLog++
				s.exec(`
					INSERT INTO fills (market_id, taker_order_id, taker_chain_order_id, maker_chain_order_id,
						price_cents, shares, fee, tx_hash, log_index)
					VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
					m.id, oid, nextChain(), nextChain(), price, filled,
					// Mirror the contract's taker fee: ceil(700 × shares × p × (100−p) × 1e6 / 1e8)
					// = 7 × shares × p × (100−p) token units at 6 decimals.
					7*int64(price*(100-price))*filled, fmt.Sprintf("0xseedtx%08d", fillLog), fillLog)
				// Mirrored position for the taker.
				s.exec(`
					INSERT INTO positions (market_id, user_id, side, shares, avg_price_cents)
					VALUES ($1,$2,$3,$4,$5)
					ON CONFLICT (market_id, user_id, side) DO UPDATE SET shares = EXCLUDED.shares`,
					m.id, trader.id, side, filled, price)
			}
		}
		// Mirror ASK semantics from the seeded book (matches the indexer):
		// what a taker pays now — yes ask = 100 − best NO bid, no ask = 100 −
		// best YES bid; NULL when the opposite side has no resting liquidity.
		if !settled {
			s.exec(`UPDATE markets SET
					yes_price_cents = NULLIF($2, 0),
					no_price_cents  = NULLIF($3, 0)
				WHERE id=$1`,
				m.id,
				map[bool]int{true: 100 - bestNoBid, false: 0}[bestNoBid > 0],
				map[bool]int{true: 100 - bestYesBid, false: 0}[bestYesBid > 0])
		}
	}

	// The SETTLED market resolved YES: a winner (yes) and a loser (no) with
	// realized PnL, so profile PnL + a settled position card render.
	settledMkt := s.market("SF heatwave")
	s.exec(`
		INSERT INTO positions (market_id, user_id, side, shares, avg_price_cents, realized_pnl)
		VALUES ($1,$2,'yes',40,45,18000000), ($1,$3,'no',35,55,-19250000)
		ON CONFLICT (market_id, user_id, side) DO UPDATE SET realized_pnl = EXCLUDED.realized_pnl`,
		settledMkt.id, s.u("petra").id, s.u("diego").id)
}

// --- posts / media / comments / likes / reactions --------------------------

// variant is one image rendition in the post_media.variants ladder
// ({"w","h","key","fmt"} per migration 0006).
type variant struct {
	W   int    `json:"w"`
	H   int    `json:"h"`
	Key string `json:"key"`
	Fmt string `json:"fmt"`
}

// muxHLSStream is a real, public HLS master playlist (Mux's demo stream) so
// seeded videos actually play adaptively.
const muxHLSStream = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8"

// slugify reduces an arbitrary label to a single URL path segment (picsum's
// /seed/<slug> only accepts one segment — no slashes).
func slugify(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	return b.String()
}

// picsum returns a deterministic, real photograph URL for a slug at w×h. The
// store's media resolver passes absolute URLs through untouched, so these serve
// as-is. Stored directly as media keys (s3_key / variant keys).
func picsum(slug string, w, h int) string {
	return fmt.Sprintf("https://picsum.photos/seed/%s/%d/%d", slugify(slug), w, h)
}

// imageLadder builds a responsive ladder of REAL picsum renditions at
// 320/640/1080 widths (4:5 portrait), so viewport-variant selection works with
// real images. Each entry's key is a fully-qualified picsum URL.
func imageLadder(slug string) []variant {
	return []variant{
		{W: 320, H: 400, Key: picsum(slug, 320, 400), Fmt: "jpeg"},
		{W: 640, H: 800, Key: picsum(slug, 640, 800), Fmt: "jpeg"},
		{W: 1080, H: 1350, Key: picsum(slug, 1080, 1350), Fmt: "jpeg"},
	}
}

// storyLadder is imageLadder at 9:16 (full-screen story/reel aspect).
func storyLadder(slug string) []variant {
	return []variant{
		{W: 320, H: 568, Key: picsum(slug, 320, 568), Fmt: "jpeg"},
		{W: 640, H: 1136, Key: picsum(slug, 640, 1136), Fmt: "jpeg"},
		{W: 1080, H: 1920, Key: picsum(slug, 1080, 1920), Fmt: "jpeg"},
	}
}

func (s *seeder) seedPosts() {
	// Insert a post row and return its id.
	addPost := func(author uuid.UUID, caption, kind string, marketID *uuid.UUID, mentions []structs.MentionInput) uuid.UUID {
		if mentions == nil {
			mentions = []structs.MentionInput{}
		}
		id := s.queryID(`
			INSERT INTO posts (author_id, caption, kind, market_id, mentions)
			VALUES ($1,$2,$3,$4,$5) RETURNING id`,
			author, caption, kind, marketID, jsonb(mentions))
		for _, mn := range mentions {
			s.exec(`INSERT INTO post_mentions (post_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
				id, mn.UserID)
		}
		return id
	}
	// Attach a ready image media row backed by REAL hosted photos: s3_key is a
	// large (1200-wide) picsum image and variants is a real responsive ladder
	// (present when withVariants, to exercise both the ladder and single-image
	// paths). variant_key stays NULL so the top-level URL is the 1200 original.
	addImage := func(owner, post uuid.UUID, pos int, slug string, withVariants bool) {
		var variants any = []variant{}
		if withVariants {
			variants = imageLadder(slug)
		}
		s.exec(`
			INSERT INTO post_media (owner_id, post_id, position, kind, s3_key, variant_key,
				variants, width, height, status)
			VALUES ($1,$2,$3,'image',$4,NULL,$5,1200,1500,'ready')`,
			owner, post, pos, picsum(slug, 1200, 1500), jsonb(variants))
	}
	// Attach a ready video media row that actually plays: a real Mux HLS stream
	// with a real picsum poster still (also the top-level URL fallback).
	addVideo := func(owner, post uuid.UUID, pos int, slug string) {
		poster := picsum(slug, 1080, 1920)
		s.exec(`
			INSERT INTO post_media (owner_id, post_id, position, kind, s3_key, hls_key, poster_key,
				variants, width, height, duration_ms, status)
			VALUES ($1,$2,$3,'video',$4,$5,$6,'[]'::jsonb,1080,1920,12000,'ready')`,
			owner, post, pos, poster, muxHLSStream, poster)
	}

	maren, kai, petra, diego := s.u("maren"), s.u("kai"), s.u("petra"), s.u("diego")
	sasha, nova, tomo, rafe := s.u("sasha"), s.u("nova"), s.u("tomo"), s.u("rafe")

	btc := s.market("BTC above $150k").id
	heat := s.market("SF heatwave").id
	lakers := s.market("Lakers to win Friday").id

	// p0 — multi-photo (2 images, second carries a variant ladder).
	p0 := addPost(maren.id, "golden hour at ocean beach 🌊", "photo", nil, nil)
	addImage(maren.id, p0, 0, "ocean-beach-1", false)
	addImage(maren.id, p0, 1, "ocean-beach-2", true)

	// p1 — photo with an attached market + an @-mention.
	cap1 := "big btc call, positioned. tagging @petra for the weather angle"
	p1 := addPost(kai.id, cap1, "photo", &btc, mentionsFor(cap1, map[string]uuid.UUID{"petra": petra.id}))
	addImage(kai.id, p1, 0, "btc-post", true)

	// p2 — video post with an attached market.
	p2 := addPost(petra.id, "heatwave incoming, positioned accordingly ☀️", "video", &heat, nil)
	addVideo(petra.id, p2, 0, "heatwave")

	// p3 — reel with two @-mentions.
	cap3 := "courtside tonight with @maren and @rafe"
	p3 := addPost(diego.id, cap3, "reel", &lakers,
		mentionsFor(cap3, map[string]uuid.UUID{"maren": maren.id, "rafe": rafe.id}))
	addVideo(diego.id, p3, 0, "courtside")

	// p4 — plain photo.
	p4 := addPost(sasha.id, "gm from the newsroom", "photo", nil, nil)
	addImage(sasha.id, p4, 0, "newsroom", false)

	// p5 — post by a PRIVATE account (visible only to accepted followers).
	p5 := addPost(nova.id, "private account, posting anyway", "photo", nil, nil)
	addImage(nova.id, p5, 0, "nova-private", false)

	// p6 — 3-photo carousel by a username-only account, all with variant ladders.
	p6 := addPost(tomo.id, "roll from the weekend", "photo", nil, nil)
	for i := 0; i < 3; i++ {
		addImage(tomo.id, p6, i, fmt.Sprintf("weekend-roll-%d", i), true)
	}

	// p7 — photo with an attached market + mention.
	cap7 := "lakers lock, fading @diego all night"
	p7 := addPost(rafe.id, cap7, "photo", &lakers, mentionsFor(cap7, map[string]uuid.UUID{"diego": diego.id}))
	addImage(rafe.id, p7, 0, "lakers-post", true)

	s.posts = []uuid.UUID{p0, p1, p2, p3, p4, p5, p6, p7}

	// Extra reels so the Watch tab has a scrollable, testable set.
	juno := s.u("juno")
	reelDefs := []struct {
		author  seedUser
		slug    string
		caption string
	}{
		{kai, "skate-clip", "kickflip attempt no. 47 🛹"},
		{sasha, "newsroom-tour", "behind the desk"},
		{tomo, "sunset-timelapse", "golden hour hits different"},
		{juno, "arcade-run", "one more game"},
		{petra, "storm-chase", "chasing the front ⛈️"},
	}
	for _, r := range reelDefs {
		rp := addPost(r.author.id, r.caption, "reel", nil, nil)
		addVideo(r.author.id, rp, 0, r.slug)
		s.posts = append(s.posts, rp)
	}

	// --- comments (on posts AND markets, with replies + @-mentions) ---------
	// addComment inserts a post OR market comment (exactly one subject) and its
	// normalized comment_mentions rows; returns the comment id.
	addComment := func(postID, marketID *uuid.UUID, author uuid.UUID, parent *uuid.UUID, body string,
		mentions []structs.MentionInput) uuid.UUID {
		if mentions == nil {
			mentions = []structs.MentionInput{}
		}
		id := s.queryID(`
			INSERT INTO comments (post_id, market_id, author_id, parent_id, body, mentions)
			VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
			postID, marketID, author, parent, body, jsonb(mentions))
		for _, mn := range mentions {
			s.exec(`INSERT INTO comment_mentions (comment_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
				id, mn.UserID)
		}
		return id
	}

	// Post comments with a threaded reply + mention.
	c0 := addComment(&p0, nil, kai.id, nil, "love this 🔥", nil)
	cReplyBody := "@maren the light here is unreal"
	addComment(&p0, nil, petra.id, &c0, cReplyBody, mentionsFor(cReplyBody, map[string]uuid.UUID{"maren": maren.id}))
	addComment(&p1, nil, diego.id, nil, "bold. i'm on the other side", nil)
	addComment(&p3, nil, sasha.id, nil, "unreal seats", nil)

	// Market comments (subject = market) with a reply.
	mc0 := addComment(nil, &btc, diego.id, nil, "fading this hard, 150 is a stretch", nil)
	mcReply := "@diego respectfully wrong"
	addComment(nil, &btc, kai.id, &mc0, mcReply, mentionsFor(mcReply, map[string]uuid.UUID{"diego": diego.id}))
	addComment(nil, &lakers, rafe.id, nil, "lock of the night", nil)

	// --- likes (posts, comments, markets) -----------------------------------
	like := func(subjectType string, subjectID, userID uuid.UUID) {
		s.exec(`INSERT INTO likes (subject_type, subject_id, user_id) VALUES ($1,$2,$3)
			ON CONFLICT (subject_type, subject_id, user_id) DO NOTHING`, subjectType, subjectID, userID)
	}
	// Post likes.
	for _, liker := range []seedUser{kai, petra, diego, sasha, rafe} {
		like("post", p0, liker.id)
	}
	like("post", p1, maren.id)
	like("post", p1, petra.id)
	like("post", p3, maren.id)
	like("post", p6, maren.id)
	// Comment likes.
	like("comment", c0, maren.id)
	like("comment", c0, petra.id)
	// Market likes.
	like("market", btc, maren.id)
	like("market", btc, sasha.id)
	like("market", lakers, diego.id)

	// --- reactions (posts, comments, markets, messages via seedConversations) ---
	react := func(subjectType string, subjectID, userID uuid.UUID, emoji string) {
		s.exec(`INSERT INTO reactions (subject_type, subject_id, user_id, emoji) VALUES ($1,$2,$3,$4)
			ON CONFLICT (subject_type, subject_id, user_id) DO NOTHING`, subjectType, subjectID, userID, emoji)
	}
	react("post", p0, kai.id, "🔥")
	react("post", p0, petra.id, "😍")
	react("post", p3, maren.id, "🏀")
	react("comment", c0, diego.id, "❤️")
	react("market", btc, diego.id, "📉")
	react("market", lakers, maren.id, "🎯")
}

// --- stories ---------------------------------------------------------------

func (s *seeder) seedStories() {
	authors := []string{"maren", "kai", "petra", "rafe"}
	storyIDs := make([]uuid.UUID, 0, len(authors))
	for i, name := range authors {
		au := s.u(name)
		slug := fmt.Sprintf("story-%s", name)
		kind := "image"
		s3Key := picsum(slug, 1080, 1920)    // real 9:16 still
		var variants any = storyLadder(slug) // real responsive ladder
		var hls, poster *string
		if i == 1 { // one video story: real Mux HLS + real poster still
			kind = "video"
			variants = []variant{}
			poster = ptr(picsum(slug, 1080, 1920))
			s3Key = *poster // top-level URL falls back to the poster
			hls = ptr(muxHLSStream)
		}
		id := s.queryID(`
			INSERT INTO stories (author_id, kind, s3_key, hls_key, poster_key, variants, width, height, expires_at)
			VALUES ($1,$2,$3,$4,$5,$6,1080,1920,$7) RETURNING id`,
			au.id, kind, s3Key, hls, poster, jsonb(variants),
			time.Now().Add(time.Duration(18-i)*time.Hour)) // all non-expired
		storyIDs = append(storyIDs, id)
	}
	// Story view rows (so the "seen by" / viewer state has data).
	viewers := []string{"maren", "kai", "petra", "diego", "sasha", "rafe"}
	for _, sid := range storyIDs {
		for _, vname := range viewers {
			s.exec(`INSERT INTO story_views (story_id, viewer_id) VALUES ($1,$2)
				ON CONFLICT (story_id, viewer_id) DO NOTHING`, sid, s.u(vname).id)
		}
	}
}

// --- conversations / messages ----------------------------------------------

func (s *seeder) seedConversations() {
	// dm builds a 1:1 conversation with messages; last_read_at is set per member
	// so unread badges show for whoever is behind.
	type msg struct {
		from      string
		body      string
		withMedia bool
	}
	build := func(a, b string, aRead, bRead time.Time, msgs []msg) {
		convID := s.queryID(`INSERT INTO conversations (kind) VALUES ('dm') RETURNING id`)
		s.exec(`INSERT INTO conversation_members (conversation_id, user_id, last_read_at) VALUES ($1,$2,$3)`,
			convID, s.u(a).id, aRead)
		s.exec(`INSERT INTO conversation_members (conversation_id, user_id, last_read_at) VALUES ($1,$2,$3)`,
			convID, s.u(b).id, bRead)
		var lastMsg uuid.UUID
		for _, m := range msgs {
			sender := s.u(m.from)
			if m.withMedia {
				slug := "dm-" + sender.username
				lastMsg = s.queryID(`
					INSERT INTO messages (conversation_id, sender_id, body, media_kind, s3_key, variants)
					VALUES ($1,$2,$3,'image',$4,$5) RETURNING id`,
					convID, sender.id, m.body,
					picsum(slug, 1200, 1500), jsonb(imageLadder(slug)))
			} else {
				lastMsg = s.queryID(`
					INSERT INTO messages (conversation_id, sender_id, body) VALUES ($1,$2,$3) RETURNING id`,
					convID, sender.id, m.body)
			}
		}
		// A message reaction, exercising reactions.subject_type='message'.
		if lastMsg != uuid.Nil {
			s.exec(`INSERT INTO reactions (subject_type, subject_id, user_id, emoji) VALUES ('message',$1,$2,'👍')
				ON CONFLICT DO NOTHING`, lastMsg, s.u(b).id)
		}
	}

	now := time.Now()
	// conv1: maren behind (unread for maren) — maren.last_read before kai's latest.
	build("maren", "kai", now.Add(-2*time.Hour), now, []msg{
		{"maren", "yo did you see the lakers market?", false},
		{"kai", "taking the yes side rn", false},
		{"kai", "here's my ticket", true},
		{"maren", "bold. i'm fading you", false},
		{"kai", "we'll see 😏", false},
	})
	// conv2: fully caught up (no unread on either side).
	build("maren", "petra", now, now, []msg{
		{"petra", "heatwave market looks juicy", false},
		{"maren", "already in", false},
	})
	// conv3: diego behind (unread for diego).
	build("diego", "sasha", now.Add(-3*time.Hour), now, []msg{
		{"sasha", "fed decision is a coinflip", false},
		{"diego", "i think they hold", false},
		{"sasha", "want to make it interesting?", false},
	})
}

// --- notifications ---------------------------------------------------------

// seedNotifications drops one row of every notification kind onto the primary
// demo user (maren), a mix of read + unread so the badge + read states show.
func (s *seeder) seedNotifications() {
	target := s.u("maren").id
	kai, petra, diego := s.u("kai"), s.u("petra"), s.u("diego")
	btc := s.market("BTC above $150k")
	lakers := s.market("Lakers to win Friday")
	heat := s.market("SF heatwave")

	type notif struct {
		kind    string
		payload map[string]any
		read    bool
	}
	notifs := []notif{
		{"post.mention", map[string]any{"actor_id": diego.id.String(), "actor": "diego", "post_id": s.posts[3].String(), "text": "courtside tonight with @maren and @rafe"}, false},
		{"dm.message", map[string]any{"actor_id": kai.id.String(), "actor": "kai", "preview": "we'll see 😏"}, false},
		{"follow.new", map[string]any{"actor_id": kai.id.String(), "actor": "kai"}, true},
		{"follow.request", map[string]any{"actor_id": petra.id.String(), "actor": "petra"}, false},
		{"follow.accepted", map[string]any{"actor_id": s.u("nova").id.String(), "actor": "nova"}, true},
		{"position.swing", map[string]any{"market_id": heat.id.String(), "title": heat.title, "delta_pct": 62}, false},
		{"following.large_entry", map[string]any{"actor_id": diego.id.String(), "actor": "diego", "market_id": btc.id.String(), "title": btc.title, "notional": 250000000}, false},
		{"market.matched", map[string]any{"market_id": lakers.id.String(), "title": lakers.title}, true},
		{"market.settled", map[string]any{"market_id": heat.id.String(), "title": heat.title, "direction": true}, true},
		{"order.filled", map[string]any{"market_id": lakers.id.String(), "title": lakers.title, "shares": 40, "price_cents": 62}, false},
		{"post.liked", map[string]any{"actor_id": kai.id.String(), "actor": "kai", "post_id": s.posts[0].String()}, true},
		{"post.commented", map[string]any{"actor_id": kai.id.String(), "actor": "kai", "post_id": s.posts[0].String(), "preview": "love this 🔥"}, false},
	}
	for _, n := range notifs {
		var readAt *time.Time
		if n.read {
			readAt = ptr(time.Now().Add(-1 * time.Hour))
		}
		s.exec(`INSERT INTO notifications (user_id, kind, payload, read_at) VALUES ($1,$2,$3,$4)`,
			target, n.kind, jsonb(n.payload), readAt)
	}
}

// --- misc dev surfaces (api keys, push tokens, onramp, gen logs) ------------

func (s *seeder) seedDevSurfaces() {
	maren, kai := s.u("maren"), s.u("kai")

	// API keys (spec §6.9): one read, one trade. key_hash is UNIQUE; these are
	// fake sha256-hex-shaped values (no real secret exists for seed keys).
	s.exec(`INSERT INTO api_keys (user_id, name, prefix, key_hash, scope) VALUES ($1,$2,$3,$4,'read')`,
		maren.id, "read-only bot", "tsk_live_ab12", "seedhash_"+strings.Repeat("a", 55))
	s.exec(`INSERT INTO api_keys (user_id, name, prefix, key_hash, scope) VALUES ($1,$2,$3,$4,'trade')`,
		maren.id, "trading bot", "tsk_live_cd34", "seedhash_"+strings.Repeat("b", 55))

	// Push tokens (Expo) for a couple users.
	s.exec(`INSERT INTO push_tokens (user_id, token, platform) VALUES ($1,$2,'expo') ON CONFLICT DO NOTHING`,
		maren.id, "ExponentPushToken[seed-maren-000000]")
	s.exec(`INSERT INTO push_tokens (user_id, token, platform) VALUES ($1,$2,'expo') ON CONFLICT DO NOTHING`,
		kai.id, "ExponentPushToken[seed-kai-0000000]")

	// Onramp sessions (fiat + crypto).
	s.exec(`INSERT INTO onramp_sessions (user_id, provider, kind, status, payload) VALUES ($1,'stripe','fiat','created',$2)`,
		maren.id, jsonb(map[string]any{"amount": 5000, "currency": "usd"}))
	s.exec(`INSERT INTO onramp_sessions (user_id, provider, kind, status, payload) VALUES ($1,'coinbase','crypto','completed',$2)`,
		kai.id, jsonb(map[string]any{"asset": "USDC", "amount": "250"}))

	// Market-generation audit log (LLM agent).
	s.exec(`INSERT INTO market_generation_logs (user_id, raw_input, sanitized_input, candidates, flagged) VALUES ($1,$2,$3,$4,false)`,
		kai.id, "will btc hit 150k?", "Will BTC hit $150k?",
		jsonb([]map[string]any{{"question": "Will the Coinbase BTC-USD spot price exceed $150,000 before 2026-08-01?", "category": "price"}}))
}

// --- reconcile denormalized counters ---------------------------------------

// reconcile fixes up the denormalized counters (spec §7d.5) and comment/like
// counts from the actual rows just inserted, restricted to seed-owned rows so it
// never touches real data. Also backfills the running entry-stat aggregates that
// power the position.swing / following.large_entry triggers.
func (s *seeder) reconcile() {
	const seedUsers = `(SELECT id FROM users WHERE privy_did LIKE 'seed:%')`

	// Profile counters.
	s.exec(`UPDATE users u SET
			follower_count  = (SELECT count(*) FROM follows f WHERE f.followee_id=u.id AND f.status='accepted'),
			following_count = (SELECT count(*) FROM follows f WHERE f.follower_id=u.id AND f.status='accepted'),
			post_count      = (SELECT count(*) FROM posts p WHERE p.author_id=u.id AND p.deleted_at IS NULL)
		WHERE u.id IN ` + seedUsers)

	// Post like/comment counts.
	s.exec(`UPDATE posts p SET
			like_count    = (SELECT count(*) FROM likes l WHERE l.subject_type='post' AND l.subject_id=p.id),
			comment_count = (SELECT count(*) FROM comments c WHERE c.post_id=p.id)
		WHERE p.author_id IN ` + seedUsers)

	// Comment like counts.
	s.exec(`UPDATE comments c SET
			like_count = (SELECT count(*) FROM likes l WHERE l.subject_type='comment' AND l.subject_id=c.id)
		WHERE c.author_id IN ` + seedUsers)

	// user_entry_stats: entry = order placement; notional = shares × effective
	// price in cents (spec §7d.4). Mirrors migration 0003's backfill.
	s.exec(`INSERT INTO user_entry_stats (user_id, entry_count, notional_sum)
		SELECT o.user_id, count(*),
		       COALESCE(SUM(o.shares * (CASE WHEN o.side='yes' THEN o.price_cents ELSE 100 - o.price_cents END)),0)
		FROM orders o WHERE o.user_id IN ` + seedUsers + `
		GROUP BY o.user_id
		ON CONFLICT (user_id) DO UPDATE SET entry_count=EXCLUDED.entry_count, notional_sum=EXCLUDED.notional_sum`)

	// follow_entry_agg: each follower rolls up its accepted followees' stats.
	s.exec(`INSERT INTO follow_entry_agg (follower_id, following_notional_sum, following_entry_count)
		SELECT f.follower_id, COALESCE(SUM(ues.notional_sum),0), COALESCE(SUM(ues.entry_count),0)
		FROM follows f
		LEFT JOIN user_entry_stats ues ON ues.user_id=f.followee_id
		WHERE f.status='accepted' AND f.follower_id IN ` + seedUsers + `
		GROUP BY f.follower_id
		ON CONFLICT (follower_id) DO UPDATE SET
			following_notional_sum=EXCLUDED.following_notional_sum,
			following_entry_count=EXCLUDED.following_entry_count`)
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

// summary logs seed-scoped row counts (a fresh pool read, after commit).
func (s *seeder) summary(ctx context.Context, pool *pgxpool.Pool) {
	counts := []struct {
		label, sql string
	}{
		{"users", `SELECT count(*) FROM users WHERE privy_did LIKE 'seed:%'`},
		{"follows", `SELECT count(*) FROM follows WHERE follower_id IN (SELECT id FROM users WHERE privy_did LIKE 'seed:%')`},
		{"markets", `SELECT count(*) FROM markets WHERE creator_id IN (SELECT id FROM users WHERE privy_did LIKE 'seed:%')`},
		{"orders", `SELECT count(*) FROM orders WHERE user_id IN (SELECT id FROM users WHERE privy_did LIKE 'seed:%')`},
		{"fills", `SELECT count(*) FROM fills WHERE market_id IN (SELECT id FROM markets WHERE creator_id IN (SELECT id FROM users WHERE privy_did LIKE 'seed:%'))`},
		{"positions", `SELECT count(*) FROM positions WHERE user_id IN (SELECT id FROM users WHERE privy_did LIKE 'seed:%')`},
		{"posts", `SELECT count(*) FROM posts WHERE author_id IN (SELECT id FROM users WHERE privy_did LIKE 'seed:%')`},
		{"post_media", `SELECT count(*) FROM post_media WHERE owner_id IN (SELECT id FROM users WHERE privy_did LIKE 'seed:%')`},
		{"comments", `SELECT count(*) FROM comments WHERE author_id IN (SELECT id FROM users WHERE privy_did LIKE 'seed:%')`},
		{"likes", `SELECT count(*) FROM likes WHERE user_id IN (SELECT id FROM users WHERE privy_did LIKE 'seed:%')`},
		{"reactions", `SELECT count(*) FROM reactions WHERE user_id IN (SELECT id FROM users WHERE privy_did LIKE 'seed:%')`},
		{"stories", `SELECT count(*) FROM stories WHERE author_id IN (SELECT id FROM users WHERE privy_did LIKE 'seed:%')`},
		{"messages", `SELECT count(*) FROM messages WHERE sender_id IN (SELECT id FROM users WHERE privy_did LIKE 'seed:%')`},
		{"notifications", `SELECT count(*) FROM notifications WHERE user_id IN (SELECT id FROM users WHERE privy_did LIKE 'seed:%')`},
		{"username_res", `SELECT count(*) FROM username_reservations WHERE username = ANY($1)`},
	}
	log.Printf("seeded (privy_did LIKE 'seed:%%'):")
	for _, c := range counts {
		var n int
		var err error
		if c.label == "username_res" {
			err = pool.QueryRow(ctx, c.sql, reservedUsernames).Scan(&n)
		} else {
			err = pool.QueryRow(ctx, c.sql).Scan(&n)
		}
		if err != nil {
			log.Printf("  %-14s (count error: %v)", c.label, err)
			continue
		}
		log.Printf("  %-14s %d", c.label, n)
	}
}
