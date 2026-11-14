package store

import (
	"archive/zip"
	"bytes"
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"pocketmark/internal/backup"
	"pocketmark/internal/pgtest"
	"strings"
	"testing"
	"time"
)

func TestLibraryBackupSelectionAndRestore(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	web := createLink(t, s, Link{URL: "https://example.test", Title: "Web", Content: "omit"})
	if _, e := s.db.Exec("UPDATE links SET status='processing', archive=$1 WHERE id=$2", []byte("archive"), web); e != nil {
		t.Fatal(e)
	}
	_, asset, e := s.CreateFile(ctx, Link{URL: "pocketmark-file:" + strings.Repeat("a", 64), Title: "HTML file"}, Asset{Name: "note.html", MediaType: "text/html", Kind: "html"}, strings.NewReader("local file"))
	if e != nil {
		t.Fatal(e)
	}
	var b bytes.Buffer
	z := zip.NewWriter(&b)
	if e = s.LibraryBackup(ctx, z, backup.Config{Files: true}); e != nil {
		t.Fatal(e)
	}
	if e = z.Close(); e != nil {
		t.Fatal(e)
	}
	archive, e := OpenLibraryZip(bytes.NewReader(b.Bytes()), int64(b.Len()))
	if e != nil {
		t.Fatal(e)
	}
	m, e := ReadManifest(archive)
	if e != nil {
		t.Fatal(e)
	}
	target := testStore(t)
	if e = target.RestoreLibrary(ctx, archive, m); e != nil {
		t.Fatal(e)
	}
	if r := getLink(t, target, web); r.Status != "pending" || r.Content != "" {
		t.Fatalf("incorrect restored metadata %v", r)
	}
	var out bytes.Buffer
	if e = target.WriteAsset(ctx, asset.ID, &out); e != nil || out.String() != "local file" {
		t.Fatal("standalone HTML file missing", e)
	}
	if e = target.RestoreLibrary(ctx, archive, m); !errors.Is(e, ErrLibraryNotEmpty) {
		t.Fatal(e)
	}
}
func TestScheduleCoalescesAndFencesWorkers(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	c := backup.Default()
	c.Enabled = true
	if e := s.SaveBackup(ctx, c, []byte("fixture")); e != nil {
		t.Fatal(e)
	}
	if _, e := s.db.Exec("UPDATE backup_settings SET next_at=now()-interval '4 days'"); e != nil {
		t.Fatal(e)
	}
	for range 2 {
		if e := s.ScheduleBackup(ctx); e != nil {
			t.Fatal(e)
		}
	}
	if _, e := s.QueueBackup(ctx, "manual"); !errors.Is(e, ErrBackupBusy) {
		t.Fatal(e)
	}
	if e := s.WorkBackup(ctx, func(j BackupJob) error {
		if j.Trigger != "scheduled" || j.Attempt != 1 {
			t.Fatal("wrong claim")
		}
		if e := s.WorkBackup(ctx, func(BackupJob) error { t.Fatal("double claim"); return nil }); e != nil {
			return e
		}
		c.Enabled = false
		if e := s.SaveBackup(ctx, c, []byte("fixture")); e != nil {
			return e
		}
		_, err := j.Finish(ctx, "retry", time.Minute, nil)
		return err
	}); e != nil {
		t.Fatal(e)
	}
	h, e := s.History(ctx)
	if e != nil || len(h) != 1 || h[0].Status != "cancelled" {
		t.Fatal(h, e)
	}
}

func TestLibraryRestoreRejectsCollectionCycle(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	target := testStore(t)
	if _, e := s.db.Exec("INSERT INTO collections(id,name,parent_id) VALUES(1,'one',2),(2,'two',1)"); e != nil {
		t.Fatal(e)
	}
	var b bytes.Buffer
	w := zip.NewWriter(&b)
	if e := s.LibraryBackup(ctx, w, backup.Config{}); e != nil {
		t.Fatal(e)
	}
	if e := w.Close(); e != nil {
		t.Fatal(e)
	}
	z, e := OpenLibraryZip(bytes.NewReader(b.Bytes()), int64(b.Len()))
	if e != nil {
		t.Fatal(e)
	}
	m, e := ReadManifest(z)
	if e != nil {
		t.Fatal(e)
	}
	if e = target.RestoreLibrary(ctx, z, m); e == nil {
		t.Fatal("imported cycle")
	}
	var n int
	if e = target.db.QueryRow("SELECT count(*) FROM collections").Scan(&n); e != nil || n != 0 {
		t.Fatal("partial restore", n, e)
	}
}

func TestCancelledBackoffCountsStageTimeOnce(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	if e := s.SaveBackup(ctx, backup.Default(), []byte("fixture")); e != nil {
		t.Fatal(e)
	}
	id, e := s.QueueBackup(ctx, "manual")
	if e != nil {
		t.Fatal(e)
	}
	if e = s.WorkBackup(ctx, func(j BackupJob) error {
		if e := j.Progress(ctx, "upload", 100, 200, map[string]int64{"upload": 17}); e != nil {
			return e
		}
		_, e := j.Finish(ctx, "retry", time.Minute, nil)
		return e
	}); e != nil {
		t.Fatal(e)
	}
	if e = s.CancelBackup(ctx, id); e != nil {
		t.Fatal(e)
	}
	if e = s.WorkBackup(ctx, func(j BackupJob) error { _, e := j.Finish(ctx, "cancelled", 0, nil); return e }); e != nil {
		t.Fatal(e)
	}
	m, e := s.BackupMetrics(ctx)
	if e != nil || m["stage_upload_milliseconds_total"] != 17 {
		t.Fatal(m, e)
	}
}

func TestUpgradeBackupSchemaAndRestart(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "legacy.db")
	url := pgtest.URL(t, path)
	db, e := sql.Open("pgx", url)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = db.Exec(initialSchema + challengeSchema + ";CREATE TABLE pocketmark_migrations(version integer PRIMARY KEY);INSERT INTO pocketmark_migrations VALUES(1),(2);INSERT INTO collections(name) VALUES('kept')"); e != nil {
		t.Fatal(e)
	}
	db.Close()
	s, e := openTestStore(t, path)
	if e != nil {
		t.Fatal(e)
	}
	cfg, _, next, e := s.BackupConfig(ctx)
	if e != nil || cfg.Enabled || next != nil {
		t.Fatal("invalid new schedule", e)
	}
	if cols, e := s.Collections(ctx); e != nil || len(cols) != 1 || cols[0].Name != "kept" {
		t.Fatal("missing legacy collection", e)
	}
	cfg.Enabled = true
	if e = s.SaveBackup(ctx, cfg, []byte("fixture")); e != nil {
		t.Fatal(e)
	}
	id, e := s.QueueBackup(ctx, "manual")
	if e != nil {
		t.Fatal(e)
	}
	s.Close()
	s, e = openTestStore(t, path)
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	history, e := s.History(ctx)
	if e != nil || len(history) != 1 || history[0].ID != id {
		t.Fatal("lost queued backup", e)
	}
}
