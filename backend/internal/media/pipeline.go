// Package media is the ffmpeg processing pipeline (spec §6.8): raw uploads
// are transcoded to HLS (H.264/AAC, 4s segments, 720p + 480p renditions when
// the source allows) and uploaded back to the bucket under hls/{mediaId}/…;
// images get a feed-size variant. Jobs live in the media_jobs table and are
// claimed with FOR UPDATE SKIP LOCKED, so any number of workers across any
// number of instances is safe (spec §6.7).
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
	"time"

	"github.com/pjol/THASSA/backend/internal/store"
	"github.com/pjol/THASSA/backend/internal/storage"
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
	var (
		hlsKey, variantKey     *string
		width, height, duration *int
		err                    error
	)
	switch job.Kind {
	case "video":
		hlsKey, width, height, duration, err = p.processVideo(ctx, job)
	case "image":
		variantKey, width, height, err = p.processImage(ctx, job)
	default:
		err = fmt.Errorf("unknown media kind %q", job.Kind)
	}
	if err != nil {
		log.Printf("media: job %s failed: %v", job.ID, err)
	}
	if ferr := p.db.FinishMediaJob(ctx, job.ID, job.MediaID, hlsKey, variantKey, width, height, duration, err); ferr != nil {
		log.Printf("media: finish job %s: %v", job.ID, ferr)
	}
}

// rendition describes one HLS variant.
type rendition struct {
	name      string
	height    int
	bandwidth int // bits/s advertised in the master playlist
	crf       string
}

var renditions = []rendition{
	{name: "720p", height: 720, bandwidth: 2800000, crf: "21"},
	{name: "480p", height: 480, bandwidth: 1200000, crf: "23"},
}

// processVideo downloads the raw upload, transcodes each rendition the source
// height allows (always at least the smallest), writes a master playlist, and
// uploads the tree to hls/{mediaId}/.
func (p *Processor) processVideo(ctx context.Context, job *store.MediaJob) (hlsKey *string, w, h, durMS *int, err error) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		return nil, nil, nil, nil, fmt.Errorf("ffmpeg not installed on this worker")
	}

	dir, err := os.MkdirTemp("", "thassa-media-*")
	if err != nil {
		return nil, nil, nil, nil, err
	}
	defer os.RemoveAll(dir)

	src := filepath.Join(dir, "source")
	if err := p.download(ctx, job.S3Key, src); err != nil {
		return nil, nil, nil, nil, fmt.Errorf("download raw: %w", err)
	}

	sw, sh, sd, err := probe(ctx, src)
	if err != nil {
		return nil, nil, nil, nil, fmt.Errorf("ffprobe: %w", err)
	}

	// Pick renditions the source allows (720p only when source ≥ 720 tall);
	// always include the smallest so every video gets at least one variant.
	var chosen []rendition
	for _, r := range renditions {
		if sh >= r.height || r.height == renditions[len(renditions)-1].height {
			chosen = append(chosen, r)
		}
	}

	outDir := filepath.Join(dir, "hls")
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return nil, nil, nil, nil, err
	}

	master := "#EXTM3U\n#EXT-X-VERSION:3\n"
	for _, r := range chosen {
		playlist := fmt.Sprintf("%s.m3u8", r.name)
		segments := fmt.Sprintf("%s_%%04d.ts", r.name)
		cmd := exec.CommandContext(ctx, ffmpeg,
			"-y", "-i", src,
			"-vf", fmt.Sprintf("scale=-2:%d", r.height),
			"-c:v", "libx264", "-preset", "veryfast", "-crf", r.crf,
			"-c:a", "aac", "-b:a", "128k",
			"-hls_time", "4", // 4s segments per spec §6.8
			"-hls_playlist_type", "vod",
			"-hls_segment_filename", filepath.Join(outDir, segments),
			filepath.Join(outDir, playlist),
		)
		var stderr strings.Builder
		cmd.Stderr = &stderr
		if err := cmd.Run(); err != nil {
			return nil, nil, nil, nil, fmt.Errorf("ffmpeg %s: %v: %s", r.name, err, tail(stderr.String()))
		}
		outW := sw * r.height / max(sh, 1)
		master += fmt.Sprintf("#EXT-X-STREAM-INF:BANDWIDTH=%d,RESOLUTION=%dx%d\n%s\n",
			r.bandwidth, outW-outW%2, r.height, playlist)
	}
	if err := os.WriteFile(filepath.Join(outDir, "master.m3u8"), []byte(master), 0o644); err != nil {
		return nil, nil, nil, nil, err
	}

	// Upload the whole tree under hls/{mediaId}/.
	prefix := fmt.Sprintf("hls/%s", job.MediaID)
	entries, err := os.ReadDir(outDir)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		f, err := os.Open(filepath.Join(outDir, e.Name()))
		if err != nil {
			return nil, nil, nil, nil, err
		}
		ct := "video/mp2t"
		if strings.HasSuffix(e.Name(), ".m3u8") {
			ct = "application/vnd.apple.mpegurl"
		}
		uploadErr := p.assets.Put(ctx, prefix+"/"+e.Name(), ct, f)
		f.Close()
		if uploadErr != nil {
			return nil, nil, nil, nil, fmt.Errorf("upload %s: %w", e.Name(), uploadErr)
		}
	}

	key := prefix + "/master.m3u8"
	ms := int(sd.Milliseconds())
	return &key, &sw, &sh, &ms, nil
}

// processImage stores a feed-size variant (max width 1080) next to the
// original.
func (p *Processor) processImage(ctx context.Context, job *store.MediaJob) (variantKey *string, w, h *int, err error) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		return nil, nil, nil, fmt.Errorf("ffmpeg not installed on this worker")
	}
	dir, err := os.MkdirTemp("", "thassa-media-*")
	if err != nil {
		return nil, nil, nil, err
	}
	defer os.RemoveAll(dir)

	src := filepath.Join(dir, "source")
	if err := p.download(ctx, job.S3Key, src); err != nil {
		return nil, nil, nil, fmt.Errorf("download raw: %w", err)
	}
	sw, sh, _, err := probe(ctx, src)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("ffprobe: %w", err)
	}

	out := filepath.Join(dir, "feed.jpg")
	cmd := exec.CommandContext(ctx, ffmpeg, "-y", "-i", src,
		"-vf", "scale='min(1080,iw)':-2", "-frames:v", "1", "-q:v", "3", out)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, nil, nil, fmt.Errorf("ffmpeg image: %v: %s", err, tail(stderr.String()))
	}
	f, err := os.Open(out)
	if err != nil {
		return nil, nil, nil, err
	}
	defer f.Close()
	key := fmt.Sprintf("feed/%s.jpg", job.MediaID)
	if err := p.assets.Put(ctx, key, "image/jpeg", f); err != nil {
		return nil, nil, nil, fmt.Errorf("upload variant: %w", err)
	}
	return &key, &sw, &sh, nil
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
