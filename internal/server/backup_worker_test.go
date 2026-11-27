package server

import (
	"archive/zip"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/minio/minio-go/v7"
	"pocketmark/internal/backup"
	"pocketmark/internal/pgtest"
	"pocketmark/internal/store"
)

// Small, path-style S3 fixture. The production client signs requests, sends the
// encrypted file and reads it back over HTTP, including AWS streaming signatures.
func testS3(t *testing.T) (backup.Config, backup.Credentials, *atomic.Bool) {
	t.Helper()
	var denyDeletes atomic.Bool
	var mu sync.Mutex
	objects := make(map[string][]byte)
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		key := r.URL.Path
		if !strings.HasPrefix(key, "/pocketmark-test/") || !strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 ") {
			http.Error(w, "invalid signed request", http.StatusBadRequest)
			return
		}
		switch r.Method {
		case http.MethodPut:
			var reader io.Reader = r.Body
			if strings.HasPrefix(r.Header.Get("X-Amz-Content-Sha256"), "STREAMING-") {
				reader = httputil.NewChunkedReader(reader)
			}
			data, err := io.ReadAll(io.LimitReader(reader, 2<<20))
			if err != nil || len(data) >= 2<<20 {
				http.Error(w, "bad upload", 400)
				return
			}
			objects[key] = data
			w.Header().Set("ETag", `"fixture-etag"`)
			w.Header().Set("X-Amz-Version-Id", "test-version")
			w.WriteHeader(http.StatusOK)
		case http.MethodGet, http.MethodHead:
			data, ok := objects[key]
			if !ok {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("ETag", `"fixture-etag"`)
			w.Header().Set("Content-Type", "application/octet-stream")
			http.ServeContent(w, r, key, time.Unix(1735689600, 0), bytes.NewReader(data))
		case http.MethodDelete:
			if r.URL.Query().Get("versionId") != "test-version" {
				http.Error(w, "a delete marker would leave the original intact", 409)
				return
			}
			if denyDeletes.Load() {
				w.Header().Set("Content-Type", "application/xml")
				w.WriteHeader(http.StatusForbidden)
				io.WriteString(w, "<Error><Code>AccessDenied</Code><Message>Delete denied</Message></Error>")
				return
			}
			delete(objects, key)
			w.WriteHeader(http.StatusNoContent)
		default:
			http.Error(w, "unsupported S3 operation", http.StatusBadRequest)
		}
	}))
	t.Cleanup(s.Close)
	c := backup.Default()
	c.Endpoint, c.Bucket, c.AllowHTTP = s.URL, "pocketmark-test", true
	return c, backup.Credentials{AccessKey: "fixture-id", SecretKey: "fixture-secret"}, &denyDeletes
}

func configureBackup(t *testing.T, a *testServer, c backup.Config, credentials backup.Credentials) {
	t.Helper()
	payload, err := json.Marshal(backup.Settings{Config: c, Credentials: credentials})
	if err != nil {
		t.Fatal(err)
	}
	requireStatus(t, request(a, "PUT", "/api/backups/settings", string(payload), true, nil), 200)
}

func configureAndRunBackup(t *testing.T, a *testServer, c backup.Config, credentials backup.Credentials) store.BackupRun {
	t.Helper()
	ctx := t.Context()
	configureBackup(t, a, c, credentials)
	requireStatus(t, request(a, "POST", "/api/backups/run", "", true, nil), 202)
	if err := a.Store.WorkBackup(ctx, func(j store.BackupJob) error { return a.runBackup(ctx, j) }); err != nil {
		t.Fatal(err)
	}
	rows, err := a.Store.History(ctx)
	if err != nil || len(rows) == 0 {
		t.Fatal("missing run", err)
	}
	return rows[0]
}

func TestRemoteBackupRoundTrip(t *testing.T) {
	c, credentials, _ := testS3(t)
	testBackupRecovery(t, c, credentials)
}

type backupTelegramRecorder func(*http.Request) (*http.Response, error)

func (f backupTelegramRecorder) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestRetentionRefusalPreservesVerifiedCopyAndAlertsOnce(t *testing.T) {
	a := newTestServer(t, "", false)
	c, credentials, deny := testS3(t)
	c.Mode, c.RetentionDays, c.TelegramChatID = "library", 1, "-999"
	credentials.TelegramToken = "123:fixture"

	old := configureAndRunBackup(t, a, c, credentials)
	recent := configureAndRunBackup(t, a, c, credentials)
	if old.Status != "succeeded" || recent.Status != "succeeded" {
		t.Fatalf("expected two verified recent backups, got %s %s", old.Status, recent.Status)
	}
	// A one-day policy must keep both copies created today. Only the older
	// object's verification time is moved outside the retention window.
	var copies int
	if err := a.db.QueryRow("SELECT count(*) FROM backup_objects").Scan(&copies); err != nil || copies != 2 {
		t.Fatal("recent copy pruned by count", copies, err)
	}
	if _, err := a.db.Exec("UPDATE backup_objects SET verified=now()-interval '25 hours' WHERE id=$1", old.ID); err != nil {
		t.Fatal(err)
	}
	// Use a distinct timestamp even on a very fast test machine.
	lastSuccess := time.Now().Add(-time.Hour).Unix()
	if _, err := a.db.Exec("UPDATE backup_metrics SET value=$1 WHERE name='last_success_timestamp_seconds'", lastSuccess); err != nil {
		t.Fatal(err)
	}
	deny.Store(true)
	failed := configureAndRunBackup(t, a, c, credentials)
	if failed.Status != "failed" || failed.Stage != "retention" || failed.VerifiedAt == nil || failed.Diagnostic["error_code"] != "AccessDenied" {
		t.Fatalf("status=%s stage=%s verified=%v diagnostic=%v", failed.Status, failed.Stage, failed.VerifiedAt, failed.Diagnostic)
	}
	remote, err := backup.NewRemote(c, credentials)
	if err != nil {
		t.Fatal(err)
	}
	defer remote.Close()
	for _, key := range []string{old.ObjectKey, recent.ObjectKey, failed.ObjectKey} {
		if _, err := remote.Client.StatObject(t.Context(), c.Bucket, key, minio.StatObjectOptions{}); err != nil {
			t.Fatal("missing remote copy after refusal", err)
		}
	}
	metrics, err := a.Store.BackupMetrics(t.Context())
	if err != nil || metrics["retention_errors_total"] != 1 || metrics["failed_total"] != 1 || metrics["succeeded_total"] != 2 || metrics["last_success_timestamp_seconds"] != lastSuccess {
		t.Fatal(metrics, err)
	}
	calls := 0
	a.telegramTransport = backupTelegramRecorder(func(r *http.Request) (*http.Response, error) {
		calls++
		var message struct {
			Chat string `json:"chat_id"`
			Text string `json:"text"`
		}
		if err := json.NewDecoder(r.Body).Decode(&message); err != nil {
			t.Fatal(err)
		}
		if message.Chat != c.TelegramChatID || !strings.Contains(message.Text, failed.ID) || !strings.Contains(message.Text, "retention") || !strings.Contains(message.Text, "verified") || !strings.Contains(message.Text, time.Unix(lastSuccess, 0).UTC().Format(time.RFC3339)) {
			t.Fatalf("incorrect failure alert %q", message.Text)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"ok":true}`))}, nil
	})
	for range 2 {
		if err := a.dispatchBackupNotification(t.Context()); err != nil {
			t.Fatal(err)
		}
	}
	if calls != 1 {
		t.Fatalf("sent %d alerts", calls)
	}

	deny.Store(false)
	after := configureAndRunBackup(t, a, c, credentials)
	if after.Status != "succeeded" {
		t.Fatalf("cleanup on following run failed: %v", after.Diagnostic)
	}
	metrics, err = a.Store.BackupMetrics(t.Context())
	if err != nil || metrics["deleted_total"] != 1 || metrics["succeeded_total"] != 3 {
		t.Fatal(metrics, err)
	}
	if _, err = remote.Client.StatObject(t.Context(), c.Bucket, old.ObjectKey, minio.StatObjectOptions{}); minio.ToErrorResponse(err).StatusCode != 404 {
		t.Fatal("expired object still present", err)
	}
	var status, notification string
	if err := a.db.QueryRow("SELECT status,notification FROM backup_runs WHERE id=$1", failed.ID).Scan(&status, &notification); err != nil || status != "failed" || notification != "sent" {
		t.Fatal("later cleanup changed the historical failure", status, notification, err)
	}
}

func testBackupRecovery(t *testing.T, c backup.Config, credentials backup.Credentials) {
	t.Helper()
	a := newTestServer(t, "", false)
	ctx := context.Background()
	remote, e := backup.NewRemote(c, credentials)
	if e != nil {
		t.Fatal(e)
	}
	defer remote.Close()
	if phase, e := remote.Probe(ctx); e != nil {
		code, _, _ := backup.Diagnosis(e)
		t.Fatalf("%s: %s", phase, code)
	}
	if _, e = a.Store.Create(ctx, store.Link{URL: "https://example.test/roundtrip", Title: "Roundtrip"}); e != nil {
		t.Fatal(e)
	}
	run := func(mode string) store.BackupRun {
		t.Helper()
		c.Mode = mode
		run := configureAndRunBackup(t, a, c, credentials)
		if run.Status != "succeeded" || run.VerifiedAt == nil {
			t.Fatalf("status %s, diagnostic %v", run.Status, run.Diagnostic)
		}
		return run
	}
	read := func(r store.BackupRun) *zip.Reader {
		t.Helper()
		f, e := remote.Client.GetObject(ctx, c.Bucket, r.ObjectKey, minio.GetObjectOptions{})
		if e != nil {
			t.Fatal(e)
		}
		defer f.Close()
		decoded, e := backup.DecryptArchive(f, a.token)
		if e != nil {
			t.Fatal(e)
		}
		b, e := io.ReadAll(decoded)
		if e != nil {
			t.Fatal(e)
		}
		z, e := zip.NewReader(bytes.NewReader(b), int64(len(b)))
		if e != nil {
			t.Fatal(e)
		}
		return z
	}
	first := run("library")
	defer remote.Delete(ctx, first.ObjectKey, "")
	z := read(first)
	m, e := store.ReadManifest(z)
	if e != nil {
		t.Fatal(e)
	}
	dest := newTestServer(t, "", false)
	if e = dest.Store.RestoreLibrary(ctx, z, m); e != nil {
		t.Fatal(e)
	}
	if l, e := dest.Store.Get(ctx, 1); e != nil || l.Title != "Roundtrip" {
		t.Fatal("restored bookmark missing", e)
	}
	// A backup can expire by age, but only another backup of its format
	// may prune it. This full backup must leave the old library copy intact.
	if _, e := a.db.Exec("UPDATE backup_objects SET verified=now()-interval '8 days' WHERE id=$1", first.ID); e != nil {
		t.Fatal(e)
	}
	second := run("full")
	defer remote.Delete(ctx, second.ObjectKey, "")
	sqlDump, e := read(second).Open("pocketmark.sql")
	if e != nil {
		t.Fatal(e)
	}
	defer sqlDump.Close()
	b, e := io.ReadAll(sqlDump)
	if e != nil || !bytes.Contains(b, []byte("Roundtrip")) {
		t.Fatal("invalid full dump", e)
	}
	dumpPath := filepath.Join(t.TempDir(), "pocketmark.sql")
	if e = os.WriteFile(dumpPath, b, 0600); e != nil {
		t.Fatal(e)
	}
	db, e := sql.Open("pgx", pgtest.Restore(t, dumpPath))
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	var restored bool
	if e = db.QueryRow("SELECT EXISTS(SELECT FROM links WHERE title='Roundtrip') AND NOT EXISTS(SELECT FROM backup_settings) AND NOT EXISTS(SELECT FROM backup_runs) AND NOT EXISTS(SELECT FROM sessions)").Scan(&restored); e != nil || !restored {
		t.Fatal("unexpected full restore state", e)
	}
	if _, e = remote.Client.StatObject(ctx, c.Bucket, first.ObjectKey, minio.StatObjectOptions{}); e != nil {
		t.Fatal("full run removed a library copy", e)
	}
	metrics, e := a.Store.BackupMetrics(ctx)
	if e != nil || metrics["succeeded_total"] != 2 || metrics["deleted_total"] != 0 || metrics["last_success_timestamp_seconds"] < time.Now().Add(-time.Minute).Unix() {
		t.Fatal(metrics, e)
	}
}
