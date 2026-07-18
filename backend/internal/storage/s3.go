package storage

import (
	"context"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"github.com/pjol/THASSA/backend/internal/config"
)

// S3Store wraps an S3-compatible client for presigned uploads + public URLs.
// Works with AWS S3 or MinIO (path-style).
type S3Store struct {
	client    *s3.Client
	presign   *s3.PresignClient
	bucket    string
	publicURL string
}

// NewS3 builds an S3Store from config.
func NewS3(ctx context.Context, c *config.Config) (*S3Store, error) {
	opts := []func(*awsconfig.LoadOptions) error{
		awsconfig.WithRegion(c.S3Region),
	}
	if c.S3AccessKey != "" {
		opts = append(opts, awsconfig.WithCredentialsProvider(
			credentials.NewStaticCredentialsProvider(c.S3AccessKey, c.S3SecretKey, ""),
		))
	}
	awsCfg, err := awsconfig.LoadDefaultConfig(ctx, opts...)
	if err != nil {
		return nil, fmt.Errorf("load aws config: %w", err)
	}

	client := s3.NewFromConfig(awsCfg, func(o *s3.Options) {
		if c.S3Endpoint != "" {
			o.BaseEndpoint = aws.String(c.S3Endpoint)
		}
		o.UsePathStyle = c.S3ForcePathStyle
	})

	return &S3Store{
		client:    client,
		presign:   s3.NewPresignClient(client),
		bucket:    c.S3Bucket,
		publicURL: strings.TrimRight(c.S3PublicURL, "/"),
	}, nil
}

// PresignUpload returns a PUT URL the client uploads directly to, plus the
// public URL the stored object will be served from.
func (s *S3Store) PresignUpload(ctx context.Context, key, contentType string) (string, string, error) {
	req, err := s.presign.PresignPutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(s.bucket),
		Key:         aws.String(key),
		ContentType: aws.String(contentType),
	}, s3.WithPresignExpires(15*time.Minute))
	if err != nil {
		return "", "", err
	}
	return req.URL, s.PublicURL(key), nil
}

func (s *S3Store) PublicURL(key string) string {
	return fmt.Sprintf("%s/%s", s.publicURL, key)
}

func (s *S3Store) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	out, err := s.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return nil, err
	}
	return out.Body, nil
}

func (s *S3Store) Put(ctx context.Context, key, contentType string, body io.Reader) error {
	_, err := s.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(s.bucket),
		Key:         aws.String(key),
		ContentType: aws.String(contentType),
		Body:        body,
	})
	return err
}

// Delete removes an object. S3 DeleteObject is idempotent (deleting a missing
// key succeeds), so re-running the drop-original step is safe.
func (s *S3Store) Delete(ctx context.Context, key string) error {
	_, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	})
	return err
}
