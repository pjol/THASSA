// Package media is the ffmpeg processing pipeline (spec §6.8). Raw uploads are
// transcoded into low-file-size renditions, and the original is dropped once
// the renditions are safely stored:
//
//   - Images → a responsive width-ladder of WebP (or JPEG when libwebp is
//     unavailable) variants at capped widths (320/640/1080/1920, never
//     upscaled), metadata stripped, tuned for small files. The client picks the
//     smallest variant >= its display width * DPR.
//   - Videos → an adaptive HLS ladder (1080p/720p/480p/360p rungs the source
//     allows, H.264/AAC, 4s segments) behind a master playlist, plus a
//     downscaled poster still.
//
// Jobs live in the media_jobs table and are claimed with FOR UPDATE SKIP
// LOCKED, so any number of workers across any number of instances is safe
// (spec §6.7). The drop-original step runs only after every rendition uploads
// successfully; on any failure the original is preserved and the row is marked
// failed/retryable.
//
// Assumptions: ffmpeg + ffprobe are on PATH (as before). libwebp is detected at
// runtime — when the ffmpeg build lacks the libwebp encoder the image ladder
// falls back to JPEG automatically.
package media

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pjol/THASSA/backend/internal/storage"
	"github.com/pjol/THASSA/backend/internal/store"
)

// Processor runs the worker pool.
type Processor struct {
	db     *store.Store
	assets storage.Store
}

func NewProcessor(db *store.Store, assets storage.Store) *Processor {
	return &Processor{db: db, assets: assets}
}

// Run starts `workers` goroutines that poll the job queue until ctx ends.
func (p *Processor) Run(ctx context.Context, workers int) {
	for i := 0; i < workers; i++ {
		go p.worker(ctx)
	}
}

func (p *Processor) worker(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		job, err := p.db.ClaimMediaJob(ctx)
		if err != nil || job == nil {
			select {
			case <-ctx.Done():
				return
			case <-time.After(2 * time.Second):
			}
			continue
		}
		p.process(ctx, job)
	}
}

func (p *Processor) process(ctx context.Context, job *store.MediaJob) {
	// Idempotency guard: if the original was already dropped, the renditions are
	// already stored and the raw upload is gone — there is nothing to redo. Mark
	// the job done without touching the (already ready) media row.
	if job.OriginalDropped {
		if ferr := p.db.FinishMediaJob(ctx, job.ID, job.MediaID, nil, nil); ferr != nil {
			log.Printf("media: finish (noop) job %s: %v", job.ID, ferr)
		}
		return
	}

	var (
		res *store.MediaResult
		err error
	)
	switch job.Kind {
	case "video":
		res, err = p.processVideo(ctx, job)
	case "image":
		res, err = p.processImage(ctx, job)
	default:
		err = fmt.Errorf("unknown media kind %q", job.Kind)
	}
	if err != nil {
		log.Printf("media: job %s failed: %v", job.ID, err)
	} else if res != nil {
		// Drop-original guard: only after every rendition uploaded successfully
		// (err == nil) do we delete the raw upload. If the delete itself fails we
		// keep original_dropped=false so a later run can retry — the media is
		// still fully usable from its renditions.
		res.OriginalDropped = finalizeDrop(ctx, p.assets, job.S3Key, err)
	}
	if ferr := p.db.FinishMediaJob(ctx, job.ID, job.MediaID, res, err); ferr != nil {
		log.Printf("media: finish job %s: %v", job.ID, ferr)
	}
}

// finalizeDrop deletes the original upload iff transcoding fully succeeded.
// Returns true only when the object was actually deleted. This is the
// "only delete original after all variants succeed" guard, kept pure so it is
// unit-testable: transcodeErr != nil ⇒ keep the original (retryable); a failed
// delete ⇒ keep original_dropped false (safe to retry later).
func finalizeDrop(ctx context.Context, assets storage.Store, originalKey string, transcodeErr error) bool {
	if transcodeErr != nil || originalKey == "" {
		return false
	}
	if err := assets.Delete(ctx, originalKey); err != nil {
		log.Printf("media: keep original %q (delete failed): %v", originalKey, err)
		return false
	}
	return true
}

// ---------------------------------------------------------------------------
// Video → adaptive HLS ladder + poster
// ---------------------------------------------------------------------------

// rendition describes one HLS rung.
type rendition struct {
	name      string
	height    int
	bandwidth int // bits/s advertised in the master playlist
	crf       string
}

// renditions is the adaptive ladder, widest first. A rung is emitted only when
// the source is at least that tall (never upscale); the smallest is always
// emitted so every video gets at least one rung.
var renditions = []rendition{
	{name: "1080p", height: 1080, bandwidth: 5000000, crf: "22"},
	{name: "720p", height: 720, bandwidth: 2800000, crf: "22"},
	{name: "480p", height: 480, bandwidth: 1400000, crf: "23"},
	{name: "360p", height: 360, bandwidth: 800000, crf: "24"},
}

// chooseRenditions returns the rungs a source of height srcH should emit.
func chooseRenditions(srcH int) []rendition {
	smallest := renditions[len(renditions)-1]
	var chosen []rendition
	for _, r := range renditions {
		if srcH >= r.height || r.height == smallest.height {
			chosen = append(chosen, r)
		}
	}
	return chosen
}

// processVideo downloads the raw upload, transcodes each rung the source
// allows, writes a master playlist, extracts a poster still, and uploads the
// tree to hls/{mediaId}/ (+ poster/{mediaId}.jpg).
func (p *Processor) processVideo(ctx context.Context, job *store.MediaJob) (*store.MediaResult, error) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		return nil, fmt.Errorf("ffmpeg not installed on this worker")
	}

	dir, err := os.MkdirTemp("", "thassa-media-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)

	src := filepath.Join(dir, "source")
	if err := p.download(ctx, job.S3Key, src); err != nil {
		return nil, fmt.Errorf("download raw: %w", err)
	}

	sw, sh, sd, err := probe(ctx, src)
	if err != nil {
		return nil, fmt.Errorf("ffprobe: %w", err)
	}

	outDir := filepath.Join(dir, "hls")
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return nil, err
	}

	master := "#EXTM3U\n#EXT-X-VERSION:3\n"
	for _, r := range chooseRenditions(sh) {
		playlist := fmt.Sprintf("%s.m3u8", r.name)
		segments := fmt.Sprintf("%s_%%04d.ts", r.name)
		cmd := exec.CommandContext(ctx, ffmpeg,
			"-y", "-i", src,
			"-vf", fmt.Sprintf("scale=-2:%d", r.height),
			"-c:v", "libx264", "-preset", "veryfast", "-crf", r.crf,
			"-maxrate", fmt.Sprintf("%d", r.bandwidth), "-bufsize", fmt.Sprintf("%d", r.bandwidth*2),
			"-c:a", "aac", "-b:a", "128k",
			"-hls_time", "4", // 4s segments per spec §6.8
			"-hls_playlist_type", "vod",
			"-hls_segment_filename", filepath.Join(outDir, segments),
			filepath.Join(outDir, playlist),
		)
		var stderr strings.Builder
		cmd.Stderr = &stderr
		if err := cmd.Run(); err != nil {
			return nil, fmt.Errorf("ffmpeg %s: %v: %s", r.name, err, tail(stderr.String()))
		}
		outW := evenDim(sw * r.height / max(sh, 1))
		master += fmt.Sprintf("#EXT-X-STREAM-INF:BANDWIDTH=%d,RESOLUTION=%dx%d\n%s\n",
			r.bandwidth, outW, r.height, playlist)
	}
	if err := os.WriteFile(filepath.Join(outDir, "master.m3u8"), []byte(master), 0o644); err != nil {
		return nil, err
	}

	// Upload the HLS tree under hls/{mediaId}/.
	prefix := fmt.Sprintf("hls/%s", job.MediaID)
	entries, err := os.ReadDir(outDir)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		ct := "video/mp2t"
		if strings.HasSuffix(e.Name(), ".m3u8") {
			ct = "application/vnd.apple.mpegurl"
		}
		if err := p.uploadFile(ctx, prefix+"/"+e.Name(), ct, filepath.Join(outDir, e.Name())); err != nil {
			return nil, fmt.Errorf("upload %s: %w", e.Name(), err)
		}
	}

	// Poster still: a downscaled JPEG seeked ~1s in (clamped to mid-clip for
	// short videos) so players and feeds have a thumbnail without loading HLS.
	posterKey, err := p.extractPoster(ctx, ffmpeg, src, sd, job.MediaID.String())
	if err != nil {
		return nil, fmt.Errorf("poster: %w", err)
	}

	key := prefix + "/master.m3u8"
	ms := int(sd.Milliseconds())
	return &store.MediaResult{
		HLSKey:     &key,
		PosterKey:  &posterKey,
		Width:      &sw,
		Height:     &sh,
		DurationMS: &ms,
	}, nil
}

// extractPoster writes a downscaled JPEG thumbnail and uploads it.
func (p *Processor) extractPoster(ctx context.Context, ffmpeg, src string, dur time.Duration, mediaID string) (string, error) {
	// Seek to ~1s, but not past the clip; use the midpoint for very short videos.
	ss := 1.0
	if secs := dur.Seconds(); secs > 0 && secs < 2 {
		ss = secs / 2
	}
	dir := filepath.Dir(src)
	out := filepath.Join(dir, "poster.jpg")
	cmd := exec.CommandContext(ctx, ffmpeg,
		"-y", "-ss", strconv.FormatFloat(ss, 'f', 3, 64), "-i", src,
		"-map_metadata", "-1",
		"-vf", "scale='min(720,iw)':-2",
		"-frames:v", "1", "-c:v", "mjpeg", "-q:v", "4", "-pix_fmt", "yuvj420p",
		out,
	)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("%v: %s", err, tail(stderr.String()))
	}
	key := posterKeyFor(mediaID)
	if err := p.uploadFile(ctx, key, "image/jpeg", out); err != nil {
		return "", err
	}
	return key, nil
}

// ---------------------------------------------------------------------------
// Image → responsive downscaled ladder
// ---------------------------------------------------------------------------

// imageLadderWidths is the target width ladder for image variants (px).
var imageLadderWidths = []int{320, 640, 1080, 1920}

// backCompatVariantWidth is the width whose variant is exposed as the legacy
// single VariantURL (the old "feed-size" image).
const backCompatVariantWidth = 1080

// imageLadder returns the variant widths to emit for a source of width srcW.
// Rules: never upscale (drop ladder entries wider than the source), always cap
// the top variant at the source's own width (bounded by the widest ladder
// entry), and always emit at least one variant.
func imageLadder(srcW int, ladder []int) []int {
	if srcW <= 0 {
		return nil
	}
	var out []int
	for _, w := range ladder {
		if w < srcW {
			out = append(out, w)
		}
	}
	top := srcW
	if m := ladder[len(ladder)-1]; top > m {
		top = m // cap at widest ladder rung (don't ship a huge full-res variant)
	}
	if len(out) == 0 || out[len(out)-1] != top {
		out = append(out, top)
	}
	return out
}

// processImage produces the WebP/JPEG width-ladder and uploads each variant.
func (p *Processor) processImage(ctx context.Context, job *store.MediaJob) (*store.MediaResult, error) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		return nil, fmt.Errorf("ffmpeg not installed on this worker")
	}
	dir, err := os.MkdirTemp("", "thassa-media-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)

	src := filepath.Join(dir, "source")
	if err := p.download(ctx, job.S3Key, src); err != nil {
		return nil, fmt.Errorf("download raw: %w", err)
	}
	sw, sh, _, err := probe(ctx, src)
	if err != nil {
		return nil, fmt.Errorf("ffprobe: %w", err)
	}

	format := imageFormat() // "webp" when libwebp is available, else "jpeg"
	var recs []store.MediaVariantRec
	for _, w := range imageLadder(sw, imageLadderWidths) {
		outH := evenDim(sh * w / max(sw, 1))
		local := filepath.Join(dir, fmt.Sprintf("v_%d.%s", w, imageExt(format)))
		if err := encodeImageVariant(ctx, ffmpeg, src, local, w, format); err != nil {
			return nil, err
		}
		key := variantKey(job.MediaID.String(), w, format)
		if err := p.uploadFile(ctx, key, imageContentType(format), local); err != nil {
			return nil, fmt.Errorf("upload variant %dpx: %w", w, err)
		}
		recs = append(recs, store.MediaVariantRec{Width: w, Height: outH, Key: key, Format: format})
	}
	if len(recs) == 0 {
		return nil, fmt.Errorf("no image variants produced")
	}

	variantKeyBackCompat := pickBackCompatVariant(recs)
	return &store.MediaResult{
		VariantKey: variantKeyBackCompat,
		Variants:   recs,
		Width:      &sw,
		Height:     &sh,
	}, nil
}

// encodeImageVariant transcodes a single downscaled, metadata-stripped image
// variant at the given width. WebP targets quality 78, JPEG quality ~q:v 4
// (visually ~82 on the 0–100 scale) — both tuned for low file size.
func encodeImageVariant(ctx context.Context, ffmpeg, src, dst string, width int, format string) error {
	// scale='min(width,iw)':-2 guarantees no upscaling and an even height.
	scale := fmt.Sprintf("scale='min(%d,iw)':-2", width)
	args := []string{"-y", "-i", src, "-map_metadata", "-1", "-vf", scale, "-frames:v", "1"}
	switch format {
	case "webp":
		args = append(args, "-c:v", "libwebp", "-quality", "78", "-compression_level", "6")
	default: // jpeg
		args = append(args, "-c:v", "mjpeg", "-q:v", "4", "-pix_fmt", "yuvj420p")
	}
	args = append(args, dst)
	cmd := exec.CommandContext(ctx, ffmpeg, args...)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("ffmpeg image %dpx %s: %v: %s", width, format, err, tail(stderr.String()))
	}
	return nil
}

// pickBackCompatVariant returns the key of the variant used for the legacy
// single VariantURL: the ~1080px rung when present, else the widest.
func pickBackCompatVariant(recs []store.MediaVariantRec) *string {
	if len(recs) == 0 {
		return nil
	}
	best := recs[0]
	for _, r := range recs {
		if r.Width == backCompatVariantWidth {
			key := r.Key
			return &key
		}
		if r.Width > best.Width {
			best = r
		}
	}
	key := best.Key
	return &key
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

// variantKey is the deterministic object key for an image variant.
func variantKey(mediaID string, width int, format string) string {
	return fmt.Sprintf("variants/%s/%d.%s", mediaID, width, imageExt(format))
}

// posterKeyFor is the deterministic object key for a video poster.
func posterKeyFor(mediaID string) string {
	return fmt.Sprintf("poster/%s.jpg", mediaID)
}

func imageExt(format string) string {
	if format == "webp" {
		return "webp"
	}
	return "jpg"
}

func imageContentType(format string) string {
	if format == "webp" {
		return "image/webp"
	}
	return "image/jpeg"
}

// ---------------------------------------------------------------------------
// Encoder capability detection (libwebp) + helpers
// ---------------------------------------------------------------------------

var (
	webpOnce      sync.Once
	webpAvailable bool
)

// imageFormat is "webp" when the ffmpeg build has the libwebp encoder, else
// "jpeg" (fallback per requirement 6). Detected once and cached.
func imageFormat() string {
	webpOnce.Do(func() {
		webpAvailable = detectLibwebp()
	})
	if webpAvailable {
		return "webp"
	}
	return "jpeg"
}

func detectLibwebp() bool {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		return false
	}
	out, err := exec.Command(ffmpeg, "-hide_banner", "-encoders").Output()
	if err != nil {
		return false
	}
	return strings.Contains(string(out), "libwebp")
}

// evenDim rounds a dimension down to the nearest even number (H.264/chroma
// subsampling require even dimensions), with a floor of 2.
func evenDim(v int) int {
	if v < 2 {
		return 2
	}
	return v - v%2
}

func (p *Processor) uploadFile(ctx context.Context, key, contentType, path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return p.assets.Put(ctx, key, contentType, f)
}

func (p *Processor) download(ctx context.Context, key, dst string) error {
	rc, err := p.assets.Get(ctx, key)
	if err != nil {
		return err
	}
	defer rc.Close()
	f, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(f, rc)
	return err
}

// probe reads width/height/duration via ffprobe.
func probe(ctx context.Context, path string) (w, h int, dur time.Duration, err error) {
	ffprobe, err := exec.LookPath("ffprobe")
	if err != nil {
		return 0, 0, 0, fmt.Errorf("ffprobe not installed on this worker")
	}
	out, err := exec.CommandContext(ctx, ffprobe,
		"-v", "error",
		"-select_streams", "v:0",
		"-show_entries", "stream=width,height:format=duration",
		"-of", "json", path).Output()
	if err != nil {
		return 0, 0, 0, err
	}
	var res struct {
		Streams []struct {
			Width  int `json:"width"`
			Height int `json:"height"`
		} `json:"streams"`
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
	}
	if err := json.Unmarshal(out, &res); err != nil {
		return 0, 0, 0, err
	}
	if len(res.Streams) == 0 {
		return 0, 0, 0, fmt.Errorf("no video stream")
	}
	seconds, _ := strconv.ParseFloat(res.Format.Duration, 64)
	return res.Streams[0].Width, res.Streams[0].Height, time.Duration(seconds * float64(time.Second)), nil
}

func tail(s string) string {
	if len(s) > 400 {
		return s[len(s)-400:]
	}
	return s
}
