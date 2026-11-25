package backup_test

import (
	"archive/zip"
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/minio/minio-go/v7"
	"pocketmark/internal/backup"
	"pocketmark/internal/pgtest"
	"pocketmark/internal/store"
)

const runSecret = "run-test-server-secret-0123456789abcdef"

// memoryRemote is an in-memory ObjectStore with one version per key.
type memoryRemote struct {
	mu        sync.Mutex
	objects   map[string][]byte
	versions  map[string]string
	next      int
	puts      int
	putErr    error
	deleteErr error
	corrupt   bool
	// afterPut runs once the object is stored, before Put returns. It runs
	// with mu held, so it may change fields but must not call other methods.
	afterPut func()
}

func newMemoryRemote() *memoryRemote {
	return &memoryRemote{objects: map[string][]byte{}, versions: map[string]string{}}
}

func (m *memoryRemote) Put(_ context.Context, key string, r io.Reader, n int64) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.puts++
	if m.putErr != nil {
		return "", m.putErr
	}
	data, err := io.ReadAll(r)
	if err != nil {
		return "", err
	}
	if int64(len(data)) != n {
		return "", fmt.Errorf("short upload %d/%d", len(data), n)
	}
	m.next++
	m.objects[key], m.versions[key] = data, fmt.Sprintf("v%d", m.next)
	if m.afterPut != nil {
		m.afterPut()
		if m.putErr != nil {
			return "", m.putErr
		}
	}
	return m.versions[key], nil
}

func (m *memoryRemote) Open(_ context.Context, key, version string) (io.ReadCloser, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	data, ok := m.objects[key]
	if !ok || version != "" && version != m.versions[key] {
		return nil, minio.ErrorResponse{Code: "NoSuchKey", StatusCode: 404}
	}
	data = bytes.Clone(data)
	if m.corrupt {
		data[len(data)-1] ^= 0xff
	}
	return io.NopCloser(bytes.NewReader(data)), nil
}

func (m *memoryRemote) Version(_ context.Context, key string) (string, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	v, ok := m.versions[key]
	return v, ok, nil
}

func (m *memoryRemote) Delete(_ context.Context, key, version string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.deleteErr != nil {
		return m.deleteErr
	}
	if version != m.versions[key] {
		return fmt.Errorf("delete of %s at stale version %q", key, version)
	}
	delete(m.objects, key)
	delete(m.versions, key)
	return nil
}

func (m *memoryRemote) Close() {}

func (m *memoryRemote) has(key string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.objects[key]
	return ok
}

type runFixture struct {
	t      *testing.T
	store  *store.Store
	db     *sql.DB
	remote *memoryRemote
}

func newRunFixture(t *testing.T, retentionDays int) *runFixture {
	t.Helper()
	path := filepath.Join(t.TempDir(), "library.db")
	url := pgtest.URL(t, path)
	s, err := store.Open(url, pgtest.Directory(path))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	db, err := sql.Open("pgx", url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	c := backup.Default()
	c.Mode, c.RetentionDays = "library", retentionDays
	c.Endpoint, c.Bucket = "https://s3.example", "backups"
	sealed, err := backup.Seal(runSecret, backup.Credentials{AccessKey: "id", SecretKey: "key"}, c.Binding())
	if err != nil {
		t.Fatal(err)
	}
	if err = s.SaveBackup(t.Context(), c, sealed); err != nil {
		t.Fatal(err)
	}
	return &runFixture{t, s, db, newMemoryRemote()}
}

// run queues a manual request unless a run is already waiting, claims it and
// performs one attempt. adjust may change the claimed job before it runs.
func (f *runFixture) run(queue bool, adjust func(*backup.Job)) store.BackupRun {
	f.t.Helper()
	ctx := f.t.Context()
	if queue {
		if _, err := f.store.QueueBackup(ctx, "manual"); err != nil {
			f.t.Fatal(err)
		}
	}
	r := backup.Runner{Secret: runSecret, Contents: f.store, TempFile: f.store.AnonymousFile,
		OpenRemote: func(c backup.Config, k backup.Credentials) (backup.ObjectStore, error) {
			if k.AccessKey != "id" || k.SecretKey != "key" {
				return nil, errors.New("credentials were not unsealed")
			}
			return f.remote, nil
		}}
	claimed := false
	if err := f.store.WorkBackup(ctx, func(j store.BackupJob) error {
		claimed = true
		job := j.Job()
		if adjust != nil {
			adjust(&job)
		}
		return r.Run(ctx, job, j)
	}); err != nil || !claimed {
		f.t.Fatal("no attempt ran", err)
	}
	h, err := f.store.History(ctx)
	if err != nil || len(h) == 0 {
		f.t.Fatal("missing run", err)
	}
	return h[0]
}

func (f *runFixture) exec(query string, args ...any) {
	f.t.Helper()
	if _, err := f.db.Exec(query, args...); err != nil {
		f.t.Fatal(err)
	}
}

func (f *runFixture) count(table string) (n int) {
	f.t.Helper()
	if err := f.db.QueryRow("SELECT count(*) FROM " + table).Scan(&n); err != nil {
		f.t.Fatal(err)
	}
	return n
}

func TestRunStoresVerifiedEncryptedCopy(t *testing.T) {
	f := newRunFixture(t, 7)
	run := f.run(true, nil)
	if run.Status != "succeeded" || run.VerifiedAt == nil || run.Stage != "retention" || run.ObjectKey == "" {
		t.Fatalf("status=%s stage=%s diagnostic=%v", run.Status, run.Stage, run.Diagnostic)
	}
	r, err := f.remote.Open(t.Context(), run.ObjectKey, "")
	if err != nil {
		t.Fatal(err)
	}
	plain, err := backup.DecryptArchive(r, runSecret)
	if err != nil {
		t.Fatal(err)
	}
	b, err := io.ReadAll(plain)
	if err != nil {
		t.Fatal(err)
	}
	z, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.ReadManifest(z); err != nil {
		t.Fatal("library backup lacks its manifest", err)
	}
	if f.count("backup_pending") != 0 || f.count("backup_objects") != 1 {
		t.Fatal("journal did not record exactly the verified copy")
	}
}

func TestRunRejectsCopyThatDoesNotReadBack(t *testing.T) {
	f := newRunFixture(t, 7)
	f.remote.corrupt = true
	failed := f.run(true, nil)
	if failed.Status != "failed" || failed.Stage != "verify" || failed.VerifiedAt != nil || failed.Diagnostic["error_code"] != "checksum_mismatch" {
		t.Fatalf("status=%s stage=%s diagnostic=%v", failed.Status, failed.Stage, failed.Diagnostic)
	}
	if f.count("backup_objects") != 0 || f.count("backup_pending") != 1 {
		t.Fatal("unverified copy was recorded")
	}
	// The rejected upload stays pending, so the next verified run deletes it.
	f.remote.corrupt = false
	if next := f.run(true, nil); next.Status != "succeeded" {
		t.Fatal(next.Status, next.Diagnostic)
	}
	if f.count("backup_pending") != 0 || len(f.remote.objects) != 1 {
		t.Fatal("rejected upload was not cleaned up", len(f.remote.objects))
	}
}

func TestRunRemovesUploadInterruptedBeforeItWasRecorded(t *testing.T) {
	f := newRunFixture(t, 7)
	// The PUT commits remotely but its response is lost, so the journal only
	// knows the pending key and never records the version.
	var lost string
	f.remote.afterPut = func() {
		for k := range f.remote.objects {
			lost = k
		}
		f.remote.afterPut = nil
		f.remote.putErr = errors.New("connection reset after commit")
	}
	if run := f.run(true, nil); run.Status != "failed" || run.Stage != "upload" {
		t.Fatal(run.Status, run.Stage, run.Diagnostic)
	}
	f.remote.putErr = nil
	if lost == "" || !f.remote.has(lost) || f.count("backup_pending") != 1 {
		t.Fatal("expected an unrecorded remote object")
	}
	if run := f.run(true, nil); run.Status != "succeeded" {
		t.Fatal(run.Status, run.Diagnostic)
	}
	if f.remote.has(lost) || f.count("backup_pending") != 0 {
		t.Fatal("interrupted upload survived retention")
	}
}

func TestRunForgetsPendingUploadThatNeverArrived(t *testing.T) {
	f := newRunFixture(t, 7)
	f.remote.putErr = errors.New("connection refused before upload")
	if run := f.run(true, nil); run.Status != "failed" || run.Stage != "upload" || len(f.remote.objects) != 0 {
		t.Fatal(run.Status, run.Stage, run.Diagnostic)
	}
	if f.count("backup_pending") != 1 {
		t.Fatal("upload was not journaled as pending")
	}
	f.remote.putErr = nil
	if run := f.run(true, nil); run.Status != "succeeded" {
		t.Fatal(run.Status, run.Diagnostic)
	}
	if f.count("backup_pending") != 0 || len(f.remote.objects) != 1 {
		t.Fatal("absent pending upload was not forgotten")
	}
}

func TestRunRetentionRefusalKeepsVerifiedCopy(t *testing.T) {
	f := newRunFixture(t, 1)
	old := f.run(true, nil)
	recent := f.run(true, nil)
	if old.Status != "succeeded" || recent.Status != "succeeded" || f.count("backup_objects") != 2 {
		t.Fatal("a one-day policy pruned a copy made today")
	}
	f.exec("UPDATE backup_objects SET verified=now()-interval '25 hours' WHERE id=$1", old.ID)
	f.remote.deleteErr = minio.ErrorResponse{Code: "AccessDenied", StatusCode: 403}
	failed := f.run(true, nil)
	if failed.Status != "failed" || failed.Stage != "retention" || failed.VerifiedAt == nil || failed.Diagnostic["error_code"] != "AccessDenied" {
		t.Fatalf("status=%s stage=%s diagnostic=%v", failed.Status, failed.Stage, failed.Diagnostic)
	}
	for _, key := range []string{old.ObjectKey, recent.ObjectKey, failed.ObjectKey} {
		if !f.remote.has(key) {
			t.Fatal("refused retention lost a copy", key)
		}
	}
	f.remote.deleteErr = nil
	if after := f.run(true, nil); after.Status != "succeeded" {
		t.Fatal(after.Status, after.Diagnostic)
	}
	if f.remote.has(old.ObjectKey) || !f.remote.has(failed.ObjectKey) {
		t.Fatal("next verified run did not finish the outstanding deletion")
	}
}

func TestRunRetriesTemporaryFailureThenResumesAtRetention(t *testing.T) {
	f := newRunFixture(t, 1)
	old := f.run(true, nil)
	f.exec("UPDATE backup_objects SET verified=now()-interval '25 hours' WHERE id=$1", old.ID)
	f.remote.deleteErr = minio.ErrorResponse{Code: "ServiceUnavailable", StatusCode: 503}
	puts := f.remote.puts
	retry := f.run(true, nil)
	if retry.Status != "retry" || retry.Attempt != 1 || retry.VerifiedAt == nil || retry.Due.Sub(time.Now()) < 50*time.Second {
		t.Fatalf("status=%s attempt=%d due=%v diagnostic=%v", retry.Status, retry.Attempt, retry.Due, retry.Diagnostic)
	}
	f.remote.deleteErr = nil
	f.exec("UPDATE backup_runs SET due=now() WHERE id=$1", retry.ID)
	resumed := f.run(false, nil)
	if resumed.ID != retry.ID || resumed.Status != "succeeded" || resumed.Attempt != 2 {
		t.Fatal(resumed.ID, resumed.Status, resumed.Attempt, resumed.Diagnostic)
	}
	if f.remote.puts != puts+1 || f.remote.has(old.ObjectKey) {
		t.Fatal("resume did not continue at retention", f.remote.puts-puts)
	}
}

func TestRunGivesUpWhenBackupWindowHasEnded(t *testing.T) {
	// No earlier run: the journal's connection is fresh, so its statements are
	// not prepared yet. Preparing one under an ended window must not close it.
	f := newRunFixture(t, 7)
	puts := f.remote.puts
	run := f.run(true, func(j *backup.Job) {
		ended := time.Now().Add(-time.Second)
		j.Deadline = &ended
	})
	if run.Status != "failed" || run.Diagnostic["error_code"] != "deadline_exceeded" || f.remote.puts != puts {
		t.Fatal(run.Status, run.Diagnostic, f.remote.puts-puts)
	}
}

func TestRunFinishesWhenWindowEndsDuringJournalWrite(t *testing.T) {
	f := newRunFixture(t, 7)
	lock, err := f.db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Rollback()
	var blocked atomic.Bool
	run := f.run(true, func(j *backup.Job) {
		// Block the journal's next progress write past the end of the window.
		if _, err := lock.Exec("SELECT FROM backup_runs WHERE id=$1 FOR UPDATE", j.ID); err != nil {
			t.Fatal(err)
		}
		ends := time.Now().Add(300 * time.Millisecond)
		j.Deadline = &ends
		time.AfterFunc(time.Second, func() {
			// Prove the journal write was waiting on the lock past the window.
			var waiting int
			if err := f.db.QueryRow("SELECT count(*) FROM pg_locks WHERE NOT granted").Scan(&waiting); err == nil {
				blocked.Store(waiting > 0)
			}
			_ = lock.Rollback()
		})
	})
	if !blocked.Load() {
		t.Fatal("no journal write was blocked when the window ended")
	}
	if run.Status != "failed" || run.Diagnostic["error_code"] != "deadline_exceeded" || f.remote.puts != 0 {
		t.Fatal(run.Status, run.Diagnostic, f.remote.puts)
	}
}

func TestRunStopsWhenCancelled(t *testing.T) {
	f := newRunFixture(t, 7)
	f.remote.afterPut = func() { t.Fatal("cancelled run uploaded") }
	run := f.run(true, func(j *backup.Job) {
		if err := f.store.CancelBackup(f.t.Context(), j.ID); err != nil {
			t.Fatal(err)
		}
	})
	if run.Status != "cancelled" || f.remote.puts != 0 {
		t.Fatal(run.Status, run.Diagnostic)
	}
}
