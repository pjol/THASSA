package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pjol/THASSA/backend/internal/structs"
)

// NewOrderParams is a validated signed order ready for the relayer queue.
type NewOrderParams struct {
	MarketID         uuid.UUID
	UserID           uuid.UUID
	Side             string // yes | no
	PriceCents       int
	Shares           int64
	MakerAddress     string
	MaxCost          int64
	Expiry           int64
	Nonce            int64
	// OrderDigest is the EIP-712 digest (hex) — the canonical onchain order
	// identity; the EIP-3009 auth nonce equals it (spec §9).
	OrderDigest     string
	Auth3009        any
	AffiliatePostID *uuid.UUID
	IsMarketCreate  bool
	IdempotencyKey  *string
}

// InsertQueuedOrder stores a signed order in QUEUED state for the relayer.
// When an idempotency key matches an existing order, that order is returned.
func (s *Store) InsertQueuedOrder(ctx context.Context, p NewOrderParams) (*structs.Order, error) {
	if p.IdempotencyKey != nil {
		var existing uuid.UUID
		err := s.pool.QueryRow(ctx,
			`SELECT id FROM orders WHERE idempotency_key=$1`, *p.IdempotencyKey).Scan(&existing)
		if err == nil {
			return s.GetOrder(ctx, p.UserID, existing)
		}
	}
	// The order digest is unique: resubmitting the same signed order returns
	// the existing row instead of double-spending.
	if p.OrderDigest != "" {
		var existing uuid.UUID
		err := s.pool.QueryRow(ctx,
			`SELECT id FROM orders WHERE order_digest=$1 AND user_id=$2`, p.OrderDigest, p.UserID).Scan(&existing)
		if err == nil {
			return s.GetOrder(ctx, p.UserID, existing)
		}
	}
	authJSON, err := json.Marshal(p.Auth3009)
	if err != nil {
		return nil, err
	}
	var id uuid.UUID
	err = s.pool.QueryRow(ctx, `
		INSERT INTO orders (market_id, user_id, side, price_cents, shares, status,
			maker_address, max_cost, expiry, nonce, order_digest, auth3009,
			affiliate_post_id, is_market_create, idempotency_key)
		VALUES ($1,$2,$3,$4,$5,'QUEUED',$6,$7,$8,$9,$10,$11,$12,$13,$14)
		RETURNING id`,
		p.MarketID, p.UserID, p.Side, p.PriceCents, p.Shares,
		p.MakerAddress, p.MaxCost, p.Expiry, p.Nonce, p.OrderDigest, authJSON,
		p.AffiliatePostID, p.IsMarketCreate, p.IdempotencyKey).Scan(&id)
	if err != nil {
		return nil, err
	}
	return s.GetOrder(ctx, p.UserID, id)
}

const orderCols = `o.id, o.market_id, o.side, o.price_cents, o.shares, o.filled_shares,
	o.status, o.chain_order_id, o.max_cost, o.created_at`

// GetOrder loads one of the caller's orders (nil when missing/foreign).
func (s *Store) GetOrder(ctx context.Context, userID, orderID uuid.UUID) (*structs.Order, error) {
	var o structs.Order
	err := s.pool.QueryRow(ctx,
		`SELECT `+orderCols+` FROM orders o WHERE o.id=$1 AND o.user_id=$2`, orderID, userID,
	).Scan(&o.ID, &o.MarketID, &o.Side, &o.PriceCents, &o.Shares, &o.FilledShares,
		&o.Status, &o.ChainOrderID, &o.MaxCost, &o.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &o, nil
}

// ListOrders returns the caller's orders, optionally filtered by market.
func (s *Store) ListOrders(ctx context.Context, userID uuid.UUID, marketID *uuid.UUID, o FeedOpts) ([]structs.Order, *string, error) {
	sql := `SELECT ` + orderCols + `, ` + marketSummaryCols + `
		FROM orders o JOIN markets m ON m.id=o.market_id
		WHERE o.user_id=$1`
	args := []any{userID}
	n := 2
	if marketID != nil {
		sql += fmt.Sprintf(` AND o.market_id=$%d`, n)
		args = append(args, *marketID)
		n++
	}
	if o.Cursor != nil {
		sql += fmt.Sprintf(` AND (o.created_at, o.id) < ($%d, $%d)`, n, n+1)
		args = append(args, o.Cursor.CreatedAt, o.Cursor.ID)
	}
	sql += fmt.Sprintf(` ORDER BY o.created_at DESC, o.id DESC LIMIT %d`, o.Limit)

	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	out := []structs.Order{}
	for rows.Next() {
		var ord structs.Order
		var m structs.MarketSummary
		if err := rows.Scan(&ord.ID, &ord.MarketID, &ord.Side, &ord.PriceCents, &ord.Shares,
			&ord.FilledShares, &ord.Status, &ord.ChainOrderID, &ord.MaxCost, &ord.CreatedAt,
			&m.ID, &m.ChainMarketID, &m.Title, &m.Question, &m.Status, &m.Direction,
			&m.YesPriceCents, &m.NoPriceCents, &m.Volume, &m.CreatedAt); err != nil {
			return nil, nil, err
		}
		ord.Market = &m
		out = append(out, ord)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	var next *string
	if n := len(out); n > 0 && n >= o.Limit {
		next = NextCursor(n, o.Limit, out[n-1].CreatedAt, out[n-1].ID)
	}
	return out, next, nil
}

// RequestCancel marks the caller's order for onchain cancellation. QUEUED
// orders that have not been submitted are cancelled immediately.
func (s *Store) RequestCancel(ctx context.Context, userID, orderID uuid.UUID) (*structs.Order, error) {
	// Fast path: still queued locally, never reached the chain.
	tag, err := s.pool.Exec(ctx, `
		UPDATE orders SET status='CANCELED', updated_at=now()
		WHERE id=$1 AND user_id=$2 AND status='QUEUED' AND batch_id IS NULL`, orderID, userID)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		if _, err := s.pool.Exec(ctx, `
			UPDATE orders SET cancel_requested_at=now(), updated_at=now()
			WHERE id=$1 AND user_id=$2 AND status IN ('RESTING','PARTIAL') AND cancel_requested_at IS NULL`,
			orderID, userID); err != nil {
			return nil, err
		}
	}
	return s.GetOrder(ctx, userID, orderID)
}

// Positions lists the caller's positions with market summaries.
func (s *Store) Positions(ctx context.Context, userID uuid.UUID) ([]structs.Position, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT p.market_id, p.side, p.shares, p.avg_price_cents, p.realized_pnl, `+marketSummaryCols+`
		FROM positions p JOIN markets m ON m.id=p.market_id
		WHERE p.user_id=$1 AND (p.shares > 0 OR p.realized_pnl <> 0)
		ORDER BY p.updated_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []structs.Position{}
	for rows.Next() {
		var p structs.Position
		var m structs.MarketSummary
		if err := rows.Scan(&p.MarketID, &p.Side, &p.Shares, &p.AvgPriceCents, &p.RealizedPnl,
			&m.ID, &m.ChainMarketID, &m.Title, &m.Question, &m.Status, &m.Direction,
			&m.YesPriceCents, &m.NoPriceCents, &m.Volume, &m.CreatedAt); err != nil {
			return nil, err
		}
		p.Market = &m
		out = append(out, p)
	}
	return out, rows.Err()
}

// NextOrderNonce returns the next per-maker sequential nonce the platform
// expects (mirrors the contract's nonces mapping for queued orders).
func (s *Store) NextOrderNonce(ctx context.Context, makerAddress string) (int64, error) {
	var next int64
	err := s.pool.QueryRow(ctx, `
		SELECT COALESCE(MAX(nonce)+1, 0) FROM orders
		WHERE lower(maker_address)=lower($1) AND status <> 'CANCELED'`, makerAddress).Scan(&next)
	return next, err
}
