package storage

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// LocalStore mirrors the S3 presigned-PUT flow on the local filesystem for
// development (IN_PRODUCTION=false): PresignUpload returns a PUT URL served by
// this backend (/v1/uploads/local/{key}) and a static public URL (/uploads/{key}).
type LocalStore struct {
	dir     string
	baseURL string // http://localhost:PORT
}

// NewLocal builds a LocalStore rooted at dir, serving under baseURL.
func NewLocal(dir, baseURL string) (*LocalStore, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return &LocalStore{dir: dir, baseURL: strings.TrimRight(baseURL, "/")}, nil
}

func (s *LocalStore) PresignUpload(_ context.Context, key, _ string) (string, string, error) {
	return fmt.Sprintf("%s/v1/uploads/local/%s", s.baseURL, key), s.PublicURL(key), nil
}

func (s *LocalStore) PublicURL(key string) string {
	return fmt.Sprintf("%s/uploads/%s", s.baseURL, key)
}

// path resolves a key inside the upload dir, refusing traversal.
func (s *LocalStore) path(key string) (string, error) {
	clean := filepath.Clean("/" + key)
	p := filepath.Join(s.dir, clean)
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	root, err := filepath.Abs(s.dir)
	if err != nil {
		return "", err
	}
	if !strings.HasPrefix(abs, root+string(os.PathSeparator)) {
		return "", fmt.Errorf("invalid key")
	}
	return abs, nil
}

func (s *LocalStore) Get(_ context.Context, key string) (io.ReadCloser, error) {
	p, err := s.path(key)
	if err != nil {
		return nil, err
	}
	return os.Open(p)
}

func (s *LocalStore) Put(_ context.Context, key, _ string, body io.Reader) error {
	p, err := s.path(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	f, err := os.Create(p)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(f, body)
	return err
}

// Delete removes a stored object. A missing file is not an error (idempotent),
// mirroring S3 DeleteObject so the drop-original step can be safely re-run.
func (s *LocalStore) Delete(_ context.Context, key string) error {
	p, err := s.path(key)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// Dir returns the root upload directory (for the static file server).
func (s *LocalStore) Dir() string { return s.dir }
