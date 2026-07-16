package store

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestCursorRoundTrip(t *testing.T) {
	id := uuid.New()
	ts := time.Date(2026, 7, 16, 12, 34, 56, 789012345, time.UTC)
	token := EncodeCursor(ts, id)

	c, err := DecodeCursor(token)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !c.CreatedAt.Equal(ts) || c.ID != id {
		t.Fatalf("round trip mismatch: %+v", c)
	}
}

func TestDecodeCursorEmpty(t *testing.T) {
	c, err := DecodeCursor("")
	if err != nil || c != nil {
		t.Fatalf("empty cursor should be (nil, nil), got (%v, %v)", c, err)
	}
}

func TestDecodeCursorMalformed(t *testing.T) {
	for _, bad := range []string{
		"not-base64!!!",
		"aGVsbG8",                 // decodes but no separator
		"MjAyNi0wMS0wMXxub3B1aWQ", // bad uuid
	} {
		if _, err := DecodeCursor(bad); err == nil {
			t.Fatalf("expected error for %q", bad)
		}
	}
	// Bad timestamp with valid uuid.
	badTS := EncodeCursor(time.Now(), uuid.New())[:4] + "zzzz"
	if _, err := DecodeCursor(badTS); err == nil {
		t.Fatal("expected error for corrupted token")
	}
}

func TestNextCursor(t *testing.T) {
	id := uuid.New()
	ts := time.Now().UTC()
	// Short page → no next cursor.
	if got := NextCursor(5, 10, ts, id); got != nil {
		t.Fatal("short page should not produce a cursor")
	}
	// Empty page → nil.
	if got := NextCursor(0, 10, ts, id); got != nil {
		t.Fatal("empty page should not produce a cursor")
	}
	// Full page → cursor pointing at the last row.
	got := NextCursor(10, 10, ts, id)
	if got == nil {
		t.Fatal("full page should produce a cursor")
	}
	c, err := DecodeCursor(*got)
	if err != nil || c.ID != id {
		t.Fatalf("cursor decode: %v %+v", err, c)
	}
}
