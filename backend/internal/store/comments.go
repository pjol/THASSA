package store

import (
	"context"
	"encoding/json"
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
// optionally as a reply via parentID. @-mentions (spec §7d.2) are stored
// verbatim in comments.mentions and normalized into comment_mentions (deduped).
// Returns the created comment (with mentions resolved to current profiles) and
// the deduped set of mentioned user ids (for post.mention notifications).
func (s *Store) CreateComment(ctx context.Context, authorID uuid.UUID, postID, marketID, parentID *uuid.UUID, body string, mentions []structs.MentionInput) (*structs.Comment, []uuid.UUID, error) {
	if (postID == nil) == (marketID == nil) {
		return nil, nil, errors.New("comment must attach to exactly one of post or market")
	}
	if mentions == nil {
		mentions = []structs.MentionInput{}
	}
	mentionsJSON, err := json.Marshal(mentions)
	if err != nil {
		return nil, nil, err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, nil, err
	}
	defer tx.Rollback(ctx)

	var c structs.Comment
	if err := tx.QueryRow(ctx, `
		INSERT INTO comments (post_id, market_id, author_id, parent_id, body, mentions)
		VALUES ($1,$2,$3,$4,$5,$6)
		RETURNING id, post_id, market_id, parent_id, body, like_count, created_at`,
		postID, marketID, authorID, parentID, body, mentionsJSON,
	).Scan(&c.ID, &c.PostID, &c.MarketID, &c.ParentID, &c.Body, &c.LikeCount, &c.CreatedAt); err != nil {
		return nil, nil, err
	}
	if postID != nil {
		if _, err := tx.Exec(ctx,
			`UPDATE posts SET comment_count=comment_count+1, updated_at=now() WHERE id=$1`, *postID); err != nil {
			return nil, nil, err
		}
	}
	seen := map[uuid.UUID]bool{}
	mentionedIDs := []uuid.UUID{}
	for _, m := range mentions {
		if m.UserID == uuid.Nil || seen[m.UserID] {
			continue
		}
		seen[m.UserID] = true
		mentionedIDs = append(mentionedIDs, m.UserID)
		if _, err := tx.Exec(ctx,
			`INSERT INTO comment_mentions (comment_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
			c.ID, m.UserID); err != nil {
			return nil, nil, err
		}
	}
	if err := tx.QueryRow(ctx,
		`SELECT `+userBriefCols+` FROM users u WHERE u.id=$1`, authorID,
	).Scan(&c.Author.ID, &c.Author.Username, &c.Author.DisplayName, &c.Author.AvatarURL); err != nil {
		return nil, nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, nil, err
	}
	c.Mentions = []structs.Mention{}
	comments := []structs.Comment{c}
	if err := s.attachCommentMentions(ctx, comments); err != nil {
		return nil, nil, err
	}
	return &comments[0], mentionedIDs, nil
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

// attachCommentMentions resolves every comment's @-mentions to the mentioned
// users' CURRENT profile (spec §7d.2: rename-safe) in a single batched query
// joining comments.mentions → users. One query per page (no N+1). Mentions
// whose user no longer exists are dropped by the join.
func (s *Store) attachCommentMentions(ctx context.Context, comments []structs.Comment) error {
	if len(comments) == 0 {
		return nil
	}
	ids := make([]uuid.UUID, len(comments))
	idx := map[uuid.UUID]int{}
	for i, c := range comments {
		ids[i] = c.ID
		idx[c.ID] = i
	}
	rows, err := s.pool.Query(ctx, `
		SELECT c.id,
		       (m.value->>'user_id')::uuid, (m.value->>'start')::int, (m.value->>'len')::int,
		       u.username, u.display_name, u.avatar_url
		FROM comments c
		CROSS JOIN LATERAL jsonb_array_elements(c.mentions) AS m(value)
		JOIN users u ON u.id = (m.value->>'user_id')::uuid
		WHERE c.id = ANY($1)
		ORDER BY (m.value->>'start')::int`, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var cid uuid.UUID
		var mn structs.Mention
		if err := rows.Scan(&cid, &mn.UserID, &mn.Start, &mn.Len,
			&mn.Username, &mn.DisplayName, &mn.AvatarURL); err != nil {
			return err
		}
		if i, ok := idx[cid]; ok {
			comments[i].Mentions = append(comments[i].Mentions, mn)
		}
	}
	return rows.Err()
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
		c.Mentions = []structs.Mention{}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	if err := s.attachCommentMentions(ctx, out); err != nil {
		return nil, nil, err
	}
	var next *string
	if n := len(out); n > 0 && n >= limit {
		next = NextCursor(n, limit, out[n-1].CreatedAt, out[n-1].ID)
	}
	return out, next, nil
}
