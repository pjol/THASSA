package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// APIKey is the developer-API key row (spec §6.9). The secret itself is never
// stored — only its SHA-256 hash and a display prefix.
type APIKey struct {
	ID         uuid.UUID  `json:"id"`
	Name       string     `json:"name"`
	Prefix     string     `json:"prefix"`
	Scope      string     `json:"scope"` // read | trade
	LastUsedAt *time.Time `json:"last_used_at"`
	CreatedAt  time.Time  `json:"created_at"`
}

// CreateAPIKey stores a new key (hash + prefix) for the caller.
func (s *Store) CreateAPIKey(ctx context.Context, userID uuid.UUID, name, prefix, keyHash, scope string) (*APIKey, error) {
	var k APIKey
	err := s.pool.QueryRow(ctx, `
		INSERT INTO api_keys (user_id, name, prefix, key_hash, scope)
		VALUES ($1,$2,$3,$4,$5)
		RETURNING id, name, prefix, scope, last_used_at, created_at`,
		userID, name, prefix, keyHash, scope,
	).Scan(&k.ID, &k.Name, &k.Prefix, &k.Scope, &k.LastUsedAt, &k.CreatedAt)
	return &k, err
}

// ListAPIKeys returns the caller's active keys (§8.1: user_id from token).
func (s *Store) ListAPIKeys(ctx context.Context, userID uuid.UUID) ([]APIKey, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, name, prefix, scope, last_used_at, created_at
		FROM api_keys WHERE user_id=$1 AND revoked_at IS NULL
		ORDER BY created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []APIKey{}
	for rows.Next() {
		var k APIKey
		if err := rows.Scan(&k.ID, &k.Name, &k.Prefix, &k.Scope, &k.LastUsedAt, &k.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

// RevokeAPIKey revokes the caller's key (ownership enforced in the UPDATE).
func (s *Store) RevokeAPIKey(ctx context.Context, userID, keyID uuid.UUID) (bool, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE api_keys SET revoked_at=now()
		WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL`, keyID, userID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// APIKeyIdentity resolves a key hash to the owning user + scope. Returns
// uuid.Nil when unknown or revoked. The stored hash lookup is by unique
// index; the caller performs the constant-time comparison of the hash bytes.
func (s *Store) APIKeyIdentity(ctx context.Context, keyHash string) (keyID, userID uuid.UUID, scope, storedHash, wallet string, err error) {
	var w *string
	err = s.pool.QueryRow(ctx, `
		SELECT k.id, k.user_id, k.scope, k.key_hash, u.wallet_address
		FROM api_keys k JOIN users u ON u.id=k.user_id
		WHERE k.key_hash=$1 AND k.revoked_at IS NULL`, keyHash,
	).Scan(&keyID, &userID, &scope, &storedHash, &w)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, uuid.Nil, "", "", "", nil
	}
	if w != nil {
		wallet = *w
	}
	return keyID, userID, scope, storedHash, wallet, err
}

// TouchAPIKey stamps last_used_at (best-effort).
func (s *Store) TouchAPIKey(ctx context.Context, keyID uuid.UUID) {
	_, _ = s.pool.Exec(ctx, `UPDATE api_keys SET last_used_at=now() WHERE id=$1`, keyID)
}
