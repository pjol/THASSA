package api

import (
	"io"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/pjol/THASSA/backend/internal/auth"
	"github.com/pjol/THASSA/backend/internal/respond"
)

// Media kind is accepted for ANY image/* or video/* content type (all photo and
// video formats). SVG is the one exclusion — it can carry active content and is
// an XSS vector when served inline, and it isn't a real photo format anyway.
//
// mediaKind resolves the media kind from the content type (authoritative, robust
// across clients that omit `kind`), falling back to the client-declared kind
// when the content type is missing or generic (e.g. application/octet-stream).
func mediaKind(contentType, declaredKind string) (kind string, ok bool) {
	ct := strings.ToLower(strings.TrimSpace(contentType))
	switch {
	case ct == "image/svg+xml":
		return "", false
	case strings.HasPrefix(ct, "image/"):
		return "image", true
	case strings.HasPrefix(ct, "video/"):
		return "video", true
	}
	// No usable content type — trust the client's declared kind.
	switch declaredKind {
	case "image", "video":
		return declaredKind, true
	}
	return "", false
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
	kind, ok := mediaKind(req.ContentType, req.Kind)
	if !ok {
		respond.Error(w, http.StatusBadRequest, "unsupported media type — attach a photo or video")
		return
	}
	// Size limits only (all photo/video formats accepted). SizeBytes is optional
	// (some clients stream without a known length); enforce the cap when given.
	switch kind {
	case "image":
		if req.SizeBytes > maxImageBytes {
			respond.Error(w, http.StatusBadRequest, "image exceeds size limit")
			return
		}
	case "video":
		if req.SizeBytes > maxVideoBytes {
			respond.Error(w, http.StatusBadRequest, "video exceeds size limit")
			return
		}
	}

	// Presign with a concrete content type so the storage PUT and later
	// transcoding know the format; default per kind when the client omitted it.
	contentType := strings.TrimSpace(req.ContentType)
	if contentType == "" {
		if kind == "video" {
			contentType = "video/mp4"
		} else {
			contentType = "image/jpeg"
		}
	}
	key := uploadKey("media", id.UserID, req.Filename)
	uploadURL, publicURL, err := s.assets.PresignUpload(r.Context(), key, contentType)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to presign upload")
		return
	}
	mediaID, err := s.db.CreateMedia(r.Context(), id.UserID, kind, key)
	if err != nil {
		respond.Error(w, http.StatusInternalServerError, "failed to create media")
		return
	}
	respond.JSON(w, http.StatusCreated, map[string]any{
		"media": map[string]any{
			"id":         mediaID,
			"kind":       kind,
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
