// Package storage abstracts the S3-style object store (MinIO in dev). The
// media pipeline also needs raw Get/Put access for ffmpeg transcodes, so the
// interface is a superset of ASSEMBLY's presign-only store.
package storage

import (
	"context"
	"io"
)

// Store is the object-storage surface used by handlers and the media worker.
type Store interface {
	// PresignUpload returns a PUT URL the client uploads directly to, plus the
	// public URL the stored object will be served from.
	PresignUpload(ctx context.Context, key, contentType string) (uploadURL, publicURL string, err error)
	// PublicURL returns the serving URL for a stored key.
	PublicURL(key string) string
	// Get streams a stored object.
	Get(ctx context.Context, key string) (io.ReadCloser, error)
	// Put stores an object.
	Put(ctx context.Context, key, contentType string, body io.Reader) error
	// Delete removes a stored object. Deleting a missing key is not an error
	// (idempotent), so callers can safely re-run.
	Delete(ctx context.Context, key string) error
}
