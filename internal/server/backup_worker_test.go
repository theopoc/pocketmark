package server

import (
	"archive/zip"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"pocketmark/internal/pgtest"
	"testing"
	"time"

	"filippo.io/age"
	"github.com/minio/minio-go/v7"
	"pocketmark/internal/backup"
	"pocketmark/internal/store"
)

// Opt in with a disposable bucket; objects are scoped to the newly created test instance.
func TestGarageBackupRoundTrip(t *testing.T) {
	endpoint := os.Getenv("POCKETMARK_TEST_S3_ENDPOINT")
	if endpoint == "" {
		t.Skip("requires disposable S3 endpoint")
	}
	a := newTestServer(t, "", false)
	ctx := context.Background()
	identity, e := age.GenerateX25519Identity()
	if e != nil {
		t.Fatal(e)
	}
	c := backup.Default()
	c.Enabled = true
	c.Endpoint = endpoint
	c.Region = os.Getenv("POCKETMARK_TEST_S3_REGION")
	c.Bucket = os.Getenv("POCKETMARK_TEST_S3_BUCKET")
	c.AllowHTTP = true
	c.Recipient = identity.Recipient().String()
	c.Keep = 1
	c.Mode = "library"
	credentials := backup.Credentials{AccessKey: os.Getenv("POCKETMARK_TEST_S3_KEY"), SecretKey: os.Getenv("POCKETMARK_TEST_S3_SECRET")}
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
		payload, _ := json.Marshal(backup.Settings{Config: c, Credentials: credentials})
		if w := request(a, "PUT", "/api/backups/settings", string(payload), true, nil); w.Code != 200 {
			t.Fatalf("settings HTTP %d: %s", w.Code, w.Body)
		}
		if w := request(a, "POST", "/api/backups/run", "", true, nil); w.Code != 202 {
			t.Fatalf("queue HTTP %d: %s", w.Code, w.Body)
		}
		if e := a.Store.WorkBackup(ctx, func(j store.BackupJob) error { return a.runBackup(ctx, j) }); e != nil {
			t.Fatal(e)
		}
		rows, e := a.Store.History(ctx)
		if e != nil {
			t.Fatal(e)
		}
		if rows[0].Status != "succeeded" {
			t.Fatalf("status %s, diagnostic %v", rows[0].Status, rows[0].Diagnostic)
		}
		return rows[0]
	}
	read := func(r store.BackupRun) *zip.Reader {
		t.Helper()
		f, e := remote.Client.GetObject(ctx, c.Bucket, r.ObjectKey, minio.GetObjectOptions{})
		if e != nil {
			t.Fatal(e)
		}
		defer f.Close()
		decoded, e := age.Decrypt(f, identity)
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
	second := run("full")
	defer remote.Delete(ctx, second.ObjectKey)
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
	if _, e = remote.Client.StatObject(ctx, c.Bucket, first.ObjectKey, minio.StatObjectOptions{}); minio.ToErrorResponse(e).StatusCode != 404 {
		t.Fatal("old archive not expired")
	}
	metrics, e := a.Store.BackupMetrics(ctx)
	if e != nil || metrics["succeeded_total"] != 2 || metrics["deleted_total"] != 1 || metrics["last_success_timestamp_seconds"] < time.Now().Add(-time.Minute).Unix() {
		t.Fatal(metrics, e)
	}
}
