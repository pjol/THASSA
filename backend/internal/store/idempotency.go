package store

import (
	"context"

	"github.com/google/uuid"
)

// Idempotency claim states (spec §6.7).
const (
	IdemNew      = "new"      // first time: execute and store the response
	IdemReplay   = "replay"   // same key + same request: return stored response
	IdemConflict = "conflict" // same key + DIFFERENT request hash: 409
	IdemInflight = "inflight" // first request still executing: 409
)

// IdemClaim is the result of claiming an idempotency key.
type IdemClaim struct {
	State  string
	Status int
	Body   []byte
}

// ClaimIdempotencyKey atomically claims (key, user) for a request. The row is
// inserted with a NULL response while the first request executes; replays of
// the same request return the stored response once present.
func (s *Store) ClaimIdempotencyKey(ctx context.Context, key string, userID uuid.UUID, methodPath, requestHash string) (IdemClaim, error) {
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO idempotency_keys (key, user_id, method_path, request_hash)
		VALUES ($1,$2,$3,$4)
		ON CONFLICT (key, user_id) DO NOTHING`, key, userID, methodPath, requestHash)
	if err != nil {
		return IdemClaim{}, err
	}
	if tag.RowsAffected() > 0 {
		return IdemClaim{State: IdemNew}, nil
	}
	var (
		storedPath, storedHash string
		status                 *int
		body                   []byte
	)
	if err := s.pool.QueryRow(ctx, `
		SELECT method_path, request_hash, response_status, response_body
		FROM idempotency_keys WHERE key=$1 AND user_id=$2`, key, userID,
	).Scan(&storedPath, &storedHash, &status, &body); err != nil {
		return IdemClaim{}, err
	}
	if storedPath != methodPath || storedHash != requestHash {
		return IdemClaim{State: IdemConflict}, nil
	}
	if status == nil {
		return IdemClaim{State: IdemInflight}, nil
	}
	return IdemClaim{State: IdemReplay, Status: *status, Body: body}, nil
}

// SaveIdempotencyResponse stores the response for future replays.
func (s *Store) SaveIdempotencyResponse(ctx context.Context, key string, userID uuid.UUID, status int, body []byte) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE idempotency_keys SET response_status=$3, response_body=$4
		WHERE key=$1 AND user_id=$2`, key, userID, status, body)
	return err
}

// ReleaseIdempotencyKey removes a claimed key after a handler crash so the
// client can retry (called when the first attempt produced no response).
func (s *Store) ReleaseIdempotencyKey(ctx context.Context, key string, userID uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `
		DELETE FROM idempotency_keys WHERE key=$1 AND user_id=$2 AND response_status IS NULL`,
		key, userID)
	return err
}
