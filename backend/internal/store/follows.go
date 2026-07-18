package store

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/pjol/THASSA/backend/internal/structs"
)

// Follow creates a follow edge. Following a private account creates a
// 'pending' follow request instead; the followee approves or denies it.
// Returns the resulting status ("pending" or "accepted"). A newly-created
// accepted edge maintains the denormalized counters + the large-entry
// aggregate in the same transaction (spec §7d.5).
func (s *Store) Follow(ctx context.Context, followerID, followeeID uuid.UUID) (string, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)

	var status string
	var inserted bool
	err = tx.QueryRow(ctx, `
		INSERT INTO follows (follower_id, followee_id, status)
		SELECT $1, $2, CASE WHEN u.is_private THEN 'pending' ELSE 'accepted' END
		FROM users u WHERE u.id=$2
		ON CONFLICT (follower_id, followee_id) DO UPDATE SET follower_id=EXCLUDED.follower_id
		RETURNING status, (xmax = 0)`, followerID, followeeID).Scan(&status, &inserted)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", errors.New("user not found")
	}
	if err != nil {
		return "", err
	}
	if inserted && status == "accepted" {
		if err := applyAcceptedFollow(ctx, tx, followerID, followeeID); err != nil {
			return "", err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return status, nil
}

// Unfollow removes a follow (or cancels a pending request). When an *accepted*
// edge is removed the counters + large-entry aggregate are decremented in the
// same transaction (guarded ≥ 0).
func (s *Store) Unfollow(ctx context.Context, followerID, followeeID uuid.UUID) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var status string
	err = tx.QueryRow(ctx,
		`DELETE FROM follows WHERE follower_id=$1 AND followee_id=$2 RETURNING status`,
		followerID, followeeID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return tx.Commit(ctx) // nothing to remove
	}
	if err != nil {
		return err
	}
	if status == "accepted" {
		if err := removeAcceptedFollow(ctx, tx, followerID, followeeID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// txExec is the subset of pgx used by the follow-counter helpers (satisfied by
// both *pgxpool.Pool and pgx.Tx).
type txExec interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// applyAcceptedFollow bumps follower/following counters and folds the followee's
// current entry stats into the follower's large-entry aggregate.
func applyAcceptedFollow(ctx context.Context, tx txExec, followerID, followeeID uuid.UUID) error {
	if _, err := tx.Exec(ctx,
		`UPDATE users SET follower_count = follower_count + 1 WHERE id=$1`, followeeID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE users SET following_count = following_count + 1 WHERE id=$1`, followerID); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO follow_entry_agg (follower_id, following_notional_sum, following_entry_count)
		SELECT $1::uuid, COALESCE(ues.notional_sum, 0), COALESCE(ues.entry_count, 0)
		FROM (SELECT $2::uuid AS uid) f
		LEFT JOIN user_entry_stats ues ON ues.user_id = f.uid
		ON CONFLICT (follower_id) DO UPDATE SET
			following_notional_sum = follow_entry_agg.following_notional_sum + EXCLUDED.following_notional_sum,
			following_entry_count  = follow_entry_agg.following_entry_count  + EXCLUDED.following_entry_count,
			updated_at = now()`, followerID, followeeID)
	return err
}

// removeAcceptedFollow reverses applyAcceptedFollow.
func removeAcceptedFollow(ctx context.Context, tx txExec, followerID, followeeID uuid.UUID) error {
	if _, err := tx.Exec(ctx,
		`UPDATE users SET follower_count = GREATEST(follower_count - 1, 0) WHERE id=$1`, followeeID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE users SET following_count = GREATEST(following_count - 1, 0) WHERE id=$1`, followerID); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `
		UPDATE follow_entry_agg SET
			following_notional_sum = GREATEST(following_notional_sum - COALESCE((SELECT notional_sum FROM user_entry_stats WHERE user_id=$2), 0), 0),
			following_entry_count  = GREATEST(following_entry_count  - COALESCE((SELECT entry_count  FROM user_entry_stats WHERE user_id=$2), 0), 0),
			updated_at = now()
		WHERE follower_id=$1`, followerID, followeeID)
	return err
}

// FollowRequests lists pending requests to follow the caller.
func (s *Store) FollowRequests(ctx context.Context, userID uuid.UUID) ([]structs.FollowRequest, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT f.id, `+userBriefCols+`, f.created_at
		FROM follows f JOIN users u ON u.id=f.follower_id
		WHERE f.followee_id=$1 AND f.status='pending'
		ORDER BY f.created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []structs.FollowRequest{}
	for rows.Next() {
		var fr structs.FollowRequest
		if err := rows.Scan(&fr.ID, &fr.Follower.ID, &fr.Follower.Username,
			&fr.Follower.DisplayName, &fr.Follower.AvatarURL, &fr.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, fr)
	}
	return out, rows.Err()
}

// ResolveFollowRequest approves or denies a pending request addressed to the
// caller. Returns the follower id (for notifications) and whether a row was
// affected.
func (s *Store) ResolveFollowRequest(ctx context.Context, requestID, followeeID uuid.UUID, approve bool) (uuid.UUID, bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return uuid.Nil, false, err
	}
	defer tx.Rollback(ctx)

	var followerID uuid.UUID
	if approve {
		err = tx.QueryRow(ctx, `
			UPDATE follows SET status='accepted'
			WHERE id=$1 AND followee_id=$2 AND status='pending'
			RETURNING follower_id`, requestID, followeeID).Scan(&followerID)
	} else {
		err = tx.QueryRow(ctx, `
			DELETE FROM follows
			WHERE id=$1 AND followee_id=$2 AND status='pending'
			RETURNING follower_id`, requestID, followeeID).Scan(&followerID)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, false, nil
	}
	if err != nil {
		return uuid.Nil, false, err
	}
	// Approving a request is an accepted follow: maintain counters + aggregate.
	if approve {
		if err := applyAcceptedFollow(ctx, tx, followerID, followeeID); err != nil {
			return uuid.Nil, false, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return uuid.Nil, false, err
	}
	return followerID, true, nil
}

// Followers lists accepted followers of a user.
func (s *Store) Followers(ctx context.Context, userID uuid.UUID, limit int) ([]structs.UserBrief, error) {
	return s.queryBriefs(ctx, `
		SELECT `+userBriefCols+`
		FROM follows f JOIN users u ON u.id=f.follower_id
		WHERE f.followee_id=$1 AND f.status='accepted'
		ORDER BY f.created_at DESC LIMIT $2`, userID, limit)
}

// Following lists who a user follows (accepted).
func (s *Store) Following(ctx context.Context, userID uuid.UUID, limit int) ([]structs.UserBrief, error) {
	return s.queryBriefs(ctx, `
		SELECT `+userBriefCols+`
		FROM follows f JOIN users u ON u.id=f.followee_id
		WHERE f.follower_id=$1 AND f.status='accepted'
		ORDER BY f.created_at DESC LIMIT $2`, userID, limit)
}

func (s *Store) queryBriefs(ctx context.Context, sql string, args ...any) ([]structs.UserBrief, error) {
	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []structs.UserBrief{}
	for rows.Next() {
		var b structs.UserBrief
		if err := rows.Scan(&b.ID, &b.Username, &b.DisplayName, &b.AvatarURL); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}
