package store

import (
	"context"
	"fmt"

	"github.com/google/uuid"

	"github.com/pjol/THASSA/backend/internal/structs"
)

// UserTrades returns a user's fills (as taker or maker) with the settled PnL
// of the touched market position. Access control (trades_visibility +
// private-account rule) is enforced by the HANDLER via CanViewTrades before
// calling this.
func (s *Store) UserTrades(ctx context.Context, targetUserID uuid.UUID, o FeedOpts) ([]structs.Trade, *string, error) {
	sql := `
		SELECT f.market_id, m.question, m.status, m.direction,
		       o.side, (o.id = f.taker_order_id) AS taker,
		       f.price_cents, f.shares,
		       CASE WHEN o.id = f.taker_order_id THEN f.fee ELSE 0 END,
		       CASE WHEN m.status='SETTLED' THEN
		           (SELECT sum(ps.realized_pnl)::bigint FROM positions ps
		            WHERE ps.market_id=f.market_id AND ps.user_id=$1)
		       END,
		       f.created_at, f.id
		FROM fills f
		JOIN orders o ON (o.id = f.taker_order_id OR o.id = f.maker_order_id) AND o.user_id = $1
		JOIN markets m ON m.id = f.market_id
		WHERE 1=1`
	args := []any{targetUserID}
	if o.Cursor != nil {
		sql += ` AND (f.created_at, f.id) < ($2, $3)`
		args = append(args, o.Cursor.CreatedAt, o.Cursor.ID)
	}
	sql += fmt.Sprintf(` ORDER BY f.created_at DESC, f.id DESC LIMIT %d`, o.Limit)

	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	out := []structs.Trade{}
	var lastID uuid.UUID
	for rows.Next() {
		var t structs.Trade
		if err := rows.Scan(&t.MarketID, &t.Question, &t.Status, &t.Direction,
			&t.Side, &t.Taker, &t.PriceCents, &t.Shares, &t.Fee, &t.RealizedPnl,
			&t.CreatedAt, &lastID); err != nil {
			return nil, nil, err
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	var next *string
	if n := len(out); n > 0 && n >= o.Limit {
		next = NextCursor(n, o.Limit, out[n-1].CreatedAt, lastID)
	}
	return out, next, nil
}
