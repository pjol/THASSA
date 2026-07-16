package store

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pjol/THASSA/backend/internal/structs"
)

// CreateMedia inserts a pending upload row (post_id NULL until attached).
func (s *Store) CreateMedia(ctx context.Context, ownerID uuid.UUID, kind, s3Key string) (uuid.UUID, error) {
	var id uuid.UUID
	err := s.pool.QueryRow(ctx, `
		INSERT INTO post_media (owner_id, kind, s3_key, status)
		VALUES ($1,$2,$3,'uploading') RETURNING id`,
		ownerID, kind, s3Key).Scan(&id)
	return id, err
}

// GetMedia loads one media row (any owner — media URLs are unguessable keys).
func (s *Store) GetMedia(ctx context.Context, id uuid.UUID) (*structs.Media, uuid.UUID, string, error) {
	var m structs.Media
	var ownerID uuid.UUID
	var key string
	var variantKey, hlsKey *string
	err := s.pool.QueryRow(ctx, `
		SELECT id, owner_id, kind, s3_key, variant_key, hls_key, width, height, duration_ms, status, position
		FROM post_media WHERE id=$1`, id,
	).Scan(&m.ID, &ownerID, &m.Kind, &key, &variantKey, &hlsKey, &m.Width, &m.Height, &m.DurationMS, &m.Status, &m.Position)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, uuid.Nil, "", nil
	}
	if err != nil {
		return nil, uuid.Nil, "", err
	}
	m.URL = s.url(key)
	m.VariantURL = s.urlPtr(variantKey)
	m.HLSURL = s.urlPtr(hlsKey)
	return &m, ownerID, key, nil
}

// CompleteMedia marks an upload finished and enqueues a processing job
// (video → HLS transcode; image → feed-size variant). Returns false when the
// media does not exist or is not owned by the caller.
func (s *Store) CompleteMedia(ctx context.Context, ownerID, mediaID uuid.UUID) (bool, string, error) {
	var kind string
	err := s.pool.QueryRow(ctx, `
		UPDATE post_media SET status='processing', updated_at=now()
		WHERE id=$1 AND owner_id=$2 AND status='uploading'
		RETURNING kind`, mediaID, ownerID).Scan(&kind)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, "", nil
	}
	if err != nil {
		return false, "", err
	}
	if _, err := s.pool.Exec(ctx,
		`INSERT INTO media_jobs (media_id) VALUES ($1)`, mediaID); err != nil {
		return false, "", err
	}
	return true, kind, nil
}

// MediaJob is one queued transcode.
type MediaJob struct {
	ID       uuid.UUID
	MediaID  uuid.UUID
	Kind     string
	S3Key    string
	Attempts int
}

// ClaimMediaJob atomically claims the oldest queued job (worker pool safe).
// Returns nil when the queue is empty.
func (s *Store) ClaimMediaJob(ctx context.Context) (*MediaJob, error) {
	var j MediaJob
	err := s.pool.QueryRow(ctx, `
		UPDATE media_jobs SET status='processing', attempts=attempts+1, updated_at=now()
		WHERE id = (
			SELECT id FROM media_jobs WHERE status='queued'
			ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
		RETURNING id, media_id, attempts`).Scan(&j.ID, &j.MediaID, &j.Attempts)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err := s.pool.QueryRow(ctx,
		`SELECT kind, s3_key FROM post_media WHERE id=$1`, j.MediaID).Scan(&j.Kind, &j.S3Key); err != nil {
		return nil, err
	}
	return &j, nil
}

// FinishMediaJob records the transcode outcome and flips the media status.
func (s *Store) FinishMediaJob(ctx context.Context, jobID, mediaID uuid.UUID, hlsKey, variantKey *string, width, height, durationMS *int, jobErr error) error {
	if jobErr != nil {
		_, _ = s.pool.Exec(ctx,
			`UPDATE media_jobs SET status='failed', error=$2, updated_at=now() WHERE id=$1`,
			jobID, jobErr.Error())
		_, err := s.pool.Exec(ctx,
			`UPDATE post_media SET status='failed', updated_at=now() WHERE id=$1`, mediaID)
		return err
	}
	if _, err := s.pool.Exec(ctx,
		`UPDATE media_jobs SET status='done', updated_at=now() WHERE id=$1`, jobID); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE post_media SET status='ready',
			hls_key     = COALESCE($2, hls_key),
			variant_key = COALESCE($3, variant_key),
			width       = COALESCE($4, width),
			height      = COALESCE($5, height),
			duration_ms = COALESCE($6, duration_ms),
			updated_at  = now()
		WHERE id=$1`, mediaID, hlsKey, variantKey, width, height, durationMS)
	return err
}
