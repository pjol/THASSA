package media

import (
	"context"
	"errors"
	"io"
	"reflect"
	"testing"

	"github.com/pjol/THASSA/backend/internal/store"
)

func TestImageLadder(t *testing.T) {
	cases := []struct {
		name string
		srcW int
		want []int
	}{
		{"huge source caps at widest ladder, no upscale", 4000, []int{320, 640, 1080, 1920}},
		{"exactly widest ladder", 1920, []int{320, 640, 1080, 1920}},
		{"1080 source stops at 1080 (never upscales to 1920)", 1080, []int{320, 640, 1080}},
		{"between rungs keeps source-width top", 1500, []int{320, 640, 1080, 1500}},
		{"640 source", 640, []int{320, 640}},
		{"just above a rung", 700, []int{320, 640, 700}},
		{"small source yields a single variant", 200, []int{200}},
		{"tiny source", 50, []int{50}},
		{"zero/invalid source", 0, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := imageLadder(c.srcW, imageLadderWidths)
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("imageLadder(%d) = %v, want %v", c.srcW, got, c.want)
			}
			// Invariant: never emit a width greater than the source.
			for _, w := range got {
				if w > c.srcW {
					t.Fatalf("emitted width %d exceeds source %d (upscale)", w, c.srcW)
				}
			}
		})
	}
}

func TestChooseRenditions(t *testing.T) {
	cases := []struct {
		srcH int
		want []string
	}{
		{2160, []string{"1080p", "720p", "480p", "360p"}},
		{1080, []string{"1080p", "720p", "480p", "360p"}},
		{720, []string{"720p", "480p", "360p"}},
		{500, []string{"480p", "360p"}},
		{360, []string{"360p"}},
		{240, []string{"360p"}}, // always at least the smallest rung
	}
	for _, c := range cases {
		got := chooseRenditions(c.srcH)
		var names []string
		for _, r := range got {
			names = append(names, r.name)
		}
		if !reflect.DeepEqual(names, c.want) {
			t.Fatalf("chooseRenditions(%d) = %v, want %v", c.srcH, names, c.want)
		}
	}
}

func TestVariantKeyDerivation(t *testing.T) {
	id := "018f-media-id"
	if got := variantKey(id, 1080, "webp"); got != "variants/018f-media-id/1080.webp" {
		t.Fatalf("variantKey webp = %q", got)
	}
	if got := variantKey(id, 640, "jpeg"); got != "variants/018f-media-id/640.jpg" {
		t.Fatalf("variantKey jpeg = %q", got)
	}
	if got := posterKeyFor(id); got != "poster/018f-media-id.jpg" {
		t.Fatalf("posterKeyFor = %q", got)
	}
	if imageExt("webp") != "webp" || imageExt("jpeg") != "jpg" {
		t.Fatalf("imageExt wrong")
	}
	if imageContentType("webp") != "image/webp" || imageContentType("jpeg") != "image/jpeg" {
		t.Fatalf("imageContentType wrong")
	}
}

func TestPickBackCompatVariant(t *testing.T) {
	// Prefers the 1080 rung when present.
	recs := []store.MediaVariantRec{
		{Width: 320, Key: "variants/x/320.webp"},
		{Width: 640, Key: "variants/x/640.webp"},
		{Width: 1080, Key: "variants/x/1080.webp"},
	}
	if got := pickBackCompatVariant(recs); got == nil || *got != "variants/x/1080.webp" {
		t.Fatalf("expected 1080 variant, got %v", got)
	}
	// Falls back to the widest when there is no 1080 rung.
	recs = []store.MediaVariantRec{
		{Width: 320, Key: "variants/x/320.webp"},
		{Width: 500, Key: "variants/x/500.webp"},
	}
	if got := pickBackCompatVariant(recs); got == nil || *got != "variants/x/500.webp" {
		t.Fatalf("expected 500 variant, got %v", got)
	}
	if pickBackCompatVariant(nil) != nil {
		t.Fatalf("expected nil for empty recs")
	}
}

// fakeStore records Delete calls and can be made to fail deletes.
type fakeStore struct {
	deleted    []string
	failDelete bool
}

func (f *fakeStore) PresignUpload(context.Context, string, string) (string, string, error) {
	return "", "", nil
}
func (f *fakeStore) PublicURL(key string) string                          { return "/" + key }
func (f *fakeStore) Get(context.Context, string) (io.ReadCloser, error)   { return nil, nil }
func (f *fakeStore) Put(context.Context, string, string, io.Reader) error { return nil }
func (f *fakeStore) Delete(_ context.Context, key string) error {
	if f.failDelete {
		return errors.New("delete boom")
	}
	f.deleted = append(f.deleted, key)
	return nil
}

func TestFinalizeDropGuard(t *testing.T) {
	ctx := context.Background()

	// Transcoding failed -> original MUST be kept (retryable), no delete.
	fs := &fakeStore{}
	if dropped := finalizeDrop(ctx, fs, "media/raw.mp4", errors.New("transcode failed")); dropped {
		t.Fatalf("must not drop original when transcoding failed")
	}
	if len(fs.deleted) != 0 {
		t.Fatalf("delete must not be called on transcode failure, got %v", fs.deleted)
	}

	// Success -> original deleted, dropped=true.
	fs = &fakeStore{}
	if dropped := finalizeDrop(ctx, fs, "media/raw.mp4", nil); !dropped {
		t.Fatalf("must drop original after successful transcode")
	}
	if len(fs.deleted) != 1 || fs.deleted[0] != "media/raw.mp4" {
		t.Fatalf("expected original deleted once, got %v", fs.deleted)
	}

	// Delete itself fails -> not marked dropped (keep original_dropped=false, retryable).
	fs = &fakeStore{failDelete: true}
	if dropped := finalizeDrop(ctx, fs, "media/raw.mp4", nil); dropped {
		t.Fatalf("must not report dropped when the delete failed")
	}

	// Empty key -> nothing to drop.
	fs = &fakeStore{}
	if dropped := finalizeDrop(ctx, fs, "", nil); dropped {
		t.Fatalf("empty key must not be dropped")
	}
}

func TestEvenDim(t *testing.T) {
	cases := map[int]int{0: 2, 1: 2, 2: 2, 3: 2, 4: 4, 721: 720, 1081: 1080}
	for in, want := range cases {
		if got := evenDim(in); got != want {
			t.Fatalf("evenDim(%d) = %d, want %d", in, got, want)
		}
	}
}
