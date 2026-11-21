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
func TestLibraryBackupRestoresBothArticleCopies(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	id := createLink(t, s, Link{URL: "https://example.test/illustrated"})
	if _, err := s.db.Exec("UPDATE links SET archive=$1, reader_archive=$2 WHERE id=$3", []byte("original"), []byte("illustrated"), id); err != nil {
		t.Fatal(err)
	}
	var data bytes.Buffer
	writer := zip.NewWriter(&data)
	if err := s.LibraryBackup(ctx, writer, backup.Config{Archives: true}); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	z, err := OpenLibraryZip(bytes.NewReader(data.Bytes()), int64(data.Len()))
	if err != nil {
		t.Fatal(err)
	}
	m, err := ReadManifest(z)
	if err != nil || m.Version != 2 {
		t.Fatalf("illustrated backup: %+v %v", m, err)
	}
	target := testStore(t)
	if err = target.RestoreLibrary(ctx, z, m); err != nil {
		t.Fatal(err)
	}
	if b, err := target.Archive(ctx, id); err != nil || string(b) != "original" {
		t.Fatalf("restored original: %q %v", b, err)
	}
	if b, err := target.ArticleArchive(ctx, id); err != nil || string(b) != "illustrated" {
		t.Fatalf("restored illustrated copy: %q %v", b, err)
	}
}

func TestScheduleCoalescesAndFencesWorkers(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	c := backup.Default()
	c.Enabled = true
	c.Zone = "UTC"
	if err := s.SaveBackup(ctx, c, []byte("fixture")); err != nil {
		t.Fatal(err)
	}
	since := time.Now().Add(-time.Second)
	// A restart does not turn stale next_at into a run.
	if _, err := s.db.Exec("UPDATE backup_settings SET next_at=now()-interval '4 days'"); err != nil {
		t.Fatal(err)
	}
	if err := s.ScheduleBackup(ctx, time.Now()); err != nil {
		t.Fatal(err)
	}
	if rows, err := s.History(ctx); err != nil || len(rows) != 0 {
		t.Fatal("backfilled a missed schedule", rows, err)
	}
	due := time.Now().UTC().Truncate(time.Microsecond)
	if _, err := s.db.Exec("UPDATE backup_settings SET next_at=$1", due); err != nil {
		t.Fatal(err)
	}
	// A new replica wakes after the due time and polls before the live replica.
	if err := s.ScheduleBackup(ctx, time.Now()); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := s.ScheduleBackup(ctx, since); err != nil {
			t.Fatal(err)
		}
	}
	var scheduledID, manualID string
	if err := s.WorkBackup(ctx, func(j BackupJob) error {
		scheduledID = j.ID
		if j.Trigger != "scheduled" || j.Deadline == nil || !j.Deadline.Equal(due.Add(2*time.Hour)) {
			t.Fatal("scheduled window", j)
		}
		if err := s.WorkBackup(ctx, func(BackupJob) error { t.Fatal("double claim"); return nil }); err != nil {
			return err
		}
		var err error
		manualID, err = s.QueueBackup(ctx, "manual")
		if err != nil {
			return err
		}
		_, err = j.Finish(ctx, "retry", time.Hour, nil)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if scheduledID == "" || manualID == "" {
		t.Fatal("missing work")
	}
	results := make(chan error, 8)
	for range cap(results) {
		go func() {
			id, err := s.QueueBackup(ctx, "manual")
			if err == nil && id != manualID {
				err = errors.New("assigned multiple IDs to the same pending request")
			}
			results <- err
		}()
	}
	for range cap(results) {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	var err error
	if err = s.WorkBackup(ctx, func(BackupJob) error { t.Fatal("ran another job during backoff"); return nil }); err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.Exec("UPDATE backup_settings SET next_at=now()"); err != nil {
		t.Fatal(err)
	}
	if err = s.ScheduleBackup(ctx, since); err != nil {
		t.Fatal(err)
	}
	rows, err := s.History(ctx)
	if err != nil || len(rows) != 3 {
		t.Fatal(rows, err)
	}
	for _, r := range rows {
		switch r.ID {
		case manualID:
			if r.Status != "queued" || !r.Started.IsZero() || r.Requested.IsZero() || r.Deadline != nil {
				t.Fatal("manual queue state", r)
			}
		case scheduledID:
			if r.Status != "retry" || r.Started.IsZero() {
				t.Fatal("retry state", r)
			}
		default:
			if r.Status != "skipped" || r.Diagnostic["error_code"] != "overlap" {
				t.Fatal("missing skip reason", r)
			}
		}
	}
	if _, err = s.db.Exec("UPDATE backup_runs SET deadline=now()-interval '1 second' WHERE id=$1", scheduledID); err != nil {
		t.Fatal(err)
	}
	if err = s.WorkBackup(ctx, func(j BackupJob) error {
		if j.ID != scheduledID {
			t.Fatal("lost active slot")
		}
		status, err := j.Finish(ctx, "retry", time.Minute, nil)
		if status != "failed" {
			t.Fatal("deadline did not release slot", status, err)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err = s.WorkBackup(ctx, func(j BackupJob) error {
		if j.ID != manualID || !j.Deadline.Equal(j.Started.Add(2*time.Hour)) {
			t.Fatal("manual window", j)
		}
		if err := j.RecordObject(ctx, "verified", ""); err != nil {
			return err
		}
		_, err := j.Finish(ctx, "succeeded", 0, nil)
		return err
	}); err != nil {
		t.Fatal(err)
	}
}

func TestBackupDraftAndQueuedSnapshot(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	draft := backup.Default()
	effective := draft
	effective.Endpoint = "https://env.example"
	if err := s.SaveBackupSettings(ctx, draft, nil, effective, []byte("sealed-effective"), ""); err != nil {
		t.Fatal(err)
	}
	got, secret, _, rev, err := s.BackupDraft(ctx)
	if err != nil || got.Endpoint != "" || len(secret) != 0 || rev == "" {
		t.Fatal("effective values leaked into draft", err)
	}
	if _, err = s.QueueBackup(ctx, "manual", rev); err != nil {
		t.Fatal(err)
	}
	effective.Endpoint = "https://changed.example"
	if err = s.SaveBackupSettings(ctx, draft, nil, effective, []byte("changed"), rev); err != nil {
		t.Fatal(err)
	}
	if err = s.SaveBackupSettings(ctx, draft, nil, effective, nil, rev); !errors.Is(err, ErrBackupChanged) {
		t.Fatal("stale update", err)
	}
	if _, err = s.QueueBackup(ctx, "manual", rev); !errors.Is(err, ErrBackupChanged) {
		t.Fatal("stale manual request", err)
	}
	if err = s.WorkBackup(ctx, func(j BackupJob) error {
		if j.Config.Endpoint != "https://env.example" || string(j.Secret) != "sealed-effective" {
			t.Fatal("accepted snapshot changed")
		}
		if err := j.RecordObject(ctx, "verified", ""); err != nil {
			return err
		}
		_, err := j.Finish(ctx, "succeeded", 0, nil)
		return err
	}); err != nil {
		t.Fatal(err)
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
	cfg.Zone = "UTC"
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
	if e != nil || len(history) != 1 || history[0].ID != id || !history[0].Started.IsZero() || history[0].Deadline != nil {
		t.Fatal("lost queued backup", e)
	}
	if e = s.WorkBackup(ctx, func(j BackupJob) error {
		if j.ID != id || j.Trigger != "manual" || !j.Deadline.Equal(j.Started.Add(2*time.Hour)) {
			t.Fatal("wrong restart promotion", j)
		}
		if err := j.RecordObject(ctx, "restored-queue", ""); err != nil {
			return err
		}
		_, err := j.Finish(ctx, "succeeded", 0, nil)
		return err
	}); e != nil {
		t.Fatal(e)
	}
}

func TestBackupRetentionFailureKeepsVerifiedCopyAndAlert(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	c := backup.Default()
	c.TelegramChatID = "12345"
	if err := s.SaveBackup(ctx, c, []byte("sealed-token")); err != nil {
		t.Fatal(err)
	}
	id, err := s.QueueBackup(ctx, "manual")
	if err != nil {
		t.Fatal(err)
	}
	if err = s.WorkBackup(ctx, func(j BackupJob) error {
		_, err := j.conn.ExecContext(ctx, `INSERT INTO backup_objects(id,instance,destination,mode,object_key,verified) VALUES
		  (gen_random_uuid(),$1,$2,$3,'expired',now()-interval '169 hours'),
		  (gen_random_uuid(),$1,$2,$3,'recent',now()-interval '167 hours'),
		  (gen_random_uuid(),$1,$2,'library','other format',now()-interval '169 hours'),
		  (gen_random_uuid(),$1,'other destination',$3,'other destination',now()-interval '169 hours'),
		  (gen_random_uuid(),gen_random_uuid(),$2,$3,'other instance',now()-interval '169 hours')`, j.Instance, j.Config.Binding(), j.Config.Mode)
		if err != nil {
			return err
		}
		if err = j.Progress(ctx, "verify", 456, 456, map[string]int64{}); err != nil {
			return err
		}
		if err = j.Pending(ctx, "new"); err != nil {
			return err
		}
		return j.RecordObject(ctx, "new", "") // Simulated worker exit immediately after commit.
	}); err != nil {
		t.Fatal(err)
	}
	if err = s.WorkBackup(ctx, func(j BackupJob) error {
		ok, size, err := j.Verified(ctx)
		if err != nil || !ok || size != 456 || j.Stage != "retention" || j.Attempt != 2 {
			t.Fatal("lost verification", size, err)
		}
		expires, key, _, err := j.ExpiredObject(ctx)
		if err != nil || expires == "" || key != "expired" {
			t.Fatal("retention candidate", key, err)
		}
		_, err = j.Finish(ctx, "failed", 0, map[string]any{"error_code": "AccessDenied", "stage": "retention"})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	h, err := s.History(ctx)
	if err != nil || len(h) != 1 || h[0].Status != "failed" || h[0].VerifiedAt == nil || h[0].Removed || h[0].Notification != "pending" {
		t.Fatal("history", h, err)
	}
	m, err := s.BackupMetrics(ctx)
	if err != nil || m["failed_total"] != 1 || m["retention_errors_total"] != 1 || m["last_success_timestamp_seconds"] != 0 {
		t.Fatal(m, err)
	}
	var alert, erased bool
	if err = s.db.QueryRow(`SELECT EXISTS(SELECT FROM backup_notifications WHERE id=$1 AND credentials=$2),
	  EXISTS(SELECT FROM backup_runs WHERE id=$1 AND octet_length(credentials)=0)`, id, []byte("sealed-token")).Scan(&alert, &erased); err != nil || !alert || !erased {
		t.Fatal("outbox was not atomic", err)
	}
	next, err := s.QueueBackup(ctx, "manual")
	if err != nil {
		t.Fatal(err)
	}
	if err = s.WorkBackup(ctx, func(j BackupJob) error {
		if j.ID != next {
			t.Fatal("unexpected claim")
		}
		if err := j.RecordObject(ctx, "newer", ""); err != nil {
			return err
		}
		old, key, _, err := j.ExpiredObject(ctx)
		if err != nil || key != "expired" {
			t.Fatal("lost deletion for next verified run", key, err)
		}
		if err = j.ForgetObject(ctx, old, key); err != nil {
			return err
		}
		_, _, _, err = j.ExpiredObject(ctx)
		if !errors.Is(err, sql.ErrNoRows) {
			t.Fatal("retention crossed scope", err)
		}
		_, err = j.Finish(ctx, "succeeded", 0, nil)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	h, err = s.History(ctx)
	if err != nil || len(h) != 2 || h[1].Status != "failed" || h[1].Removed || h[0].Status != "succeeded" {
		t.Fatal(h, err)
	}
}

func TestQueuedCancellationAndHistoryDuringFrequentOverlaps(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	cfg := backup.Default()
	cfg.Zone = "UTC"
	cfg.Enabled = true
	if err := s.SaveBackup(ctx, cfg, nil); err != nil {
		t.Fatal(err)
	}
	active, err := s.QueueBackup(ctx, "manual")
	if err != nil {
		t.Fatal(err)
	}
	if err = s.WorkBackup(ctx, func(j BackupJob) error {
		waiting, err := s.QueueBackup(ctx, "manual")
		if err != nil {
			return err
		}
		if err = s.CancelBackup(ctx, waiting); err != nil {
			return err
		}
		replacement, err := s.QueueBackup(ctx, "manual")
		if err != nil || replacement == waiting {
			t.Fatal("cancelled request kept its place", err)
		}
		for range 25 {
			if _, err = s.db.Exec("UPDATE backup_settings SET next_at=now()"); err != nil {
				return err
			}
			if err = s.ScheduleBackup(ctx, time.Now().Add(-time.Minute)); err != nil {
				return err
			}
		}
		h, err := s.History(ctx)
		if err != nil || len(h) != 20 || h[0].ID != replacement || h[1].ID != active {
			t.Fatal("lost active backup behind skips", h, err)
		}
		_, err = j.Finish(ctx, "failed", 0, nil)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	h, err := s.History(ctx)
	if err != nil || len(h) != 20 || h[1].ID != active || h[1].Status != "failed" || h[1].Notification != "disabled" {
		t.Fatal("newly completed failure missing", h, err)
	}
}
