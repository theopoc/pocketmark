package backup

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"io"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"syscall"
	"time"
)

var ErrChecksum = errors.New("backup checksum mismatch")

// ObjectStore is the remote seam of a backup run. An adapter only moves
// bytes: the run itself proves delivery by reading a copy back and comparing
// its length and digest (ADR 0001), so an adapter cannot report a verified copy.
type ObjectStore interface {
	// Put stores n bytes under key and returns the version it created, if any.
	Put(ctx context.Context, key string, r io.Reader, n int64) (version string, err error)
	// Open reads one version of key; an empty version reads the current one.
	Open(ctx context.Context, key, version string) (io.ReadCloser, error)
	// Version reports the current version of key; found is false when absent.
	Version(ctx context.Context, key string) (version string, found bool, err error)
	// Delete removes one version of key permanently.
	Delete(ctx context.Context, key, version string) error
	Close()
}

// Remote is the S3-compatible ObjectStore adapter.
type Remote struct {
	client    *minio.Client
	config    Config
	transport *http.Transport
}

func NewRemote(c Config, k Credentials) (*Remote, error) {
	if e := c.DestinationOK(); e != nil {
		return nil, e
	}
	if k.AccessKey == "" || k.SecretKey == "" {
		return nil, errors.New("missing S3 credentials")
	}
	u, _ := url.Parse(c.Endpoint)
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.Proxy = nil
	tr.ResponseHeaderTimeout = 45 * time.Second
	cl, e := minio.New(u.Host, &minio.Options{Creds: credentials.NewStaticV4(k.AccessKey, k.SecretKey, ""), Secure: u.Scheme == "https", Region: c.Region, BucketLookup: minio.BucketLookupPath, Transport: tr, MaxRetries: 1})
	if e != nil {
		return nil, e
	}
	return &Remote{cl, c, tr}, nil
}
func (r *Remote) Close() { r.transport.CloseIdleConnections() }
func (r *Remote) Put(ctx context.Context, key string, reader io.Reader, n int64) (string, error) {
	info, e := r.client.PutObject(ctx, r.config.Bucket, key, reader, n, minio.PutObjectOptions{ContentType: "application/octet-stream", NumThreads: 1, PartSize: 8 << 20})
	return info.VersionID, e
}
func (r *Remote) Open(ctx context.Context, key, version string) (io.ReadCloser, error) {
	return r.client.GetObject(ctx, r.config.Bucket, key, minio.GetObjectOptions{VersionID: version})
}
func (r *Remote) Version(ctx context.Context, key string) (string, bool, error) {
	info, e := r.client.StatObject(ctx, r.config.Bucket, key, minio.StatObjectOptions{})
	if e != nil {
		if minio.ToErrorResponse(e).StatusCode == 404 {
			return "", false, nil
		}
		return "", false, e
	}
	return info.VersionID, true, nil
}
func (r *Remote) Delete(ctx context.Context, key, version string) error {
	return r.client.RemoveObject(ctx, r.config.Bucket, key, minio.RemoveObjectOptions{VersionID: version})
}

// Probe writes, reads back and deletes a random object under the configured
// prefix. It returns the S3 operation that failed.
func (r *Remote) Probe(ctx context.Context) (string, error) {
	var seed [16]byte
	rand.Read(seed[:])
	key := r.config.Prefix + "/.probe/" + hex.EncodeToString(seed[:])
	version, e := r.Put(ctx, key, bytes.NewReader(seed[:]), 16)
	if e != nil {
		return "PutObject", e
	}
	get := func() error {
		f, e := r.Open(ctx, key, version)
		if e != nil {
			return e
		}
		defer f.Close()
		data, e := io.ReadAll(io.LimitReader(f, 17))
		if e == nil && !bytes.Equal(data, seed[:]) {
			e = ErrChecksum
		}
		return e
	}()
	del := r.Delete(ctx, key, version)
	if get != nil {
		return "GetObject", get
	}
	return "DeleteObject", del
}
func Diagnosis(e error) (code string, status int, retry bool) {
	var s minio.ErrorResponse
	if errors.As(e, &s) {
		switch s.Code {
		case "AccessDenied", "SignatureDoesNotMatch", "InvalidAccessKeyId", "NoSuchBucket", "SlowDown", "RequestTimeout", "InternalError", "ServiceUnavailable":
			code = s.Code
		default:
			code = "s3_error"
		}
		return code, s.StatusCode, s.StatusCode >= 500 || s.StatusCode == 429 || s.StatusCode == 408
	}
	var cert *tls.CertificateVerificationError
	var exit *exec.ExitError
	var pg *pgconn.PgError
	switch {
	case errors.Is(e, ErrLibrarySize):
		return "library_zip_too_large", 0, false
	case errors.Is(e, ErrChecksum):
		return "checksum_mismatch", 0, false
	case errors.As(e, &cert):
		return "certificate_verification", 0, false
	case errors.Is(e, syscall.ENOSPC):
		return "disk_full", 0, false
	case errors.Is(e, exec.ErrNotFound):
		return "pg_dump_missing", 0, false
	case errors.As(e, &exit):
		return "pg_dump_failed", 0, false
	case errors.As(e, &pg):
		return "postgresql", 0, pg.Code == "40001" || pg.Code == "40P01"
	case errors.Is(e, context.Canceled):
		return "cancelled", 0, false
	}
	var n net.Error
	if errors.As(e, &n) {
		if n.Timeout() {
			return "timeout", 0, true
		}
		return "network_error", 0, true
	}
	if errors.Is(e, context.DeadlineExceeded) {
		return "timeout", 0, true
	}

	return "operation_failed", 0, false
}
