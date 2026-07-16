package store

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pjol/THASSA/backend/internal/structs"
)

// CreateStoryFromMedia publishes a story from a previously-uploaded media row
// owned by the author (media fields are copied inline; 24h expiry by default).
func (s *Store) CreateStoryFromMedia(ctx context.Context, authorID, mediaID uuid.UUID) (uuid.UUID, error) {
	var id uuid.UUID
	err := s.pool.QueryRow(ctx, `
		INSERT INTO stories (author_id, kind, s3_key, hls_key, width, height, duration_ms)
		SELECT owner_id, kind, s3_key, hls_key, width, height, duration_ms
		FROM post_media WHERE id=$1 AND owner_id=$2
		RETURNING id`, mediaID, authorID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, errors.New("media not found")
	}
	return id, err
}

// ActiveStories returns unexpired stories from the viewer + accounts they can
// see (followed accepted users; private authors only when accepted), grouped
// client-side into rails. Ordered by author then recency.
func (s *Store) ActiveStories(ctx context.Context, viewerID uuid.UUID) ([]structs.Story, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT st.id, `+userBriefCols+`, st.kind, st.s3_key, st.hls_key,
		       (SELECT count(*) FROM story_views sv WHERE sv.story_id=st.id),
		       EXISTS(SELECT 1 FROM story_views sv WHERE sv.story_id=st.id AND sv.viewer_id=$1),
		       st.created_at, st.expires_at
		FROM stories st JOIN users u ON u.id=st.author_id
		WHERE st.expires_at > now()
		  AND (st.author_id=$1 OR EXISTS (
		        SELECT 1 FROM follows f
		        WHERE f.follower_id=$1 AND f.followee_id=st.author_id AND f.status='accepted'))
		ORDER BY st.author_id, st.created_at ASC`, viewerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []structs.Story{}
	for rows.Next() {
		var st structs.Story
		var key string
		var hlsKey *string
		if err := rows.Scan(&st.ID, &st.Author.ID, &st.Author.Username, &st.Author.DisplayName,
			&st.Author.AvatarURL, &st.Kind, &key, &hlsKey, &st.ViewCount, &st.ViewedByMe,
			&st.CreatedAt, &st.ExpiresAt); err != nil {
			return nil, err
		}
		st.URL = s.url(key)
		st.HLSURL = s.urlPtr(hlsKey)
		out = append(out, st)
	}
	return out, rows.Err()
}

// ViewStory records a view (idempotent). Visibility: viewer must be able to
// see the author (accepted follower or public account or self).
func (s *Store) ViewStory(ctx context.Context, viewerID, storyID uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO story_views (story_id, viewer_id)
		SELECT st.id, $2 FROM stories st
		WHERE st.id=$1 AND st.expires_at > now() AND `+visiblePred("st.author_id", "$2")+`
		ON CONFLICT DO NOTHING`, storyID, viewerID)
	return err
}
