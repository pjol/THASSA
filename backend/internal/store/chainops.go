package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pjol/THASSA/backend/internal/structs"
)

// ---------------------------------------------------------------------------
// Relayer queue
// ---------------------------------------------------------------------------

// QueuedOrder is a signed order awaiting relay.
type QueuedOrder struct {
	ID              uuid.UUID
	MarketID        uuid.UUID
	UserID          uuid.UUID
	ChainMarketID   *int64
	Side            string
	PriceCents      int
	Shares          int64
	MakerAddress    string
	MaxCost         int64
	Expiry          int64
	Nonce           int64
	OrderDigest     string
	Auth3009        json.RawMessage
	AffiliatePostID *uuid.UUID
	IsMarketCreate  bool
	Question        string
	SettlementQuery string
}

// ClaimQueuedOrders atomically moves up to max QUEUED orders into a new
// relayer batch and returns them. Market-create orders are only claimed when
// standalone (they are submitted via createMarket, not the batch call).
func (s *Store) ClaimQueuedOrders(ctx context.Context, max int) (uuid.UUID, []QueuedOrder, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return uuid.Nil, nil, err
	}
	defer tx.Rollback(ctx)

	var batchID uuid.UUID
	if err := tx.QueryRow(ctx,
		`INSERT INTO relayer_batches (status) VALUES ('building') RETURNING id`).Scan(&batchID); err != nil {
		return uuid.Nil, nil, err
	}
	rows, err := tx.Query(ctx, `
		UPDATE orders o SET batch_id=$1, updated_at=now()
		WHERE o.id IN (
			SELECT id FROM orders
			WHERE status='QUEUED' AND batch_id IS NULL
			ORDER BY created_at
			LIMIT $2
			FOR UPDATE SKIP LOCKED)
		RETURNING o.id, o.market_id, o.user_id, o.side, o.price_cents, o.shares,
		          o.maker_address, o.max_cost, o.expiry, o.nonce, COALESCE(o.order_digest,''),
		          COALESCE(o.auth3009,'null'::jsonb), o.affiliate_post_id, o.is_market_create`,
		batchID, max)
	if err != nil {
		return uuid.Nil, nil, err
	}
	var out []QueuedOrder
	for rows.Next() {
		var q QueuedOrder
		if err := rows.Scan(&q.ID, &q.MarketID, &q.UserID, &q.Side, &q.PriceCents, &q.Shares,
			&q.MakerAddress, &q.MaxCost, &q.Expiry, &q.Nonce, &q.OrderDigest,
			&q.Auth3009, &q.AffiliatePostID, &q.IsMarketCreate); err != nil {
			rows.Close()
			return uuid.Nil, nil, err
		}
		out = append(out, q)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return uuid.Nil, nil, err
	}
	if len(out) == 0 {
		_, _ = tx.Exec(ctx, `DELETE FROM relayer_batches WHERE id=$1`, batchID)
		if err := tx.Commit(ctx); err != nil {
			return uuid.Nil, nil, err
		}
		return uuid.Nil, nil, nil
	}
	if _, err := tx.Exec(ctx,
		`UPDATE relayer_batches SET order_count=$2, updated_at=now() WHERE id=$1`,
		batchID, len(out)); err != nil {
		return uuid.Nil, nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return uuid.Nil, nil, err
	}

	// Enrich with market chain ids + creation strings (outside the tx, read-only).
	for i := range out {
		_ = s.pool.QueryRow(ctx,
			`SELECT chain_market_id, question, settlement_query FROM markets WHERE id=$1`,
			out[i].MarketID).Scan(&out[i].ChainMarketID, &out[i].Question, &out[i].SettlementQuery)
	}
	return batchID, out, nil
}

// MarkBatch updates the batch lifecycle; on failure the orders are returned to
// the queue for the next tick.
func (s *Store) MarkBatch(ctx context.Context, batchID uuid.UUID, status, txHash, errMsg string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE relayer_batches SET status=$2, tx_hash=NULLIF($3,''), error=NULLIF($4,''), updated_at=now()
		WHERE id=$1`, batchID, status, txHash, errMsg)
	if err != nil {
		return err
	}
	if status == "failed" {
		_, err = s.pool.Exec(ctx, `
			UPDATE orders SET batch_id=NULL, updated_at=now()
			WHERE batch_id=$1 AND status='QUEUED'`, batchID)
	}
	return err
}

// CancelRequests returns resting orders flagged for onchain cancellation.
func (s *Store) CancelRequests(ctx context.Context, limit int) ([]QueuedOrder, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT o.id, o.market_id, o.user_id, m.chain_market_id, o.chain_order_id
		FROM orders o JOIN markets m ON m.id=o.market_id
		WHERE o.cancel_requested_at IS NOT NULL AND o.status IN ('RESTING','PARTIAL')
		  AND o.chain_order_id IS NOT NULL AND m.chain_market_id IS NOT NULL
		ORDER BY o.cancel_requested_at LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []QueuedOrder
	for rows.Next() {
		var q QueuedOrder
		var chainOrderID int64
		if err := rows.Scan(&q.ID, &q.MarketID, &q.UserID, &q.ChainMarketID, &chainOrderID); err != nil {
			return nil, err
		}
		q.Nonce = chainOrderID // reuse: chain order id for cancel calls
		out = append(out, q)
	}
	return out, rows.Err()
}

// ClearCancelRequest unflags an order after the cancel tx is submitted.
func (s *Store) ClearCancelRequest(ctx context.Context, orderID uuid.UUID) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE orders SET cancel_requested_at=NULL, updated_at=now() WHERE id=$1`, orderID)
	return err
}

// PendingSettlements returns markets whose settle request awaits the runner.
type PendingSettlement struct {
	MarketID      uuid.UUID
	ChainMarketID int64
	RequestedBy   uuid.UUID
	Auth          json.RawMessage
}

// PendingSettlements claims settle requests for this worker (FOR UPDATE SKIP
// LOCKED, N-worker safe; stale claims >2min are re-claimable so a crashed
// worker's requests are retried).
func (s *Store) PendingSettlements(ctx context.Context, limit int) ([]PendingSettlement, error) {
	rows, err := s.pool.Query(ctx, `
		UPDATE markets SET settle_claimed_at=now()
		WHERE id IN (
			SELECT id FROM markets
			WHERE settle_requested_by IS NOT NULL AND status IN ('OPEN','MATCHED')
			  AND chain_market_id IS NOT NULL
			  AND (settle_claimed_at IS NULL OR settle_claimed_at < now() - interval '2 minutes')
			ORDER BY updated_at
			LIMIT $1
			FOR UPDATE SKIP LOCKED)
		RETURNING id, chain_market_id, settle_requested_by, settle_auth`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []PendingSettlement
	for rows.Next() {
		var p PendingSettlement
		if err := rows.Scan(&p.MarketID, &p.ChainMarketID, &p.RequestedBy, &p.Auth); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// ClearSettlementRequest unflags after submission (indexer flips SETTLING on
// the SettlementRequested event).
func (s *Store) ClearSettlementRequest(ctx context.Context, marketID uuid.UUID) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE markets SET settle_requested_by=NULL, settle_auth=NULL, settle_claimed_at=NULL, updated_at=now() WHERE id=$1`, marketID)
	return err
}

// ReleaseSettlementClaim returns a claimed-but-failed settle request to the
// queue immediately.
func (s *Store) ReleaseSettlementClaim(ctx context.Context, marketID uuid.UUID) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE markets SET settle_claimed_at=NULL, updated_at=now() WHERE id=$1`, marketID)
	return err
}

// RecordChainEvent registers a processed log; returns false when the event
// was already processed (exactly-once across re-scans / overlapping backfills).
func (s *Store) RecordChainEvent(ctx context.Context, txHash string, logIndex int, name string, block int64) (bool, error) {
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO chain_events (tx_hash, log_index, name, block_number)
		VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, txHash, logIndex, name, block)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// CountRecentOrders supports the per-user relayed-order rate limit (stateless
// across instances: computed from the DB, not memory).
func (s *Store) CountRecentOrders(ctx context.Context, userID uuid.UUID, window time.Duration) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `
		SELECT count(*) FROM orders WHERE user_id=$1 AND created_at > now() - $2::interval`,
		userID, window.String()).Scan(&n)
	return n, err
}

// ---------------------------------------------------------------------------
// Generic relayed-call jobs (wallet sends, redeems)
// ---------------------------------------------------------------------------

// RelayerJob is one queued relayed call.
type RelayerJob struct {
	ID      uuid.UUID
	Kind    string // send | redeem
	UserID  uuid.UUID
	Payload json.RawMessage
}

// InsertRelayerJob enqueues a relayed call and returns its id.
func (s *Store) InsertRelayerJob(ctx context.Context, userID uuid.UUID, kind string, payload any) (uuid.UUID, error) {
	b, err := json.Marshal(payload)
	if err != nil {
		return uuid.Nil, err
	}
	var id uuid.UUID
	err = s.pool.QueryRow(ctx, `
		INSERT INTO relayer_jobs (kind, user_id, payload) VALUES ($1,$2,$3) RETURNING id`,
		kind, userID, b).Scan(&id)
	return id, err
}

// ClaimRelayerJobs claims queued jobs (SKIP LOCKED, N-worker safe).
func (s *Store) ClaimRelayerJobs(ctx context.Context, limit int) ([]RelayerJob, error) {
	rows, err := s.pool.Query(ctx, `
		UPDATE relayer_jobs SET status='submitted', updated_at=now()
		WHERE id IN (
			SELECT id FROM relayer_jobs WHERE status='queued'
			ORDER BY created_at LIMIT $1
			FOR UPDATE SKIP LOCKED)
		RETURNING id, kind, user_id, payload`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RelayerJob
	for rows.Next() {
		var j RelayerJob
		if err := rows.Scan(&j.ID, &j.Kind, &j.UserID, &j.Payload); err != nil {
			return nil, err
		}
		out = append(out, j)
	}
	return out, rows.Err()
}

// FinishRelayerJob records the outcome of a relayed call.
func (s *Store) FinishRelayerJob(ctx context.Context, id uuid.UUID, status, txHash, errMsg string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE relayer_jobs SET status=$2, tx_hash=NULLIF($3,''), error=NULLIF($4,''), updated_at=now()
		WHERE id=$1`, id, status, txHash, errMsg)
	return err
}

// RelayerJobStatus reads one job (owner-scoped).
func (s *Store) RelayerJobStatus(ctx context.Context, userID, id uuid.UUID) (status, txHash string, err error) {
	var tx *string
	err = s.pool.QueryRow(ctx,
		`SELECT status, tx_hash FROM relayer_jobs WHERE id=$1 AND user_id=$2`, id, userID).Scan(&status, &tx)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", nil
	}
	if tx != nil {
		txHash = *tx
	}
	return status, txHash, err
}

// ---------------------------------------------------------------------------
// Relayer nonce ledger (spec §6.7: nonce management survives failover)
// ---------------------------------------------------------------------------

// MaxRelayerNonce returns the highest recorded relayer nonce and whether any
// exists.
func (s *Store) MaxRelayerNonce(ctx context.Context) (int64, bool, error) {
	var n *int64
	if err := s.pool.QueryRow(ctx, `SELECT max(nonce) FROM relayer_txs`).Scan(&n); err != nil {
		return 0, false, err
	}
	if n == nil {
		return 0, false, nil
	}
	return *n, true, nil
}

// ReserveRelayerNonce records a nonce as pending before the tx is broadcast
// (idempotent claim: false when another worker holds it).
func (s *Store) ReserveRelayerNonce(ctx context.Context, nonce int64, kind string) (bool, error) {
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO relayer_txs (nonce, kind) VALUES ($1,$2)
		ON CONFLICT (nonce) DO NOTHING`, nonce, kind)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// RecordRelayerTx attaches the broadcast hash / final status to a nonce.
func (s *Store) RecordRelayerTx(ctx context.Context, nonce int64, txHash, status string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE relayer_txs SET tx_hash=COALESCE(NULLIF($2,''), tx_hash), status=$3, updated_at=now()
		WHERE nonce=$1`, nonce, txHash, status)
	return err
}

// ---------------------------------------------------------------------------
// Indexer writes
// ---------------------------------------------------------------------------

// Cursor persistence for log polling.
func (s *Store) ChainCursor(ctx context.Context, name string) (int64, error) {
	var n int64
	err := s.pool.QueryRow(ctx,
		`SELECT block_number FROM chain_cursors WHERE name=$1`, name).Scan(&n)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	return n, err
}

func (s *Store) SetChainCursor(ctx context.Context, name string, block int64) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO chain_cursors (name, block_number) VALUES ($1,$2)
		ON CONFLICT (name) DO UPDATE SET block_number=$2, updated_at=now()`, name, block)
	return err
}

// BindMarketCreated links a local PENDING market to its chain id and opens it.
// Matched by creator wallet + exact question when possible.
func (s *Store) BindMarketCreated(ctx context.Context, chainMarketID int64, creatorWallet, question string) (uuid.UUID, error) {
	var id uuid.UUID
	err := s.pool.QueryRow(ctx, `
		UPDATE markets SET chain_market_id=$1, status='OPEN', updated_at=now()
		WHERE id = (
			SELECT m.id FROM markets m JOIN users u ON u.id=m.creator_id
			WHERE m.chain_market_id IS NULL AND m.status='PENDING'
			  AND m.question=$3 AND lower(u.wallet_address)=lower($2)
			ORDER BY m.created_at LIMIT 1)
		RETURNING id`, chainMarketID, creatorWallet, question).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, nil
	}
	return id, err
}

// BindOrderPlaced attaches the chain order id to the oldest matching submitted
// order and flips it RESTING. Returns the order's user id (uuid.Nil when the
// order is unknown to the platform, e.g. placed directly onchain).
func (s *Store) BindOrderPlaced(ctx context.Context, marketID uuid.UUID, chainOrderID int64, maker string, side string, price int, shares int64) (uuid.UUID, uuid.UUID, error) {
	var orderID, userID uuid.UUID
	err := s.pool.QueryRow(ctx, `
		UPDATE orders SET chain_order_id=$2, status='RESTING', updated_at=now()
		WHERE id = (
			SELECT id FROM orders
			WHERE market_id=$1 AND chain_order_id IS NULL AND status='QUEUED'
			  AND lower(maker_address)=lower($3) AND side=$4 AND price_cents=$5 AND shares=$6
			ORDER BY created_at LIMIT 1)
		RETURNING id, user_id`, marketID, chainOrderID, maker, side, price, shares).Scan(&orderID, &userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, uuid.Nil, nil
	}
	return orderID, userID, err
}

// OrderByChainID resolves (market, chain order id) to the local order.
func (s *Store) OrderByChainID(ctx context.Context, marketID uuid.UUID, chainOrderID int64) (orderID, userID uuid.UUID, side string, err error) {
	err = s.pool.QueryRow(ctx, `
		SELECT id, user_id, side FROM orders WHERE market_id=$1 AND chain_order_id=$2`,
		marketID, chainOrderID).Scan(&orderID, &userID, &side)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, uuid.Nil, "", nil
	}
	return orderID, userID, side, err
}

// InsertFill records a match (idempotent on tx_hash+log_index) and advances
// the filled order states. Returns false when the fill was already recorded.
func (s *Store) InsertFill(ctx context.Context, f structs.BookTrade, marketID uuid.UUID, takerOrderID, makerOrderID *uuid.UUID, takerChainID, makerChainID int64, fee int64, txHash string, logIndex int) (bool, error) {
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO fills (market_id, taker_order_id, maker_order_id, taker_chain_order_id,
			maker_chain_order_id, price_cents, shares, fee, tx_hash, log_index)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
		ON CONFLICT (tx_hash, log_index) DO NOTHING`,
		marketID, takerOrderID, makerOrderID, takerChainID, makerChainID,
		f.PriceCents, f.Shares, fee, txHash, logIndex)
	if err != nil {
		return false, err
	}
	if tag.RowsAffected() == 0 {
		return false, nil
	}
	for _, oid := range []*uuid.UUID{takerOrderID, makerOrderID} {
		if oid == nil {
			continue
		}
		if _, err := s.pool.Exec(ctx, `
			UPDATE orders SET filled_shares = LEAST(filled_shares+$2, shares),
				status = CASE WHEN filled_shares+$2 >= shares THEN 'FILLED' ELSE 'PARTIAL' END,
				updated_at=now()
			WHERE id=$1 AND status IN ('RESTING','PARTIAL','QUEUED')`, *oid, f.Shares); err != nil {
			return true, err
		}
	}
	return true, nil
}

// MarkOrderCancelled flips a chain-cancelled order.
func (s *Store) MarkOrderCancelled(ctx context.Context, marketID uuid.UUID, chainOrderID int64) (uuid.UUID, error) {
	var userID uuid.UUID
	err := s.pool.QueryRow(ctx, `
		UPDATE orders SET status='CANCELED', cancel_requested_at=NULL, updated_at=now()
		WHERE market_id=$1 AND chain_order_id=$2 AND status IN ('RESTING','PARTIAL','QUEUED')
		RETURNING user_id`, marketID, chainOrderID).Scan(&userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, nil
	}
	return userID, err
}

// SetMarketStatus updates the lifecycle column (vocabulary verbatim) and
// returns the creator for notifications.
func (s *Store) SetMarketStatus(ctx context.Context, marketID uuid.UUID, status string) (uuid.UUID, error) {
	var creator uuid.UUID
	err := s.pool.QueryRow(ctx, `
		UPDATE markets SET status=$2, updated_at=now() WHERE id=$1 RETURNING creator_id`,
		marketID, status).Scan(&creator)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, nil
	}
	return creator, err
}

// SettleMarketRow records the oracle outcome.
func (s *Store) SettleMarketRow(ctx context.Context, marketID uuid.UUID, direction bool) (uuid.UUID, error) {
	var creator uuid.UUID
	err := s.pool.QueryRow(ctx, `
		UPDATE markets SET status='SETTLED', direction=$2, updated_at=now()
		WHERE id=$1 RETURNING creator_id`, marketID, direction).Scan(&creator)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, nil
	}
	return creator, err
}

// UpdateMarketPrices refreshes the best-price mirror + volume delta.
func (s *Store) UpdateMarketPrices(ctx context.Context, marketID uuid.UUID, bestYes, bestNo *int, volumeDelta int64) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE markets SET yes_price_cents=$2, no_price_cents=$3,
			volume=volume+$4, updated_at=now()
		WHERE id=$1`, marketID, bestYes, bestNo, volumeDelta)
	return err
}

// ApplyFillToPosition upserts the (market,user,side) position with a
// volume-weighted average price.
func (s *Store) ApplyFillToPosition(ctx context.Context, marketID, userID uuid.UUID, side string, priceCents int, shares int64) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO positions (market_id, user_id, side, shares, avg_price_cents)
		VALUES ($1,$2,$3,$4,$5)
		ON CONFLICT (market_id, user_id, side) DO UPDATE SET
			avg_price_cents = CASE WHEN positions.shares + EXCLUDED.shares > 0
				THEN (positions.avg_price_cents*positions.shares + EXCLUDED.avg_price_cents*EXCLUDED.shares)
				     / (positions.shares + EXCLUDED.shares)
				ELSE 0 END,
			shares = positions.shares + EXCLUDED.shares,
			updated_at = now()`,
		marketID, userID, side, shares, priceCents)
	return err
}

// SettlePositions computes realized PnL for every position of a settled
// market: winners realize (100 − avg)¢/share, losers −avg¢/share, in token
// units. Returns the affected user ids for notifications.
func (s *Store) SettlePositions(ctx context.Context, marketID uuid.UUID, direction bool, tokenUnit int64) ([]uuid.UUID, error) {
	winSide := "no"
	if direction {
		winSide = "yes"
	}
	rows, err := s.pool.Query(ctx, `
		UPDATE positions SET
			realized_pnl = CASE WHEN side=$2
				THEN ((100 - avg_price_cents) * shares * $3 / 100)::bigint
				ELSE (-(avg_price_cents * shares * $3 / 100))::bigint END,
			updated_at = now()
		WHERE market_id=$1 AND shares > 0
		RETURNING user_id`, marketID, winSide, tokenUnit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var users []uuid.UUID
	for rows.Next() {
		var u uuid.UUID
		if err := rows.Scan(&u); err != nil {
			return nil, err
		}
		users = append(users, u)
	}
	return users, rows.Err()
}

// InsertTransfer records an indexed payment-token transfer (idempotent).
func (s *Store) InsertTransfer(ctx context.Context, txHash string, logIndex int, from, to string, amount int64, block int64) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO transfers (tx_hash, log_index, from_addr, to_addr, amount, block_number)
		VALUES ($1,$2,lower($3),lower($4),$5,$6)
		ON CONFLICT DO NOTHING`, txHash, logIndex, from, to, amount, block)
	return err
}

// WalletActivity lists indexed transfers touching the wallet.
func (s *Store) WalletActivity(ctx context.Context, wallet string, limit int) ([]structs.TransferActivity, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT tx_hash, from_addr, to_addr, amount, block_number, created_at
		FROM transfers
		WHERE from_addr=lower($1) OR to_addr=lower($1)
		ORDER BY block_number DESC, log_index DESC LIMIT $2`, wallet, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []structs.TransferActivity{}
	for rows.Next() {
		var t structs.TransferActivity
		if err := rows.Scan(&t.TxHash, &t.From, &t.To, &t.Amount, &t.BlockNumber, &t.CreatedAt); err != nil {
			return nil, err
		}
		t.Direction = "in"
		if t.From == strings.ToLower(wallet) {
			t.Direction = "out"
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// CreateOnrampSession stores a provider session.
func (s *Store) CreateOnrampSession(ctx context.Context, userID uuid.UUID, provider, kind string, payload map[string]any) (uuid.UUID, error) {
	b, err := json.Marshal(payload)
	if err != nil {
		return uuid.Nil, err
	}
	var id uuid.UUID
	err = s.pool.QueryRow(ctx, `
		INSERT INTO onramp_sessions (user_id, provider, kind, payload)
		VALUES ($1,$2,$3,$4) RETURNING id`, userID, provider, kind, b).Scan(&id)
	return id, err
}

// UpdateOnrampSession updates status and merges extra keys into the payload.
func (s *Store) UpdateOnrampSession(ctx context.Context, id uuid.UUID, status string, extra map[string]any) error {
	b := []byte("{}")
	if extra != nil {
		if eb, err := json.Marshal(extra); err == nil {
			b = eb
		}
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE onramp_sessions SET status=$2, payload = payload || $3::jsonb, updated_at=now()
		WHERE id=$1`, id, status, b)
	return err
}

// CompleteCryptoDeposit credits an inbound payment-token transfer against the
// oldest pending crypto onramp session for that wallet (idempotent: each
// session completes once). Called by the chain watcher on Transfer events.
func (s *Store) CompleteCryptoDeposit(ctx context.Context, wallet string, amount int64, txHash string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE onramp_sessions SET status='completed',
			payload = payload || jsonb_build_object('credited_amount', $2::bigint, 'tx_hash', $3::text),
			updated_at=now()
		WHERE id = (
			SELECT os.id FROM onramp_sessions os
			WHERE os.kind='crypto' AND os.status IN ('created','pending')
			  AND lower(os.payload->>'wallet') = lower($1)
			ORDER BY os.created_at LIMIT 1)`,
		wallet, amount, txHash)
	return err
}
