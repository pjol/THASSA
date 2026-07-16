package api

import (
	"io"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/pjol/THASSA/backend/internal/auth"
	"github.com/pjol/THASSA/backend/internal/respond"
)

// Content-type + size validation on presign (spec §8).
var allowedImageTypes = map[string]bool{
	"image/jpeg": true, "image/png": true, "image/webp": true, "image/gif": true, "image/heic": true,
}

var allowedVideoTypes = map[string]bool{
	"video/mp4": true, "video/quicktime": true, "video/webm": true,
}

const (
	maxImageBytes = int64(25 << 20)  // 25 MiB
	maxVideoBytes = int64(512 << 20) // 512 MiB
)

type createMediaRequest struct {
	Kind        string `json:"kind"` // image | video
	ContentType string `json:"content_type"`
	Filename    string `json:"filename"`
	SizeBytes   int64  `json:"size_bytes"`
}

// handleCreateMedia validates type/size and returns a presigned PUT (S3 in
// production, this server's local-upload endpoint in dev) plus the media row
// id the client uses to attach + complete.
func (s *Server) handleCreateMedia(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req createMediaRequest
	if err := respond.Decode(r, &req); err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid body")
		return
	}
	switch req.Kind {
	case "image":
		if !allowedImageTypes[req.ContentType] {
			respond.Error(w, http.StatusBadRequest, "unsupported image content type")
			return
		}
		if req.SizeBytes <= 0 || req.SizeBytes > maxImageBytes {
			respond.Error(w, http.StatusBadRequest, "image exceeds size limit")
			return
		}
	case "video":
		if !allowedVideoTypes[req.ContentType] {
			respond.Error(w, http.StatusBadRequest, "unsupported video content type")
			return
		}
		if req.SizeBytes <= 0 || req.SizeBytes > maxVideoBytes {
			respond.Error(w, http.StatusBadRequest, "video exceeds size limit")
			return
		}
	default:
		respond.Error(w, http.StatusBadRequest, "kind must be image or video")
		return
	}

	key := uploadKey("media", id.UserID, req.Filename)
	uploadURL, publicURL, err := s.assets.PresignUpload(r.Context(), key, req.ContentType)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to presign upload")
		return
	}
	mediaID, err := s.db.CreateMedia(r.Context(), id.UserID, req.Kind, key)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to create media")
		return
	}
	respond.JSON(w, http.StatusCreated, map[string]any{
		"media": map[string]any{
			"id":         mediaID,
			"kind":       req.Kind,
			"upload_url": uploadURL,
			"public_url": publicURL,
			"status":     "uploading",
		},
	})
}

// handleCompleteMedia marks the upload done and enqueues the ffmpeg job
// (video → HLS; image → feed-size variant). §8.1: ownership enforced in the
// UPDATE (owner_id = token user), 404 otherwise.
func (s *Server) handleCompleteMedia(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	mediaID, err := uuid.Parse(chiParam(r, "id"))
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid media id")
		return
	}
	ok, kind, err := s.db.CompleteMedia(r.Context(), id.UserID, mediaID)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to complete media")
		return
	}
	if !ok {
		respond.Error(w, http.StatusNotFound, "media not found")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"id": mediaID, "kind": kind, "status": "processing"})
}

// handleGetMedia returns processing status + URLs.
func (s *Server) handleGetMedia(w http.ResponseWriter, r *http.Request) {
	mediaID, err := uuid.Parse(chiParam(r, "id"))
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "invalid media id")
		return
	}
	media, _, _, err := s.db.GetMedia(r.Context(), mediaID)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to load media")
		return
	}
	if media == nil {
		respond.Error(w, http.StatusNotFound, "media not found")
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"media": media})
}

// handleLocalUpload accepts the dev-mode PUT that mirrors an S3 presigned
// upload (IN_PRODUCTION=false only). Keys are unguessable so no auth is
// required, exactly like a presigned URL.
func (s *Server) handleLocalUpload(w http.ResponseWriter, r *http.Request) {
	key := strings.TrimPrefix(r.URL.Path, "/v1/uploads/local/")
	if key == "" || strings.Contains(key, "..") {
		respond.Error(w, http.StatusBadRequest, "invalid key")
		return
	}
	body := http.MaxBytesReader(w, r.Body, maxVideoBytes)
	defer io.Copy(io.Discard, body) //nolint:errcheck
	if err := s.local.Put(r.Context(), key, r.Header.Get("Content-Type"), body); err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to store upload")
		return
	}
	w.WriteHeader(http.StatusOK)
}
