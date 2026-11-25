package backup

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path"
	"time"

	"pocketmark/internal/observability"
)

// Job is one claimed attempt of a backup run.
type Job struct {
	ID, Trigger, Stage, Instance string
	Attempt                      int
	Deadline, VerifiedAt         *time.Time
	Total                        int64
	Config                       Config
	// Credentials are sealed with the server secret and bound to Config.
	Credentials []byte
}

// Journal is the backup journal of the claimed run. Every write must fail once
// another worker could own the run, so a stale worker cannot publish state.
//
// The run never calls it with a context bounded by the backup window: a
// cancelled query can close the journal's connection, and with it the only
// way to record the run's outcome.
type Journal interface {
	Cancelled(ctx context.Context) (bool, error)
	Progress(ctx context.Context, stage string, bytes, total int64, timings map[string]int64) error
	// Verified reports whether an earlier attempt already verified its copy.
	Verified(ctx context.Context) (verified bool, size int64, err error)
	// Pending records a key before its upload starts, so retention can find
	// an object whose PUT committed remotely before RecordObject ran.
	Pending(ctx context.Context, key string) error
	RecordObject(ctx context.Context, key, version string) error
	// ExpiredObject returns the next object retention must delete. An empty id
	// marks a pending upload whose version was never recorded.
	ExpiredObject(ctx context.Context) (id, key, version string, found bool, err error)
	ForgetObject(ctx context.Context, id, key string) error
	// Finish ends the attempt and returns the status actually stored.
	Finish(ctx context.Context, status string, retry time.Duration, diagnostic map[string]any) (string, error)
}

// Contents writes the restore point for the configured backup mode.
type Contents interface {
	// Write adds the entries to the archive while it is being encrypted.
	Write(ctx context.Context, z *zip.Writer) error
	Close() error
}

// ContentsSource prepares contents during the prepare stage, for instance by
// taking the database snapshot of a full backup.
type ContentsSource interface {
	OpenBackupContents(ctx context.Context, c Config) (Contents, error)
}

// Runner performs backup runs. A run succeeds only after its remote copy is
// verified and retention completes (ADR 0001).
type Runner struct {
	// Secret is the server secret. It unseals the S3 credentials and derives
	// the archive encryption key (ADR 0002).
	Secret   string
	Contents ContentsSource
	// TempFile creates an anonymous file for the encrypted archive.
	TempFile func(pattern string) (*os.File, error)
	// OpenRemote connects to the destination; nil uses the S3 adapter.
	OpenRemote func(Config, Credentials) (ObjectStore, error)
}

var retryDelays = []time.Duration{time.Minute, 5 * time.Minute, 15 * time.Minute}

// journalTimeout bounds each journal call. A call that times out may close
// the journal's connection, which releases the run for another worker.
const journalTimeout = 30 * time.Second

// boundedJournal gives every journal call its own deadline, independent of
// the backup window, so a stalled query cannot hold the run indefinitely.
type boundedJournal struct{ Journal }

func bound(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, journalTimeout)
}
func (b boundedJournal) Cancelled(ctx context.Context) (bool, error) {
	ctx, cancel := bound(ctx)
	defer cancel()
	return b.Journal.Cancelled(ctx)
}
func (b boundedJournal) Progress(ctx context.Context, stage string, bytes, total int64, timings map[string]int64) error {
	ctx, cancel := bound(ctx)
	defer cancel()
	return b.Journal.Progress(ctx, stage, bytes, total, timings)
}
func (b boundedJournal) Verified(ctx context.Context) (bool, int64, error) {
	ctx, cancel := bound(ctx)
	defer cancel()
	return b.Journal.Verified(ctx)
}
func (b boundedJournal) Pending(ctx context.Context, key string) error {
	ctx, cancel := bound(ctx)
	defer cancel()
	return b.Journal.Pending(ctx, key)
}
func (b boundedJournal) RecordObject(ctx context.Context, key, version string) error {
	ctx, cancel := bound(ctx)
	defer cancel()
	return b.Journal.RecordObject(ctx, key, version)
}
func (b boundedJournal) ExpiredObject(ctx context.Context) (string, string, string, bool, error) {
	ctx, cancel := bound(ctx)
	defer cancel()
	return b.Journal.ExpiredObject(ctx)
}
func (b boundedJournal) ForgetObject(ctx context.Context, id, key string) error {
	ctx, cancel := bound(ctx)
	defer cancel()
	return b.Journal.ForgetObject(ctx, id, key)
}
func (b boundedJournal) Finish(ctx context.Context, status string, retry time.Duration, diagnostic map[string]any) (string, error) {
	ctx, cancel := bound(ctx)
	defer cancel()
	return b.Journal.Finish(ctx, status, retry, diagnostic)
}

// Run executes one attempt of a claimed run and records its outcome in the
// journal: succeeded, cancelled, failed, or retry within the backup window.
// It returns an error only when the outcome itself could not be recorded.
func (r Runner) Run(parent context.Context, j Job, journal Journal) error {
	if j.Deadline == nil {
		return errors.New("active backup missing deadline")
	}
	journal = boundedJournal{journal}
	// ctx bounds the work by the backup window; journal calls use parent.
	ctx, cancel := context.WithDeadline(parent, *j.Deadline)
	defer cancel()
	p := progress{job: j, journal: journal, ctx: parent, start: time.Now(), stage: j.Stage, timings: map[string]int64{}, total: j.Total}
	if p.stage == "" || p.stage == "queued" {
		p.stage, p.operation = "prepare", "snapshot"
	}
	if j.VerifiedAt != nil {
		p.stage, p.operation, p.bytes = "retention", "DeleteObject", j.Total
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		tk := time.NewTicker(2 * time.Second)
		defer tk.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tk.C:
				c, e := journal.Cancelled(parent)
				if e != nil || c {
					cancel()
					return
				}
			}
		}
	}()
	stopped, e := journal.Cancelled(parent)
	if e == nil && !stopped {
		if e = ctx.Err(); e == nil {
			e = r.upload(ctx, parent, j, journal, &p)
		}
	}
	cancel()
	<-done
	if parent.Err() != nil {
		return parent.Err()
	}
	finish, release := context.WithTimeout(parent, 10*time.Second)
	defer release()
	stopped, x := journal.Cancelled(finish)
	if x != nil {
		return x
	}
	status := "succeeded"
	diag := map[string]any{}
	var retry time.Duration
	if e != nil || stopped {
		code, httpStatus, temporary := "cancelled", 0, false
		if e != nil {
			code, httpStatus, temporary = Diagnosis(e)
		}
		diag = map[string]any{"operation": p.operation, "error_code": code, "http_status": httpStatus, "stage": p.stage}
		if e != nil {
			attrs := observability.ErrorAttrs(e)
			for i := 0; i+1 < len(attrs); i += 2 {
				key := attrs[i].(string)
				if key != "error_code" && key != "operation" {
					diag[key] = attrs[i+1]
				}
			}
		}
		switch {
		case stopped:
			status = "cancelled"
		case !time.Now().Before(*j.Deadline):
			status = "failed"
			diag["error_code"] = "deadline_exceeded"
		case temporary && j.Attempt <= len(retryDelays):
			status = "retry"
			retry = retryDelays[j.Attempt-1]
		default:
			status = "failed"
		}
	}
	if p.stage != "" {
		p.timings[p.stage] += time.Since(p.start).Milliseconds()
		p.ctx = finish
		if e := p.persist(); e != nil {
			return e
		}
	}
	status, err := journal.Finish(finish, status, retry, diag)
	if err != nil {
		return err
	}
	if status != "retry" {
		retry = 0
	}
	level := slog.LevelInfo
	if status == "failed" {
		level = slog.LevelError
	} else if status == "retry" {
		level = slog.LevelWarn
	}
	slog.Log(finish, level, "backup_finished", "backup_id", j.ID, "trigger", j.Trigger, "attempt", j.Attempt, "status", status, "stage", p.stage, "diagnostic", diag, "bytes", p.bytes, "retry_seconds", retry.Seconds())
	return nil
}

func (r Runner) openRemote(c Config, k Credentials) (ObjectStore, error) {
	if r.OpenRemote != nil {
		return r.OpenRemote(c, k)
	}
	remote, e := NewRemote(c, k)
	if e != nil {
		return nil, e
	}
	return remote, nil
}

// upload works within ctx, the backup window, and writes the journal under
// jctx, the worker's lifetime.
func (r Runner) upload(ctx, jctx context.Context, j Job, journal Journal, p *progress) error {
	k, e := Open(r.Secret, j.Credentials, j.Config.Binding())
	if e != nil {
		return e
	}
	remote, e := r.openRemote(j.Config, k)
	if e != nil {
		return e
	}
	defer remote.Close()
	verified, storedSize, e := journal.Verified(jctx)
	if e != nil {
		return e
	}
	if verified {
		p.total = storedSize
		p.bytes = storedSize
		return prune(ctx, jctx, j, journal, p, remote)
	}
	if e = p.stageAt("prepare", "snapshot"); e != nil {
		return e
	}
	f, e := r.TempFile(".backup-*.age")
	if e != nil {
		return e
	}
	defer f.Close()
	contents, e := r.Contents.OpenBackupContents(ctx, j.Config)
	if e != nil {
		return e
	}
	defer contents.Close()
	if e = p.stageAt("encrypt", "age_encrypt"); e != nil {
		return e
	}
	hash := sha256.New()
	enc, e := EncryptArchive(cancellableWriter{ctx, io.MultiWriter(f, hash)}, r.Secret)
	if e != nil {
		return e
	}
	var archive io.Writer = enc
	if j.Config.Mode == "library" {
		archive = LibraryZIPWriter(enc)
	}
	z := zip.NewWriter(archive)
	if e = contents.Write(ctx, z); e != nil {
		return e
	}
	if e = z.Close(); e != nil {
		return e
	}
	if e = enc.Close(); e != nil {
		return e
	}
	p.total, e = f.Seek(0, io.SeekEnd)
	if e != nil {
		return e
	}
	if _, e = f.Seek(0, 0); e != nil {
		return e
	}
	if e = p.stageAt("upload", "PutObject"); e != nil {
		return e
	}
	key := path.Join(j.Config.Prefix, j.Instance, fmt.Sprintf("%s-%d.zip.age", j.ID, j.Attempt))
	if e = journal.Pending(jctx, key); e != nil {
		return e
	}
	version, e := remote.Put(ctx, key, io.TeeReader(f, p), p.total)
	if e != nil {
		return e
	}
	if e = p.stageAt("verify", "GetObject"); e != nil {
		return e
	}
	obj, e := remote.Open(ctx, key, version)
	if e != nil {
		return e
	}
	verifier := sha256.New()
	n, e := io.Copy(verifier, io.LimitReader(obj, p.total+1))
	obj.Close()
	if e != nil {
		return e
	}
	if n != p.total || !bytes.Equal(hash.Sum(nil), verifier.Sum(nil)) {
		return ErrChecksum
	}
	if e = journal.RecordObject(jctx, key, version); e != nil {
		return e
	}
	return prune(ctx, jctx, j, journal, p, remote)
}

func prune(ctx, jctx context.Context, j Job, journal Journal, p *progress, remote ObjectStore) error {
	if e := p.stageAt("retention", "DeleteObject"); e != nil {
		return e
	}
	for {
		old, object, version, found, e := journal.ExpiredObject(jctx)
		if e != nil {
			return e
		}
		if !found {
			return nil
		}
		// An interrupted PUT may have committed remotely before its version
		// could be recorded. Each attempt has its own never-reused key.
		if old == "" {
			current, exists, err := remote.Version(ctx, object)
			if err != nil {
				return err
			}
			if !exists {
				if err = journal.ForgetObject(jctx, old, object); err != nil {
					return err
				}
				continue
			}
			version = current
		}
		if e = remote.Delete(ctx, object, version); e != nil {
			return e
		}
		if e = journal.ForgetObject(jctx, old, object); e != nil {
			return e
		}
		slog.Info("backup_object_expired", "backup_id", j.ID, "expired_backup_id", old)
	}
}

type progress struct {
	job          Job
	journal      Journal
	stage        string
	operation    string
	start        time.Time
	timings      map[string]int64
	bytes, total int64
	last         time.Time
	ctx          context.Context
}

func (p *progress) stageAt(stage, operation string) error {
	now := time.Now()
	if p.stage != "" {
		p.timings[p.stage] += now.Sub(p.start).Milliseconds()
	}
	p.start = now
	p.stage = stage
	p.operation = operation
	slog.InfoContext(p.ctx, "backup_stage", "backup_id", p.job.ID, "attempt", p.job.Attempt, "stage", stage, "operation", operation)
	return p.persist()
}
func (p *progress) persist() error {
	return p.journal.Progress(p.ctx, p.stage, p.bytes, p.total, p.timings)
}
func (p *progress) Write(b []byte) (int, error) {
	p.bytes += int64(len(b))
	if time.Since(p.last) > time.Second {
		p.last = time.Now()
		if e := p.persist(); e != nil {
			return 0, e
		}
	}
	return len(b), nil
}

type cancellableWriter struct {
	ctx    context.Context
	writer io.Writer
}

func (w cancellableWriter) Write(p []byte) (int, error) {
	if e := w.ctx.Err(); e != nil {
		return 0, e
	}
	return w.writer.Write(p)
}
