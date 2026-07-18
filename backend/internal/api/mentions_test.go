package api

import (
	"testing"

	"github.com/google/uuid"
)

func ptr(s string) *string { return &s }

func TestCaptionUTF16Len(t *testing.T) {
	tests := []struct {
		caption *string
		want    int
	}{
		{nil, 0},
		{ptr(""), 0},
		{ptr("hello"), 5},
		// "é" (U+00E9) is 1 UTF-16 code unit (2 bytes in UTF-8).
		{ptr("café"), 4},
		// "😀" (U+1F600) is 2 UTF-16 code units (a surrogate pair), 4 UTF-8 bytes.
		{ptr("😀"), 2},
		// "hi " = 3, "😀" = 2, " @a" = 3 → 8 code units.
		{ptr("hi 😀 @a"), 8},
	}
	for _, tt := range tests {
		if got := captionUTF16Len(tt.caption); got != tt.want {
			t.Fatalf("captionUTF16Len(%v) = %d, want %d", tt.caption, got, tt.want)
		}
	}
}

func TestParseMentions(t *testing.T) {
	uid := uuid.NewString()

	// Empty input is valid (no mentions).
	if out, ok := parseMentions(ptr("hello"), nil); !ok || out != nil {
		t.Fatalf("empty mentions should be valid/nil, got %v %v", out, ok)
	}

	// Valid mention within bounds: caption "hi @bob" (len 7), @bob at [3,4).
	if out, ok := parseMentions(ptr("hi @bob"), []mentionInput{{UserID: uid, Start: 3, Len: 4}}); !ok || len(out) != 1 {
		t.Fatalf("valid mention rejected: %v %v", out, ok)
	}

	// Offset that runs past the caption end is rejected.
	if _, ok := parseMentions(ptr("hi @bob"), []mentionInput{{UserID: uid, Start: 5, Len: 5}}); ok {
		t.Fatal("out-of-bounds mention accepted")
	}

	// Negative start rejected.
	if _, ok := parseMentions(ptr("hi @bob"), []mentionInput{{UserID: uid, Start: -1, Len: 4}}); ok {
		t.Fatal("negative start accepted")
	}

	// Zero/negative length rejected.
	if _, ok := parseMentions(ptr("hi @bob"), []mentionInput{{UserID: uid, Start: 0, Len: 0}}); ok {
		t.Fatal("zero length accepted")
	}

	// Bad uuid rejected.
	if _, ok := parseMentions(ptr("hi @bob"), []mentionInput{{UserID: "not-a-uuid", Start: 3, Len: 4}}); ok {
		t.Fatal("invalid uuid accepted")
	}

	// UTF-16 accounting: caption "😀 @bob" — "😀"=2, " "=1, "@bob"=4 → len 7.
	// A mention of @bob at [3,4) fits; measuring in bytes (10) or runes (6)
	// would wrongly accept/reject different windows. [3,4) is valid.
	if _, ok := parseMentions(ptr("😀 @bob"), []mentionInput{{UserID: uid, Start: 3, Len: 4}}); !ok {
		t.Fatal("valid emoji-prefixed mention rejected")
	}
	// [4,4) would exceed the 7-unit caption (4+4=8 > 7): rejected.
	if _, ok := parseMentions(ptr("😀 @bob"), []mentionInput{{UserID: uid, Start: 4, Len: 4}}); ok {
		t.Fatal("emoji-prefixed out-of-bounds mention accepted")
	}
}

// TestParseMentionsCommentBody documents that comment creation validates
// @-mention offsets against the comment BODY with the same UTF-16 rules as post
// captions (spec §7d.2) — createComment reuses parseMentions.
func TestParseMentionsCommentBody(t *testing.T) {
	uid := uuid.NewString()
	body := "great call @alice" // len 17; @alice at [11,6)
	if out, ok := parseMentions(&body, []mentionInput{{UserID: uid, Start: 11, Len: 6}}); !ok || len(out) != 1 {
		t.Fatalf("valid comment mention rejected: %v %v", out, ok)
	}
	// Past the body end is rejected.
	if _, ok := parseMentions(&body, []mentionInput{{UserID: uid, Start: 12, Len: 6}}); ok {
		t.Fatal("out-of-bounds comment mention accepted")
	}
}
