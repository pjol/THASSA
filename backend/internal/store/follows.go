package store

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pjol/THASSA/backend/internal/structs"
)

// Follow creates a follow edge. Following a private account creates a
// 'pending' follow request instead; the followee approves or denies it.
// Returns the resulting status ("pending" or "accepted").
func (s *Store) Follow(ctx context.Context, followerID, followeeID uuid.UUID) (string, error) {
	var status string
	err := s.pool.QueryRow(ctx, `
		INSERT INTO follows (follower_id, followee_id, status)
		SELECT $1, $2, CASE WHEN u.is_private THEN 'pending' ELSE 'accepted' END
		FROM users u WHERE u.id=$2
		ON CONFLICT (follower_id, followee_id) DO UPDATE SET follower_id=EXCLUDED.follower_id
		RETURNING status`, followerID, followeeID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", errors.New("user not found")
	}
	return status, err
}

// Unfollow removes a follow (or cancels a pending request).
func (s *Store) Unfollow(ctx context.Context, followerID, followeeID uuid.UUID) error {
	_, err := s.pool.Exec(ctx,
		`DELETE FROM follows WHERE follower_id=$1 AND followee_id=$2`, followerID, followeeID)
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
	var followerID uuid.UUID
	var err error
	if approve {
		err = s.pool.QueryRow(ctx, `
			UPDATE follows SET status='accepted'
			WHERE id=$1 AND followee_id=$2 AND status='pending'
			RETURNING follower_id`, requestID, followeeID).Scan(&followerID)
	} else {
		err = s.pool.QueryRow(ctx, `
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
