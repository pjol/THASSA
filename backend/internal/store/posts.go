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

// postSelect is the shared post-card projection. $1 is ALWAYS the viewer id.
// It joins the attached market summary and — subject to the trades-visibility
// rule — the author's position badge and settled PnL (spec §7 post card).
var postSelect = fmt.Sprintf(`
	SELECT p.id, p.author_id, u.username, u.display_name, u.avatar_url,
	       p.caption, p.kind, p.like_count, p.comment_count,
	       EXISTS(SELECT 1 FROM likes l WHERE l.subject_type='post' AND l.subject_id=p.id AND l.user_id=$1),
	       p.created_at,
	       m.id, m.chain_market_id, m.title, m.question, m.status, m.direction,
	       m.yes_price_cents, m.no_price_cents, m.volume, m.expires_at, m.resolved_fifty, m.created_at,
	       CASE WHEN m.id IS NOT NULL AND %[1]s THEN
	           (SELECT json_build_object('side', ps.side, 'shares', ps.shares,
	                   'avg_price_cents', ps.avg_price_cents, 'realized_pnl', ps.realized_pnl)
	            FROM positions ps
	            WHERE ps.market_id=m.id AND ps.user_id=p.author_id AND (ps.shares>0 OR ps.realized_pnl<>0)
	            ORDER BY ps.shares DESC LIMIT 1)
	       END,
	       CASE WHEN m.id IS NOT NULL AND m.status='SETTLED' AND %[1]s THEN
	           (SELECT sum(ps.realized_pnl)::bigint FROM positions ps
	            WHERE ps.market_id=m.id AND ps.user_id=p.author_id)
	       END
	FROM posts p
	JOIN users u ON u.id=p.author_id
	LEFT JOIN markets m ON m.id=p.market_id
	WHERE p.deleted_at IS NULL`, tradesVisiblePred("p.author_id", "$1"))

// FeedOpts parameterizes cursor-paginated post queries.
type FeedOpts struct {
	Cursor *Cursor
	Limit  int
}

// Feed returns the home feed for the viewer: posts from followed (accepted)
// users plus a recency-ranked fill of public accounts, newest first, keyset
// paginated on (created_at, id). Private-account posts appear only for
// accepted followers (enforced by the visibility predicate).
func (s *Store) Feed(ctx context.Context, viewerID uuid.UUID, o FeedOpts) ([]structs.Post, *string, error) {
	sql := postSelect + ` AND ` + visiblePred("p.author_id", "$1")
	args := []any{viewerID}
	if o.Cursor != nil {
		sql += ` AND (p.created_at, p.id) < ($2, $3)`
		args = append(args, o.Cursor.CreatedAt, o.Cursor.ID)
	}
	sql += fmt.Sprintf(` ORDER BY p.created_at DESC, p.id DESC LIMIT %d`, o.Limit)
	return s.pagePosts(ctx, sql, o.Limit, args...)
}

// Reels returns the vertical short-form feed (kind=reel), same visibility.
func (s *Store) Reels(ctx context.Context, viewerID uuid.UUID, o FeedOpts) ([]structs.Post, *string, error) {
	sql := postSelect + ` AND p.kind='reel' AND ` + visiblePred("p.author_id", "$1")
	args := []any{viewerID}
	if o.Cursor != nil {
		sql += ` AND (p.created_at, p.id) < ($2, $3)`
		args = append(args, o.Cursor.CreatedAt, o.Cursor.ID)
	}
	sql += fmt.Sprintf(` ORDER BY p.created_at DESC, p.id DESC LIMIT %d`, o.Limit)
	return s.pagePosts(ctx, sql, o.Limit, args...)
}

// ExplorePosts is the public discovery grid: public accounts only.
func (s *Store) ExplorePosts(ctx context.Context, viewerID uuid.UUID, o FeedOpts) ([]structs.Post, *string, error) {
	sql := postSelect + ` AND NOT EXISTS (SELECT 1 FROM users pu WHERE pu.id=p.author_id AND pu.is_private)`
	args := []any{viewerID}
	if o.Cursor != nil {
		sql += ` AND (p.created_at, p.id) < ($2, $3)`
		args = append(args, o.Cursor.CreatedAt, o.Cursor.ID)
	}
	sql += fmt.Sprintf(` ORDER BY p.created_at DESC, p.id DESC LIMIT %d`, o.Limit)
	return s.pagePosts(ctx, sql, o.Limit, args...)
}

// UserPosts returns a user's grid (visibility enforced in the predicate, so a
// private account's posts are only returned to accepted followers/the owner).
func (s *Store) UserPosts(ctx context.Context, viewerID, authorID uuid.UUID, o FeedOpts) ([]structs.Post, *string, error) {
	sql := postSelect + ` AND p.author_id=$2 AND ` + visiblePred("p.author_id", "$1")
	args := []any{viewerID, authorID}
	if o.Cursor != nil {
		sql += ` AND (p.created_at, p.id) < ($3, $4)`
		args = append(args, o.Cursor.CreatedAt, o.Cursor.ID)
	}
	sql += fmt.Sprintf(` ORDER BY p.created_at DESC, p.id DESC LIMIT %d`, o.Limit)
	return s.pagePosts(ctx, sql, o.Limit, args...)
}

// MarketTopPosts returns the most-liked posts referencing a market.
func (s *Store) MarketTopPosts(ctx context.Context, viewerID, marketID uuid.UUID, limit int) ([]structs.Post, error) {
	sql := postSelect + ` AND p.market_id=$2 AND ` + visiblePred("p.author_id", "$1") +
		fmt.Sprintf(` ORDER BY p.like_count DESC, p.created_at DESC LIMIT %d`, limit)
	posts, err := s.queryPosts(ctx, sql, viewerID, marketID)
	if err != nil {
		return nil, err
	}
	if err := s.attachMedia(ctx, posts); err != nil {
		return nil, err
	}
	return posts, s.attachMentions(ctx, posts)
}

// GetPost loads a single post if visible to the viewer.
func (s *Store) GetPost(ctx context.Context, viewerID, postID uuid.UUID) (*structs.Post, error) {
	sql := postSelect + ` AND p.id=$2 AND ` + visiblePred("p.author_id", "$1")
	posts, err := s.queryPosts(ctx, sql, viewerID, postID)
	if err != nil {
		return nil, err
	}
	if len(posts) == 0 {
		return nil, nil
	}
	if err := s.attachMedia(ctx, posts); err != nil {
		return nil, err
	}
	if err := s.attachMentions(ctx, posts); err != nil {
		return nil, err
	}
	return &posts[0], nil
}

// CreatePost inserts a post and attaches previously-uploaded media by id
// (media rows must belong to the author). @-mentions (spec §7d.2) are stored
// verbatim in posts.mentions and normalized into post_mentions (deduped) for
// notification/"tagged" lookups. The author's denormalized post_count is
// incremented in the same transaction (spec §7d.5). Returns the created post id
// and the deduped set of mentioned user ids (for post.mention notifications).
func (s *Store) CreatePost(ctx context.Context, authorID uuid.UUID, caption *string, kind string, marketID *uuid.UUID, mediaIDs []uuid.UUID, mentions []structs.MentionInput) (uuid.UUID, time.Time, []uuid.UUID, error) {
	if mentions == nil {
		mentions = []structs.MentionInput{}
	}
	mentionsJSON, err := json.Marshal(mentions)
	if err != nil {
		return uuid.Nil, time.Time{}, nil, err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return uuid.Nil, time.Time{}, nil, err
	}
	defer tx.Rollback(ctx)

	var postID uuid.UUID
	var createdAt time.Time
	if err := tx.QueryRow(ctx, `
		INSERT INTO posts (author_id, caption, kind, market_id, mentions)
		VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
		authorID, caption, kind, marketID, mentionsJSON,
	).Scan(&postID, &createdAt); err != nil {
		return uuid.Nil, time.Time{}, nil, err
	}
	for i, mid := range mediaIDs {
		tag, err := tx.Exec(ctx, `
			UPDATE post_media SET post_id=$1, position=$2, updated_at=now()
			WHERE id=$3 AND owner_id=$4 AND post_id IS NULL`,
			postID, i, mid, authorID)
		if err != nil {
			return uuid.Nil, time.Time{}, nil, err
		}
		if tag.RowsAffected() == 0 {
			return uuid.Nil, time.Time{}, nil, errors.New("media not found or already attached")
		}
	}
	// Normalized mention rows (deduped on the composite PK).
	seen := map[uuid.UUID]bool{}
	mentionedIDs := []uuid.UUID{}
	for _, m := range mentions {
		if m.UserID == uuid.Nil || seen[m.UserID] {
			continue
		}
		seen[m.UserID] = true
		mentionedIDs = append(mentionedIDs, m.UserID)
		if _, err := tx.Exec(ctx,
			`INSERT INTO post_mentions (post_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
			postID, m.UserID); err != nil {
			return uuid.Nil, time.Time{}, nil, err
		}
	}
	if _, err := tx.Exec(ctx,
		`UPDATE users SET post_count = post_count + 1 WHERE id=$1`, authorID); err != nil {
		return uuid.Nil, time.Time{}, nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return uuid.Nil, time.Time{}, nil, err
	}
	return postID, createdAt, mentionedIDs, nil
}

// DeletePost soft-deletes the caller's own post and decrements the author's
// denormalized post_count in the same transaction (guarded ≥ 0, spec §7d.5).
func (s *Store) DeletePost(ctx context.Context, authorID, postID uuid.UUID) (bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)

	tag, err := tx.Exec(ctx,
		`UPDATE posts SET deleted_at=now(), updated_at=now() WHERE id=$1 AND author_id=$2 AND deleted_at IS NULL`,
		postID, authorID)
	if err != nil {
		return false, err
	}
	if tag.RowsAffected() == 0 {
		return false, tx.Commit(ctx)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE users SET post_count = GREATEST(post_count - 1, 0) WHERE id=$1`, authorID); err != nil {
		return false, err
	}
	return true, tx.Commit(ctx)
}

// PostAffiliateInfo returns the author, the author's wallet (the affiliate
// payee), and whether the post's affiliatePostId has been registered onchain.
// authorID is uuid.Nil when the post does not exist.
func (s *Store) PostAffiliateInfo(ctx context.Context, postID uuid.UUID) (authorID uuid.UUID, payeeWallet string, registered bool, err error) {
	var wallet *string
	err = s.pool.QueryRow(ctx, `
		SELECT p.author_id, u.wallet_address, p.affiliate_registered_at IS NOT NULL
		FROM posts p JOIN users u ON u.id=p.author_id
		WHERE p.id=$1 AND p.deleted_at IS NULL`, postID,
	).Scan(&authorID, &wallet, &registered)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, "", false, nil
	}
	if wallet != nil {
		payeeWallet = *wallet
	}
	return authorID, payeeWallet, registered, err
}

// MarkAffiliateRegistered stamps a post after registerAffiliatePost succeeds.
func (s *Store) MarkAffiliateRegistered(ctx context.Context, postID uuid.UUID) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE posts SET affiliate_registered_at=now(), updated_at=now() WHERE id=$1`, postID)
	return err
}

// pagePosts runs a paged post query, attaches media, and derives next_cursor.
func (s *Store) pagePosts(ctx context.Context, sql string, limit int, args ...any) ([]structs.Post, *string, error) {
	posts, err := s.queryPosts(ctx, sql, args...)
	if err != nil {
		return nil, nil, err
	}
	if err := s.attachMedia(ctx, posts); err != nil {
		return nil, nil, err
	}
	if err := s.attachMentions(ctx, posts); err != nil {
		return nil, nil, err
	}
	var next *string
	if n := len(posts); n > 0 && n >= limit {
		next = NextCursor(n, limit, posts[n-1].CreatedAt, posts[n-1].ID)
	}
	return posts, next, nil
}

func (s *Store) queryPosts(ctx context.Context, sql string, args ...any) ([]structs.Post, error) {
	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []structs.Post{}
	for rows.Next() {
		var p structs.Post
		var (
			mID       *uuid.UUID
			mChain    *int64
			mTitle    *string
			mQuestion *string
			mStatus   *string
			mDir      *bool
			mYes      *int
			mNo       *int
			mVol      *int64
			mExpires  *time.Time
			mFifty    *bool
			mCreated  *time.Time
			posJSON   []byte
			authorPnl *int64
		)
		if err := rows.Scan(&p.ID, &p.Author.ID, &p.Author.Username, &p.Author.DisplayName, &p.Author.AvatarURL,
			&p.Caption, &p.Kind, &p.LikeCount, &p.CommentCount, &p.LikedByMe, &p.CreatedAt,
			&mID, &mChain, &mTitle, &mQuestion, &mStatus, &mDir, &mYes, &mNo, &mVol, &mExpires, &mFifty, &mCreated,
			&posJSON, &authorPnl); err != nil {
			return nil, err
		}
		p.AffiliateID = structs.AffiliateIDFor(p.ID)
		if mID != nil {
			p.Market = &structs.MarketSummary{
				ID: *mID, ChainMarketID: mChain, Title: deref(mTitle), Question: deref(mQuestion),
				Status: deref(mStatus), Direction: mDir, YesPriceCents: mYes, NoPriceCents: mNo,
				Volume: derefI64(mVol), ExpiresAt: mExpires, ResolvedFifty: mFifty != nil && *mFifty,
				CreatedAt: derefT(mCreated),
			}
		}
		if len(posJSON) > 0 {
			var badge structs.PositionBadge
			if json.Unmarshal(posJSON, &badge) == nil && badge.Side != "" {
				p.AuthorPosition = &badge
			}
		}
		p.AuthorPnl = authorPnl
		p.Media = []structs.Media{}
		p.Mentions = []structs.Mention{}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Store) attachMedia(ctx context.Context, posts []structs.Post) error {
	if len(posts) == 0 {
		return nil
	}
	ids := make([]uuid.UUID, len(posts))
	idx := map[uuid.UUID]int{}
	for i, p := range posts {
		ids[i] = p.ID
		idx[p.ID] = i
	}
	rows, err := s.pool.Query(ctx, `
		SELECT post_id, id, kind, s3_key, variant_key, hls_key, poster_key, variants, width, height, duration_ms, status, position
		FROM post_media WHERE post_id = ANY($1) ORDER BY position`, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var pid uuid.UUID
		var m structs.Media
		var key string
		var variantKey, hlsKey, posterKey *string
		var variantsJSON []byte
		if err := rows.Scan(&pid, &m.ID, &m.Kind, &key, &variantKey, &hlsKey, &posterKey, &variantsJSON,
			&m.Width, &m.Height, &m.DurationMS, &m.Status, &m.Position); err != nil {
			return err
		}
		m.URL = s.mediaURL(m.Kind, key, variantKey)
		m.VariantURL = s.urlPtr(variantKey)
		m.HLSURL = s.urlPtr(hlsKey)
		m.PosterURL = s.urlPtr(posterKey)
		m.Variants = s.resolveVariants(variantsJSON)
		if i, ok := idx[pid]; ok {
			posts[i].Media = append(posts[i].Media, m)
		}
	}
	return rows.Err()
}

// attachMentions resolves every post's @-mentions to the mentioned users'
// CURRENT profile (spec §7d.2: rename-safe) in a single batched query joining
// posts.mentions → users. One query per page (no N+1). Mentions whose user no
// longer exists are dropped by the join.
func (s *Store) attachMentions(ctx context.Context, posts []structs.Post) error {
	if len(posts) == 0 {
		return nil
	}
	ids := make([]uuid.UUID, len(posts))
	idx := map[uuid.UUID]int{}
	for i, p := range posts {
		ids[i] = p.ID
		idx[p.ID] = i
	}
	rows, err := s.pool.Query(ctx, `
		SELECT p.id,
		       (m.value->>'user_id')::uuid, (m.value->>'start')::int, (m.value->>'len')::int,
		       u.username, u.display_name, u.avatar_url
		FROM posts p
		CROSS JOIN LATERAL jsonb_array_elements(p.mentions) AS m(value)
		JOIN users u ON u.id = (m.value->>'user_id')::uuid
		WHERE p.id = ANY($1)
		ORDER BY (m.value->>'start')::int`, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var pid uuid.UUID
		var mn structs.Mention
		if err := rows.Scan(&pid, &mn.UserID, &mn.Start, &mn.Len,
			&mn.Username, &mn.DisplayName, &mn.AvatarURL); err != nil {
			return err
		}
		if i, ok := idx[pid]; ok {
			posts[i].Mentions = append(posts[i].Mentions, mn)
		}
	}
	return rows.Err()
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func derefI64(p *int64) int64 {
	if p == nil {
		return 0
	}
	return *p
}

func derefT(p *time.Time) time.Time {
	if p == nil {
		return time.Time{}
	}
	return *p
}
