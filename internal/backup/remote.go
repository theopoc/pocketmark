package backup

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
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

	"pocketmark/internal/fault"
	"pocketmark/internal/observability"
)

var ErrChecksum = fault.New("backup", "checksum_mismatch", "uploaded backup checksum does not match the local archive")

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
		return nil, fault.New("backup", "s3_credentials_missing", "S3 access key or secret key is missing")
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
	info, e := r.Client.PutObject(ctx, r.Config.Bucket, key, reader, n, minio.PutObjectOptions{ContentType: "application/octet-stream", NumThreads: 1, PartSize: 8 << 20})
	return info.VersionID, e
}
func (r *Remote) Delete(ctx context.Context, key, version string) error {
	return r.Client.RemoveObject(ctx, r.Config.Bucket, key, minio.RemoveObjectOptions{VersionID: version})
}
func (r *Remote) Probe(ctx context.Context) (string, error) {
	var seed [16]byte
	rand.Read(seed[:])
	key := r.Config.Prefix + "/.probe/" + hex.EncodeToString(seed[:])
	version, e := r.Put(ctx, key, bytes.NewReader(seed[:]), 16)
	if e != nil {
		return "PutObject", e
	}
	get := func() error {
		f, e := r.Client.GetObject(ctx, r.Config.Bucket, key, minio.GetObjectOptions{VersionID: version})
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
	var app *fault.Error
	switch {
	case errors.Is(e, context.Canceled):
		return "cancelled", 0, false
	case errors.Is(e, context.DeadlineExceeded):
		return "timeout", 0, true
	case errors.As(e, &app) && app.Kind == "backup":
		// Backup faults (checksum, size, pg_dump causes) already carry their code.
		return app.Code, 0, false
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
	}
	var n net.Error
	if errors.As(e, &n) {
		if n.Timeout() {
			return "timeout", 0, true
		}
		return "network_error", 0, true
	}

	return "operation_failed", 0, false
}

var s3Reasons = map[string]string{
	"AccessDenied":          "S3 denied access; check the key permissions and the bucket policy",
	"SignatureDoesNotMatch": "S3 rejected the secret access key",
	"InvalidAccessKeyId":    "S3 does not recognize the access key ID",
	"NoSuchBucket":          "the S3 bucket does not exist",
	"SlowDown":              "S3 is throttling requests",
	"RequestTimeout":        "S3 timed out waiting for the request body",
	"InternalError":         "S3 reported an internal error",
	"ServiceUnavailable":    "S3 is unavailable",
}

// Reason explains a backup failure in one log-safe sentence. S3 error codes
// come from a fixed list; anything else uses the generic classification.
func Reason(e error) string {
	var s minio.ErrorResponse
	if errors.As(e, &s) {
		if reason, ok := s3Reasons[s.Code]; ok {
			return fmt.Sprintf("%s (HTTP %d)", reason, s.StatusCode)
		}
		return fmt.Sprintf("S3 request failed (HTTP %d %s)", s.StatusCode, http.StatusText(s.StatusCode))
	}
	if errors.Is(e, exec.ErrNotFound) {
		return "pg_dump is not installed or not in PATH"
	}
	return observability.Describe(e)
}
