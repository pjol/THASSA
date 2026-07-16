package store

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"

	"github.com/pjol/THASSA/backend/internal/structs"
)

// InsertNotification stores an in-app notification and returns it.
func (s *Store) InsertNotification(ctx context.Context, userID uuid.UUID, kind string, payload map[string]any) (*structs.Notification, error) {
	b, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	var n structs.Notification
	var pj []byte
	err = s.pool.QueryRow(ctx, `
		INSERT INTO notifications (user_id, kind, payload) VALUES ($1,$2,$3)
		RETURNING id, kind, payload, read_at, created_at`,
		userID, kind, b).Scan(&n.ID, &n.Kind, &pj, &n.ReadAt, &n.CreatedAt)
	if err != nil {
		return nil, err
	}
	n.Payload = map[string]any{}
	_ = json.Unmarshal(pj, &n.Payload)
	return &n, nil
}

// Notifications lists the caller's notifications, newest first.
func (s *Store) Notifications(ctx context.Context, userID uuid.UUID, o FeedOpts) ([]structs.Notification, *string, error) {
	sql := `SELECT id, kind, payload, read_at, created_at FROM notifications WHERE user_id=$1`
	args := []any{userID}
	if o.Cursor != nil {
		sql += ` AND (created_at, id) < ($2, $3)`
		args = append(args, o.Cursor.CreatedAt, o.Cursor.ID)
	}
	sql += fmt.Sprintf(` ORDER BY created_at DESC, id DESC LIMIT %d`, o.Limit)
	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	out := []structs.Notification{}
	for rows.Next() {
		var n structs.Notification
		var pj []byte
		if err := rows.Scan(&n.ID, &n.Kind, &pj, &n.ReadAt, &n.CreatedAt); err != nil {
			return nil, nil, err
		}
		n.Payload = map[string]any{}
		_ = json.Unmarshal(pj, &n.Payload)
		out = append(out, n)
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

// Badges returns the bottom-bar counters: unread notifications and the number
// of conversations with unread messages.
func (s *Store) Badges(ctx context.Context, userID uuid.UUID) (notifications, messages int, err error) {
	err = s.pool.QueryRow(ctx, `
		SELECT
			(SELECT count(*) FROM notifications WHERE user_id=$1 AND read_at IS NULL),
			(SELECT count(*) FROM conversation_members cm
			 WHERE cm.user_id=$1 AND EXISTS (
				SELECT 1 FROM messages m
				WHERE m.conversation_id=cm.conversation_id AND m.sender_id<>$1
				  AND (cm.last_read_at IS NULL OR m.created_at > cm.last_read_at)))`,
		userID).Scan(&notifications, &messages)
	return notifications, messages, err
}

// MarkNotificationsRead stamps the given ids (or all when ids is empty).
func (s *Store) MarkNotificationsRead(ctx context.Context, userID uuid.UUID, ids []uuid.UUID) error {
	if len(ids) == 0 {
		_, err := s.pool.Exec(ctx,
			`UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL`, userID)
		return err
	}
	_, err := s.pool.Exec(ctx,
		`UPDATE notifications SET read_at=now() WHERE user_id=$1 AND id=ANY($2) AND read_at IS NULL`,
		userID, ids)
	return err
}
