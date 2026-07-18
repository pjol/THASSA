package store

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pjol/THASSA/backend/internal/structs"
)

// MediaVariantRec is one image rendition as stored in the post_media.variants
// JSONB array. Keys (not URLs) are persisted, exactly like s3_key/hls_key, and
// resolved to public URLs on read via resolveVariants.
type MediaVariantRec struct {
	Width  int    `json:"w"`
	Height int    `json:"h"`
	Key    string `json:"key"`
	Format string `json:"fmt"` // webp | jpeg
}

// MediaResult is the transcode outcome the media worker hands back to the
// store. Nil-valued pointers leave the corresponding column unchanged.
type MediaResult struct {
	HLSKey     *string
	VariantKey *string // back-compat feed-size image (mid variant)
	PosterKey  *string // video still thumbnail
	Variants   []MediaVariantRec
	Width      *int
	Height     *int
	DurationMS *int
	// OriginalDropped is true once the raw upload has been deleted from object
	// storage (all variants/the HLS ladder stored successfully). Only ever set
	// true — never flipped back — so the column is a monotonic guard.
	OriginalDropped bool
}

// resolveVariants turns stored variant records into the API shape, mapping each
// stored key to its public serving URL.
func (s *Store) resolveVariants(raw []byte) []structs.MediaVariant {
	out := []structs.MediaVariant{}
	if len(raw) == 0 {
		return out
	}
	var recs []MediaVariantRec
	if err := json.Unmarshal(raw, &recs); err != nil {
		return out
	}
	for _, r := range recs {
		out = append(out, structs.MediaVariant{
			Width:  r.Width,
			Height: r.Height,
			URL:    s.url(r.Key),
			Format: r.Format,
		})
	}
	return out
}

// midVariantURL returns the top-level image URL to advertise for a set of
// resolved variants: the ~1080px rendition when present, else the widest. Used
// by inline-media rows (stories, messages) that carry only the variant ladder
// and whose original upload has been dropped. Returns "" when there are none.
func midVariantURL(variants []structs.MediaVariant) string {
	if len(variants) == 0 {
		return ""
	}
	best := variants[0]
	for _, v := range variants {
		// Prefer the largest variant that is still <= 1080; if all exceed 1080,
		// fall back to the smallest that does. This mirrors the old feed variant.
		if v.Width <= 1080 && v.Width > best.Width {
			best = v
		}
	}
	if best.Width > 1080 {
		best = variants[0]
		for _, v := range variants {
			if v.Width < best.Width {
				best = v
			}
		}
	}
	return best.URL
}

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
	var variantKey, hlsKey, posterKey *string
	var variantsJSON []byte
	err := s.pool.QueryRow(ctx, `
		SELECT id, owner_id, kind, s3_key, variant_key, hls_key, poster_key, variants, width, height, duration_ms, status, position
		FROM post_media WHERE id=$1`, id,
	).Scan(&m.ID, &ownerID, &m.Kind, &key, &variantKey, &hlsKey, &posterKey, &variantsJSON,
		&m.Width, &m.Height, &m.DurationMS, &m.Status, &m.Position)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, uuid.Nil, "", nil
	}
	if err != nil {
		return nil, uuid.Nil, "", err
	}
	m.URL = s.mediaURL(m.Kind, key, variantKey)
	m.VariantURL = s.urlPtr(variantKey)
	m.HLSURL = s.urlPtr(hlsKey)
	m.PosterURL = s.urlPtr(posterKey)
	m.Variants = s.resolveVariants(variantsJSON)
	return &m, ownerID, key, nil
}

// mediaURL picks the top-level URL for a media row. For images whose original
// has been transcoded and dropped, the raw key no longer exists, so URL points
// at the back-compat feed variant when present; otherwise it falls back to the
// raw key (still uploading/processing, or video which serves via HLS).
func (s *Store) mediaURL(kind, rawKey string, variantKey *string) string {
	if kind == "image" && variantKey != nil {
		return s.url(*variantKey)
	}
	return s.url(rawKey)
}

// CompleteMedia marks an upload finished and enqueues a processing job
// (video → HLS ladder + poster; image → responsive variant ladder). Returns
// false when the media does not exist or is not owned by the caller.
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
	// OriginalDropped is carried from post_media so the worker can short-circuit
	// (the raw upload is already gone; there is nothing left to transcode).
	OriginalDropped bool
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
		`SELECT kind, s3_key, original_dropped FROM post_media WHERE id=$1`, j.MediaID,
	).Scan(&j.Kind, &j.S3Key, &j.OriginalDropped); err != nil {
		return nil, err
	}
	return &j, nil
}

// FinishMediaJob records the transcode outcome and flips the media status.
// On error the original upload is preserved (never dropped) and the row is
// marked failed/retryable. On success the variant ladder + poster are stored
// and status becomes ready. A nil res with nil err is an idempotent no-op
// finish (the media was already fully processed).
func (s *Store) FinishMediaJob(ctx context.Context, jobID, mediaID uuid.UUID, res *MediaResult, jobErr error) error {
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
	if res == nil {
		// Idempotent no-op (already processed): keep the row ready, change nothing.
		_, err := s.pool.Exec(ctx,
			`UPDATE post_media SET status='ready', updated_at=now() WHERE id=$1`, mediaID)
		return err
	}
	variantsJSON, err := json.Marshal(res.Variants)
	if err != nil {
		return err
	}
	if len(res.Variants) == 0 {
		variantsJSON = []byte("[]")
	}
	_, err = s.pool.Exec(ctx, `
		UPDATE post_media SET status='ready',
			hls_key          = COALESCE($2, hls_key),
			variant_key      = COALESCE($3, variant_key),
			poster_key       = COALESCE($4, poster_key),
			variants         = $5::jsonb,
			width            = COALESCE($6, width),
			height           = COALESCE($7, height),
			duration_ms      = COALESCE($8, duration_ms),
			original_dropped = original_dropped OR $9,
			updated_at       = now()
		WHERE id=$1`,
		mediaID, res.HLSKey, res.VariantKey, res.PosterKey, variantsJSON,
		res.Width, res.Height, res.DurationMS, res.OriginalDropped)
	return err
}
