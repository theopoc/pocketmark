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

type Remote struct {
	Client    *minio.Client
	Config    Config
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
func (r *Remote) Put(ctx context.Context, key string, reader io.Reader, n int64) error {
	_, e := r.Client.PutObject(ctx, r.Config.Bucket, key, reader, n, minio.PutObjectOptions{ContentType: "application/octet-stream", NumThreads: 1, PartSize: 8 << 20})
	return e
}
func (r *Remote) Delete(ctx context.Context, key string) error {
	return r.Client.RemoveObject(ctx, r.Config.Bucket, key, minio.RemoveObjectOptions{})
}
func (r *Remote) Probe(ctx context.Context) (string, error) {
	var seed [16]byte
	rand.Read(seed[:])
	key := r.Config.Prefix + "/.probe/" + hex.EncodeToString(seed[:])
	if e := r.Put(ctx, key, bytes.NewReader(seed[:]), 16); e != nil {
		return "PutObject", e
	}
	get := func() error {
		f, e := r.Client.GetObject(ctx, r.Config.Bucket, key, minio.GetObjectOptions{})
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
	del := r.Delete(ctx, key)
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
