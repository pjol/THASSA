package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"

	"github.com/pjol/THASSA/backend/internal/structs"
)

const commentSelect = `
	SELECT c.id, c.post_id, c.market_id, c.parent_id, ` + userBriefCols + `,
	       c.body, c.like_count,
	       EXISTS(SELECT 1 FROM likes l WHERE l.subject_type='comment' AND l.subject_id=c.id AND l.user_id=$1),
	       c.created_at
	FROM comments c JOIN users u ON u.id=c.author_id`

// PostComments lists a post's comments (top-level + replies flat, oldest
// first; the client threads by parent_id), keyset paginated.
func (s *Store) PostComments(ctx context.Context, viewerID, postID uuid.UUID, o FeedOpts) ([]structs.Comment, *string, error) {
	sql := commentSelect + ` WHERE c.post_id=$2`
	args := []any{viewerID, postID}
	if o.Cursor != nil {
		sql += ` AND (c.created_at, c.id) > ($3, $4)`
		args = append(args, o.Cursor.CreatedAt, o.Cursor.ID)
	}
	sql += fmt.Sprintf(` ORDER BY c.created_at ASC, c.id ASC LIMIT %d`, o.Limit)
	return s.pageComments(ctx, sql, o.Limit, args...)
}

// MarketComments lists a market's comments.
func (s *Store) MarketComments(ctx context.Context, viewerID, marketID uuid.UUID, o FeedOpts) ([]structs.Comment, *string, error) {
	sql := commentSelect + ` WHERE c.market_id=$2`
	args := []any{viewerID, marketID}
	if o.Cursor != nil {
		sql += ` AND (c.created_at, c.id) > ($3, $4)`
		args = append(args, o.Cursor.CreatedAt, o.Cursor.ID)
	}
	sql += fmt.Sprintf(` ORDER BY c.created_at ASC, c.id ASC LIMIT %d`, o.Limit)
	return s.pageComments(ctx, sql, o.Limit, args...)
}

// CreateComment attaches a comment to a post OR a market (exactly one),
// optionally as a reply via parentID. Returns the created comment.
func (s *Store) CreateComment(ctx context.Context, authorID uuid.UUID, postID, marketID, parentID *uuid.UUID, body string) (*structs.Comment, error) {
	if (postID == nil) == (marketID == nil) {
		return nil, errors.New("comment must attach to exactly one of post or market")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	var c structs.Comment
	if err := tx.QueryRow(ctx, `
		INSERT INTO comments (post_id, market_id, author_id, parent_id, body)
		VALUES ($1,$2,$3,$4,$5)
		RETURNING id, post_id, market_id, parent_id, body, like_count, created_at`,
		postID, marketID, authorID, parentID, body,
	).Scan(&c.ID, &c.PostID, &c.MarketID, &c.ParentID, &c.Body, &c.LikeCount, &c.CreatedAt); err != nil {
		return nil, err
	}
	if postID != nil {
		if _, err := tx.Exec(ctx,
			`UPDATE posts SET comment_count=comment_count+1, updated_at=now() WHERE id=$1`, *postID); err != nil {
			return nil, err
		}
	}
	if err := tx.QueryRow(ctx,
		`SELECT `+userBriefCols+` FROM users u WHERE u.id=$1`, authorID,
	).Scan(&c.Author.ID, &c.Author.Username, &c.Author.DisplayName, &c.Author.AvatarURL); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &c, nil
}

// DeleteComment removes the caller's own comment.
func (s *Store) DeleteComment(ctx context.Context, authorID, commentID uuid.UUID) (bool, error) {
	var postID *uuid.UUID
	err := s.pool.QueryRow(ctx,
		`DELETE FROM comments WHERE id=$1 AND author_id=$2 RETURNING post_id`,
		commentID, authorID).Scan(&postID)
	if err != nil {
		return false, nil //nolint:nilerr // no rows = not found/not owner
	}
	if postID != nil {
		_, _ = s.pool.Exec(ctx,
			`UPDATE posts SET comment_count=GREATEST(comment_count-1,0), updated_at=now() WHERE id=$1`, *postID)
	}
	return true, nil
}

func (s *Store) pageComments(ctx context.Context, sql string, limit int, args ...any) ([]structs.Comment, *string, error) {
	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	out := []structs.Comment{}
	for rows.Next() {
		var c structs.Comment
		if err := rows.Scan(&c.ID, &c.PostID, &c.MarketID, &c.ParentID,
			&c.Author.ID, &c.Author.Username, &c.Author.DisplayName, &c.Author.AvatarURL,
			&c.Body, &c.LikeCount, &c.LikedByMe, &c.CreatedAt); err != nil {
			return nil, nil, err
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	var next *string
	if n := len(out); n > 0 && n >= limit {
		next = NextCursor(n, limit, out[n-1].CreatedAt, out[n-1].ID)
	}
	return out, next, nil
}
