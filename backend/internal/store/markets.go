package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pjol/THASSA/backend/internal/structs"
)

const marketSummaryCols = `m.id, m.chain_market_id, m.title, m.question, m.status, m.direction,
	m.yes_price_cents, m.no_price_cents, m.volume, m.expires_at, m.resolved_fifty, m.created_at`

// SearchMarkets runs the typeahead search: pg_trgm similarity over question
// combined with full-text (websearch_to_tsquery) over the tsvector column.
// Returns the top N with status and prices.
func (s *Store) SearchMarkets(ctx context.Context, q string, limit int) ([]structs.MarketSummary, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+marketSummaryCols+`
		FROM markets m
		WHERE m.status NOT IN ('VOID')
		  AND (m.question % $1
		       OR m.title ILIKE '%'||$1||'%'
		       OR m.search @@ websearch_to_tsquery('english', $1))
		ORDER BY GREATEST(similarity(m.question, $1), similarity(m.title, $1)) DESC,
		         ts_rank(m.search, websearch_to_tsquery('english', $1)) DESC,
		         m.volume DESC
		LIMIT $2`, q, limit)
	if err != nil {
		return nil, err
	}
	return scanMarketSummaries(rows)
}

// SaveGeneratedCandidates persists generation output for cross-user reuse:
// later attach-market searches surface these as "start market" suggestions
// before anyone has to re-generate them. One row per distinct question;
// candidates that mapped to an existing market are skipped.
func (s *Store) SaveGeneratedCandidates(ctx context.Context, userID uuid.UUID, cands []structs.MarketCandidate) {
	for _, c := range cands {
		if c.ExistingMarketID != nil || c.Question == "" || c.SettlementQuery == "" {
			continue
		}
		srcJSON, err := json.Marshal(c.Sources)
		if err != nil {
			srcJSON = []byte("[]")
		}
		_, _ = s.pool.Exec(ctx, `
			INSERT INTO generated_market_candidates
				(created_by, title, question, settlement_query, category, rule, sources)
			VALUES ($1,$2,$3,$4,$5,$6,$7)
			ON CONFLICT ((lower(question))) DO NOTHING`,
			userID, c.Title, c.Question, c.SettlementQuery, c.Category, c.Rule, srcJSON)
	}
}

// SearchGeneratedCandidates returns stored, not-yet-started candidates
// matching the query (trigram + substring over question/title).
func (s *Store) SearchGeneratedCandidates(ctx context.Context, q string, limit int) ([]structs.GeneratedCandidate, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, title, question, settlement_query, COALESCE(category,''), COALESCE(rule,''), sources
		FROM generated_market_candidates
		WHERE market_id IS NULL
		  AND (question % $1 OR question ILIKE '%'||$1||'%' OR title ILIKE '%'||$1||'%')
		ORDER BY GREATEST(similarity(question, $1), similarity(title, $1)) DESC, created_at DESC
		LIMIT $2`, q, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []structs.GeneratedCandidate{}
	for rows.Next() {
		var g structs.GeneratedCandidate
		var srcJSON []byte
		if err := rows.Scan(&g.ID, &g.Title, &g.Question, &g.SettlementQuery, &g.Category, &g.Rule, &srcJSON); err != nil {
			return nil, err
		}
		g.Sources = []structs.SourceRef{}
		if len(srcJSON) > 0 {
			_ = json.Unmarshal(srcJSON, &g.Sources)
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// MarkGeneratedCandidateStarted stamps the created market onto the stored
// candidate (matched by question), removing it from future suggestions.
func (s *Store) MarkGeneratedCandidateStarted(ctx context.Context, question string, marketID uuid.UUID) {
	_, _ = s.pool.Exec(ctx, `
		UPDATE generated_market_candidates SET market_id=$2
		WHERE lower(question)=lower($1) AND market_id IS NULL`, question, marketID)
}

// SimilarMarketBySettlement finds the most similar existing market to a
// candidate settlement query (trigram over question + settlement_query). Used
// by the distinct-outcome post-check. Returns nil when below threshold.
func (s *Store) SimilarMarketBySettlement(ctx context.Context, settlementQuery, question string, threshold float64) (*structs.MarketSummary, float64, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT `+marketSummaryCols+`,
		       GREATEST(similarity(m.settlement_query, $1), similarity(m.question, $2)) AS sim
		FROM markets m
		WHERE m.status NOT IN ('VOID')
		ORDER BY sim DESC
		LIMIT 1`, settlementQuery, question)
	var ms structs.MarketSummary
	var sim float64
	if err := scanMarketSummary(row, &ms, &sim); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, 0, nil
		}
		return nil, 0, err
	}
	if sim < threshold {
		return nil, sim, nil
	}
	return &ms, sim, nil
}

// ExploreMarkets ranks markets by volume + recency for the explore tab.
func (s *Store) ExploreMarkets(ctx context.Context, limit, offset int, status, sort string) ([]structs.MarketSummary, error) {
	// Status filter: "active" (the default UI view) shows only tradable
	// markets; the sort/filter menu opens the rest up.
	var statuses []string
	switch status {
	case "settling":
		statuses = []string{"SETTLING"}
	case "settled":
		statuses = []string{"SETTLED"}
	case "all":
		statuses = []string{"OPEN", "MATCHED", "SETTLING", "SETTLED"}
	default: // "active"
		statuses = []string{"OPEN", "MATCHED"}
	}
	order := `(m.volume+1)::numeric * exp(-extract(epoch FROM (now()-m.created_at))/604800.0) DESC,
	          m.created_at DESC` // trending (default)
	switch sort {
	case "newest":
		order = `m.created_at DESC`
	case "volume":
		order = `m.volume DESC, m.created_at DESC`
	}
	rows, err := s.pool.Query(ctx, `
		SELECT `+marketSummaryCols+`
		FROM markets m
		WHERE m.status = ANY($3)
		ORDER BY `+order+`
		LIMIT $1 OFFSET $2`, limit, offset, statuses)
	if err != nil {
		return nil, err
	}
	return scanMarketSummaries(rows)
}

// CreateMarketParams carries the denormalized structured settlement query
// (spec §6.5b): settlementQuery is the JSON string stored verbatim (it is
// what goes onchain); category/rule/sources are denormalized for display.
type CreateMarketParams struct {
	CreatorID       uuid.UUID
	Title           string
	Question        string
	SettlementQuery string
	Category        string
	Rule            string
	Sources         []structs.SourceRef
	// ExpiresAt: when reached before settlement, the market auto-resolves
	// 50/50. Nil ⇒ the handler's category default applies.
	ExpiresAt *time.Time
}

// CreateMarket inserts a PENDING market row (the relayer submits createMarket
// onchain; the indexer flips it OPEN on MarketCreated).
func (s *Store) CreateMarket(ctx context.Context, p CreateMarketParams) (uuid.UUID, error) {
	srcJSON, err := json.Marshal(p.Sources)
	if err != nil {
		return uuid.Nil, err
	}
	var id uuid.UUID
	err = s.pool.QueryRow(ctx, `
		INSERT INTO markets (creator_id, title, question, settlement_query, category, rule, sources, status, expires_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING',$8) RETURNING id`,
		p.CreatorID, p.Title, p.Question, p.SettlementQuery, p.Category, p.Rule, srcJSON, p.ExpiresAt).Scan(&id)
	return id, err
}

// expiredMarket is one row auto-resolved 50/50 by ExpireDueMarkets.
type ExpiredMarket struct {
	ID        uuid.UUID
	CreatorID uuid.UUID
	Title     string
}

// ExpireDueMarkets resolves every past-due, unsettled market 50/50: status
// SETTLED with resolved_fifty and no winning direction. Returns the affected
// rows so the caller can notify and fan out.
func (s *Store) ExpireDueMarkets(ctx context.Context) ([]ExpiredMarket, error) {
	rows, err := s.pool.Query(ctx, `
		UPDATE markets SET status='SETTLED', resolved_fifty=true, direction=NULL, updated_at=now()
		WHERE expires_at IS NOT NULL AND expires_at < now()
		  AND status IN ('OPEN','MATCHED','SETTLING')
		RETURNING id, creator_id, title`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ExpiredMarket{}
	for rows.Next() {
		var m ExpiredMarket
		if err := rows.Scan(&m.ID, &m.CreatorID, &m.Title); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// GetMarket loads the market detail (public settlement query included), with
// the caller's like state and — always visible to the caller — their own
// position.
func (s *Store) GetMarket(ctx context.Context, viewerID, marketID uuid.UUID) (*structs.Market, error) {
	var m structs.Market
	var posJSON, srcJSON []byte
	err := s.pool.QueryRow(ctx, `
		SELECT `+marketSummaryCols+`, m.settlement_query, m.category, m.rule, m.sources, m.creator_fee_accrued,
		       `+userBriefCols+`,
		       (SELECT count(*) FROM comments c WHERE c.market_id=m.id),
		       (SELECT count(*) FROM likes l WHERE l.subject_type='market' AND l.subject_id=m.id),
		       EXISTS(SELECT 1 FROM likes l WHERE l.subject_type='market' AND l.subject_id=m.id AND l.user_id=$1),
		       (SELECT json_build_object('market_id', ps.market_id, 'side', ps.side, 'shares', ps.shares,
		               'avg_price_cents', ps.avg_price_cents, 'realized_pnl', ps.realized_pnl)
		        FROM positions ps WHERE ps.market_id=m.id AND ps.user_id=$1 AND (ps.shares>0 OR ps.realized_pnl<>0)
		        ORDER BY ps.shares DESC LIMIT 1)
		FROM markets m JOIN users u ON u.id=m.creator_id
		WHERE m.id=$2`, viewerID, marketID,
	).Scan(&m.ID, &m.ChainMarketID, &m.Title, &m.Question, &m.Status, &m.Direction,
		&m.YesPriceCents, &m.NoPriceCents, &m.Volume, &m.ExpiresAt, &m.ResolvedFifty, &m.CreatedAt,
		&m.SettlementQuery, &m.Category, &m.Rule, &srcJSON, &m.CreatorFeeAccrued,
		&m.Creator.ID, &m.Creator.Username, &m.Creator.DisplayName, &m.Creator.AvatarURL,
		&m.CommentCount, &m.LikeCount, &m.LikedByMe, &posJSON)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	m.Sources = []structs.SourceRef{}
	if len(srcJSON) > 0 {
		_ = json.Unmarshal(srcJSON, &m.Sources)
	}
	if len(posJSON) > 0 {
		var p structs.Position
		if json.Unmarshal(posJSON, &p) == nil && p.Side != "" {
			m.MyPosition = &p
		}
	}
	return &m, nil
}

// MarketBook aggregates resting orders into price levels plus recent trades.
// (The chain book is source of truth; this mirror is maintained by the indexer
// through order statuses.)
func (s *Store) MarketBook(ctx context.Context, marketID uuid.UUID) (*structs.Book, error) {
	book := &structs.Book{MarketID: marketID, Yes: []structs.BookLevel{}, No: []structs.BookLevel{}, Trades: []structs.BookTrade{}}
	rows, err := s.pool.Query(ctx, `
		SELECT side, price_cents, sum(shares - filled_shares)::bigint
		FROM orders
		WHERE market_id=$1 AND status IN ('RESTING','PARTIAL')
		GROUP BY side, price_cents
		ORDER BY price_cents DESC`, marketID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var side string
		var lvl structs.BookLevel
		if err := rows.Scan(&side, &lvl.PriceCents, &lvl.Shares); err != nil {
			rows.Close()
			return nil, err
		}
		if side == "yes" {
			book.Yes = append(book.Yes, lvl)
		} else {
			book.No = append(book.No, lvl)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	trows, err := s.pool.Query(ctx, `
		SELECT price_cents, shares, created_at FROM fills
		WHERE market_id=$1 ORDER BY created_at DESC LIMIT 30`, marketID)
	if err != nil {
		return nil, err
	}
	defer trows.Close()
	for trows.Next() {
		var t structs.BookTrade
		if err := trows.Scan(&t.PriceCents, &t.Shares, &t.CreatedAt); err != nil {
			return nil, err
		}
		book.Trades = append(book.Trades, t)
	}
	return book, trows.Err()
}

// MarketChainID returns the onchain id for a market (nil when not yet created).
func (s *Store) MarketChainID(ctx context.Context, marketID uuid.UUID) (*int64, string, error) {
	var chainID *int64
	var status string
	err := s.pool.QueryRow(ctx,
		`SELECT chain_market_id, status FROM markets WHERE id=$1`, marketID).Scan(&chainID, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, "", nil
	}
	return chainID, status, err
}

// MarketByChainID resolves a chain market id to the local row.
func (s *Store) MarketByChainID(ctx context.Context, chainMarketID int64) (uuid.UUID, error) {
	var id uuid.UUID
	err := s.pool.QueryRow(ctx,
		`SELECT id FROM markets WHERE chain_market_id=$1`, chainMarketID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, nil
	}
	return id, err
}

// RequestSettlement stores the settle request (5c fee auth) and flags the
// market for the settlement runner. Only OPEN/MATCHED markets are eligible.
func (s *Store) RequestSettlement(ctx context.Context, marketID, userID uuid.UUID, auth any) (bool, error) {
	authJSON, err := json.Marshal(auth)
	if err != nil {
		return false, err
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE markets SET settle_requested_by=$2, settle_auth=$3, updated_at=now()
		WHERE id=$1 AND status IN ('OPEN','MATCHED')`, marketID, userID, authJSON)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// LogMarketGeneration writes the guardrail audit row.
func (s *Store) LogMarketGeneration(ctx context.Context, userID uuid.UUID, raw, sanitized string, candidates any, flagged bool) error {
	b, err := json.Marshal(candidates)
	if err != nil {
		b = []byte("[]")
	}
	_, err = s.pool.Exec(ctx, `
		INSERT INTO market_generation_logs (user_id, raw_input, sanitized_input, candidates, flagged)
		VALUES ($1,$2,$3,$4,$5)`, userID, raw, sanitized, b, flagged)
	return err
}

func scanMarketSummaries(rows pgx.Rows) ([]structs.MarketSummary, error) {
	defer rows.Close()
	out := []structs.MarketSummary{}
	for rows.Next() {
		var m structs.MarketSummary
		if err := rows.Scan(&m.ID, &m.ChainMarketID, &m.Title, &m.Question, &m.Status,
			&m.Direction, &m.YesPriceCents, &m.NoPriceCents, &m.Volume,
			&m.ExpiresAt, &m.ResolvedFifty, &m.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func scanMarketSummary(row pgx.Row, m *structs.MarketSummary, extra ...any) error {
	dest := []any{&m.ID, &m.ChainMarketID, &m.Title, &m.Question, &m.Status,
		&m.Direction, &m.YesPriceCents, &m.NoPriceCents, &m.Volume,
		&m.ExpiresAt, &m.ResolvedFifty, &m.CreatedAt}
	dest = append(dest, extra...)
	return row.Scan(dest...)
}

// MarketSummaryByID loads one summary (nil when missing).
func (s *Store) MarketSummaryByID(ctx context.Context, id uuid.UUID) (*structs.MarketSummary, error) {
	row := s.pool.QueryRow(ctx,
		fmt.Sprintf(`SELECT %s FROM markets m WHERE m.id=$1`, marketSummaryCols), id)
	var m structs.MarketSummary
	if err := scanMarketSummary(row, &m); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return &m, nil
}
