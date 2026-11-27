package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/minio/minio-go/v7"
	"pocketmark/internal/backup"
)

// Tests in this file run against a real S3 service, normally the Garage
// bucket of the `make up` stack (`make test` exports its POCKETMARK_TEST_S3_*
// values). Without an endpoint they skip; the httptest fixture in
// backup_worker_test.go covers the same flows everywhere else.
func garageS3(t *testing.T) (backup.Config, backup.Credentials) {
	t.Helper()
	endpoint := os.Getenv("POCKETMARK_TEST_S3_ENDPOINT")
	if endpoint == "" {
		t.Skip("requires disposable S3 endpoint (POCKETMARK_TEST_S3_ENDPOINT, set by make up)")
	}
	c := backup.Default()
	c.Endpoint, c.AllowHTTP = endpoint, true
	if region := os.Getenv("POCKETMARK_TEST_S3_REGION"); region != "" {
		c.Region = region
	}
	c.Bucket = os.Getenv("POCKETMARK_TEST_S3_BUCKET")
	credentials := backup.Credentials{AccessKey: os.Getenv("POCKETMARK_TEST_S3_KEY"), SecretKey: os.Getenv("POCKETMARK_TEST_S3_SECRET")}
	// Each test writes under its own prefix and removes it afterwards, so
	// tests never see each other's objects in the shared bucket.
	var seed [8]byte
	rand.Read(seed[:])
	c.Prefix = "tests/" + hex.EncodeToString(seed[:])
	remote, err := backup.NewRemote(c, credentials)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		defer remote.Close()
		// t.Context is already cancelled when cleanups run.
		ctx := context.Background()
		for object := range remote.Client.ListObjects(ctx, c.Bucket, minio.ListObjectsOptions{Prefix: c.Prefix + "/", Recursive: true}) {
			if object.Err == nil {
				object.Err = remote.Client.RemoveObject(ctx, c.Bucket, object.Key, minio.RemoveObjectOptions{})
			}
			// Keep going: drain the listing and try every object.
			if object.Err != nil {
				t.Error("cleanup:", object.Err)
			}
		}
	})
	return c, credentials
}

func garageObjects(t *testing.T, remote *backup.Remote, prefix string) []string {
	t.Helper()
	var keys []string
	for object := range remote.Client.ListObjects(t.Context(), remote.Config.Bucket, minio.ListObjectsOptions{Prefix: prefix, Recursive: true}) {
		if object.Err != nil {
			t.Fatal(object.Err)
		}
		keys = append(keys, object.Key)
	}
	return keys
}

func TestGarageBackupRoundTrip(t *testing.T) {
	c, credentials := garageS3(t)
	testBackupRecovery(t, c, credentials)
}

// The owner's "Test connection" button: the handler writes, reads and deletes
// a probe, and reports a failure without echoing the submitted secret.
func TestGarageConnectionTest(t *testing.T) {
	c, credentials := garageS3(t)
	a := newTestServer(t, "", false)
	probe := func(k backup.Credentials) (int, string) {
		t.Helper()
		payload, err := json.Marshal(backup.Settings{Config: c, Credentials: k})
		if err != nil {
			t.Fatal(err)
		}
		w := request(a, "POST", "/api/backups/test", string(payload), true, nil)
		return w.Code, w.Body.String()
	}
	if status, body := probe(credentials); status != 200 {
		t.Fatalf("connection test failed: %d %s", status, body)
	}
	remote, err := backup.NewRemote(c, credentials)
	if err != nil {
		t.Fatal(err)
	}
	defer remote.Close()
	if left := garageObjects(t, remote, c.Prefix+"/.probe/"); len(left) != 0 {
		t.Fatal("probe objects left behind", left)
	}

	wrong := credentials
	wrong.SecretKey = "not-the-secret-" + hex.EncodeToString([]byte(t.Name()))
	status, body := probe(wrong)
	if status != 502 || !strings.Contains(body, "PutObject") {
		t.Fatalf("wrong secret: %d %s", status, body)
	}
	if strings.Contains(body, wrong.SecretKey) || strings.Contains(body, credentials.SecretKey) {
		t.Fatal("connection test response leaks a secret", body)
	}
}

// Error codes come from the real service, not from a fixture that only
// knows the codes the client expects.
func TestGarageDiagnosesDestinationErrors(t *testing.T) {
	c, credentials := garageS3(t)
	for _, tc := range []struct {
		name   string
		change func(*backup.Config, *backup.Credentials)
		codes  []string
	}{
		// Garage answers a bad signature with 403 AccessDenied; AWS uses
		// SignatureDoesNotMatch. Either way the owner sees a credential error.
		{"wrong secret", func(_ *backup.Config, k *backup.Credentials) { k.SecretKey = strings.Repeat("0", 64) }, []string{"SignatureDoesNotMatch", "AccessDenied"}},
		{"unknown key", func(_ *backup.Config, k *backup.Credentials) { k.AccessKey = "GK000000000000000000000000" }, []string{"InvalidAccessKeyId", "AccessDenied"}},
		{"missing bucket", func(c *backup.Config, _ *backup.Credentials) { c.Bucket = "pocketmark-missing-bucket" }, []string{"NoSuchBucket"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cc, kk := c, credentials
			tc.change(&cc, &kk)
			remote, err := backup.NewRemote(cc, kk)
			if err != nil {
				t.Fatal(err)
			}
			defer remote.Close()
			phase, err := remote.Probe(t.Context())
			if err == nil {
				t.Fatal("probe succeeded")
			}
			code, status, retry := backup.Diagnosis(err)
			t.Logf("%s: %s (HTTP %d)", phase, code, status)
			if phase != "PutObject" || !slices.Contains(tc.codes, code) || status < 400 || status >= 500 || retry {
				t.Fatalf("phase=%s code=%s status=%d retry=%v (%v)", phase, code, status, retry, err)
			}
		})
	}
}

// Age-based retention must really delete the expired object on the service.
func TestGarageRetentionDeletesExpiredCopy(t *testing.T) {
	c, credentials := garageS3(t)
	a := newTestServer(t, "", false)
	c.Mode, c.RetentionDays = "library", 1
	old := configureAndRunBackup(t, a, c, credentials)
	if old.Status != "succeeded" {
		t.Fatalf("first run: %s %v", old.Status, old.Diagnostic)
	}
	if _, err := a.db.Exec("UPDATE backup_objects SET verified=now()-interval '25 hours' WHERE id=$1", old.ID); err != nil {
		t.Fatal(err)
	}
	recent := configureAndRunBackup(t, a, c, credentials)
	if recent.Status != "succeeded" {
		t.Fatalf("second run: %s %v", recent.Status, recent.Diagnostic)
	}
	remote, err := backup.NewRemote(c, credentials)
	if err != nil {
		t.Fatal(err)
	}
	defer remote.Close()
	if _, err := remote.Client.StatObject(t.Context(), c.Bucket, old.ObjectKey, minio.StatObjectOptions{}); minio.ToErrorResponse(err).Code != "NoSuchKey" {
		t.Fatal("expired object still present", err)
	}
	if _, err := remote.Client.StatObject(t.Context(), c.Bucket, recent.ObjectKey, minio.StatObjectOptions{}); err != nil {
		t.Fatal("recent object removed", err)
	}
	metrics, err := a.Store.BackupMetrics(t.Context())
	if err != nil || metrics["deleted_total"] != 1 || metrics["retention_errors_total"] != 0 {
		t.Fatal(metrics, err)
	}
}

// Objects above the 8 MiB part size go through a multipart upload, which the
// httptest fixture cannot accept.
func TestGarageMultipartUpload(t *testing.T) {
	c, credentials := garageS3(t)
	remote, err := backup.NewRemote(c, credentials)
	if err != nil {
		t.Fatal(err)
	}
	defer remote.Close()
	data := make([]byte, 17<<20+123)
	rand.Read(data)
	key := c.Prefix + "/multipart.bin"
	// Listing cleanup only sees completed objects; abort parts of a failed upload.
	t.Cleanup(func() { remote.Client.RemoveIncompleteUpload(context.Background(), c.Bucket, key) })
	if _, err := remote.Put(t.Context(), key, bytes.NewReader(data), int64(len(data))); err != nil {
		t.Fatal(err)
	}
	info, err := remote.Client.StatObject(t.Context(), c.Bucket, key, minio.StatObjectOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if info.Size != int64(len(data)) || !strings.HasSuffix(info.ETag, "-3") {
		t.Fatalf("size=%d etag=%s: expected a three-part upload", info.Size, info.ETag)
	}
	f, err := remote.Client.GetObject(t.Context(), c.Bucket, key, minio.GetObjectOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		t.Fatal(err)
	}
	if want := sha256.Sum256(data); !bytes.Equal(h.Sum(nil), want[:]) {
		t.Fatal("downloaded object differs from the upload")
	}
}
