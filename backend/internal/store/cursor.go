package store

import (
	"encoding/base64"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Cursor is an opaque keyset-pagination token over (created_at, id). It sorts
// strictly descending: rows strictly "before" the cursor are returned next.
type Cursor struct {
	CreatedAt time.Time
	ID        uuid.UUID
}

// EncodeCursor packs a (created_at, id) keyset position into an opaque token.
func EncodeCursor(t time.Time, id uuid.UUID) string {
	raw := fmt.Sprintf("%s|%s", t.UTC().Format(time.RFC3339Nano), id)
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

// DecodeCursor unpacks a token produced by EncodeCursor. Returns nil for an
// empty token and an error for a malformed one.
func DecodeCursor(token string) (*Cursor, error) {
	if token == "" {
		return nil, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil {
		return nil, fmt.Errorf("invalid cursor")
	}
	parts := strings.SplitN(string(raw), "|", 2)
	if len(parts) != 2 {
		return nil, fmt.Errorf("invalid cursor")
	}
	t, err := time.Parse(time.RFC3339Nano, parts[0])
	if err != nil {
		return nil, fmt.Errorf("invalid cursor")
	}
	id, err := uuid.Parse(parts[1])
	if err != nil {
		return nil, fmt.Errorf("invalid cursor")
	}
	return &Cursor{CreatedAt: t, ID: id}, nil
}

// NextCursor returns the token for the last row of a full page, or nil when
// the page was short (no more rows).
func NextCursor(n, limit int, lastCreated time.Time, lastID uuid.UUID) *string {
	if n == 0 || n < limit {
		return nil
	}
	c := EncodeCursor(lastCreated, lastID)
	return &c
}
