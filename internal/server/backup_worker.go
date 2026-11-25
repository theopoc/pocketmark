package server

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path"
	"sync"
	"time"

	"pocketmark/internal/backup"
	"pocketmark/internal/observability"
	"pocketmark/internal/store"
)

func (a *Server) BackupWorker(ctx context.Context) {
	since := time.Now()
	var workers sync.WaitGroup
	loop := func(work func() error, event string) {
		defer workers.Done()
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for ctx.Err() == nil {
			if err := work(); err != nil && ctx.Err() == nil {
				observability.Error(ctx, event, err)
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}
	workers.Add(3)
	go loop(func() error { return a.Store.ScheduleBackup(ctx, since) }, "backup_schedule_failed")
	go loop(func() error { return a.dispatchBackupNotification(ctx) }, "backup_notification_worker_failed")
	go loop(func() error {
		return a.Store.WorkBackup(ctx, func(j store.BackupJob) error { return a.runBackup(ctx, j) })
	}, "backup_worker_failed")
	workers.Wait()
}

type runProgress struct {
	job          store.BackupJob
	stage        string
	operation    string
	start        time.Time
	timings      map[string]int64
	bytes, total int64
	last         time.Time
	ctx          context.Context
}

func (p *runProgress) stageAt(stage, operation string) error {
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
func (p *runProgress) persist() error {
	return p.job.Progress(p.ctx, p.stage, p.bytes, p.total, p.timings)
}
func (p *runProgress) Write(b []byte) (int, error) {
	p.bytes += int64(len(b))
	if time.Since(p.last) > time.Second {
		p.last = time.Now()
		if e := p.persist(); e != nil {
			return 0, e
		}
	}
	return len(b), nil
}
func (a *Server) runBackup(parent context.Context, j store.BackupJob) error {
	if j.Deadline == nil {
		return errors.New("active backup missing deadline")
	}
	ctx, cancel := context.WithDeadline(parent, *j.Deadline)
	defer cancel()
	p := runProgress{job: j, ctx: ctx, start: time.Now(), stage: j.Stage, timings: map[string]int64{}, total: j.Total}
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
				c, e := j.Cancelled(ctx)
				if e != nil || c {
					cancel()
					return
				}
			}
		}
	}()
	stopped, e := j.Cancelled(ctx)
	if e == nil && !stopped {
		e = a.uploadBackup(ctx, j, &p)
	}
	cancel()
	<-done
	if parent.Err() != nil {
		return parent.Err()
	}
	finish, release := context.WithTimeout(parent, 10*time.Second)
	defer release()
	stopped, x := j.Cancelled(finish)
	if x != nil {
		return x
	}
	status := "succeeded"
	diag := map[string]any{}
	var retry time.Duration
	if e != nil || stopped {
		code, httpStatus, temporary := "cancelled", 0, false
		if e != nil {
			code, httpStatus, temporary = backup.Diagnosis(e)
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
		case temporary && j.Attempt <= 3:
			status = "retry"
			retry = []time.Duration{time.Minute, 5 * time.Minute, 15 * time.Minute}[j.Attempt-1]
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
	status, err := j.Finish(finish, status, retry, diag)
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

func (a *Server) uploadBackup(ctx context.Context, j store.BackupJob, p *runProgress) error {

	k, e := backup.Open(a.token, j.Secret, j.Config.Binding())
	if e != nil {
		return e
	}
	remote, e := backup.NewRemote(j.Config, k)
	if e != nil {
		return e
	}
	defer remote.Close()
	verified, storedSize, e := j.Verified(ctx)
	if e != nil {
		return e
	}
	if verified {
		p.total = storedSize
		p.bytes = storedSize
		return pruneBackup(ctx, j, p, remote)
	}
	if e = p.stageAt("prepare", "snapshot"); e != nil {
		return e
	}
	f, e := a.Store.AnonymousFile(".backup-*.age")
	if e != nil {
		return e
	}

	defer f.Close()
	var dump *os.File
	if j.Config.Mode == "full" {
		dump, e = a.Store.BackupSnapshot(ctx)
		if e != nil {
			return e
		}

		defer dump.Close()
	}
	if e = p.stageAt("encrypt", "age_encrypt"); e != nil {
		return e
	}
	hash := sha256.New()
	enc, e := backup.EncryptArchive(cancellableWriter{ctx, io.MultiWriter(f, hash)}, a.token)
	if e != nil {
		return e
	}
	var archive io.Writer = enc
	if j.Config.Mode == "library" {
		archive = backup.LibraryZIPWriter(enc)
	}
	z := zip.NewWriter(archive)
	if dump != nil {
		var entry io.Writer
		entry, e = z.CreateHeader(&zip.FileHeader{Name: "pocketmark.sql", Method: zip.Store})
		if e == nil {
			_, e = io.Copy(entry, dump)
		}
		if e == nil {
			entry, e = z.Create("RESTORE.txt")
		}
		if e == nil {
			_, e = io.WriteString(entry, "Stop all Pocketmark replicas. Restore pocketmark.sql into an empty database with psql -X --single-transaction -v ON_ERROR_STOP=1. Restore your original server-secret separately, sign in and regenerate recovery codes. Reconfigure scheduled backups.\n")
		}
	} else {
		e = a.Store.LibraryBackup(ctx, z, j.Config)
	}
	if e != nil {
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
	if e = j.Pending(ctx, key); e != nil {
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
		return backup.ErrChecksum
	}
	if e = j.RecordObject(ctx, key, version); e != nil {
		return e
	}
	return pruneBackup(ctx, j, p, remote)
}
func pruneBackup(ctx context.Context, j store.BackupJob, p *runProgress, remote *backup.Remote) error {
	if e := p.stageAt("retention", "DeleteObject"); e != nil {
		return e
	}
	for {
		old, object, version, e := j.ExpiredObject(ctx)
		if errors.Is(e, sql.ErrNoRows) {
			return nil
		}
		if e != nil {
			return e
		}
		// An interrupted PUT may have committed remotely before its version
		// could be recorded. Each attempt has its own never-reused key.
		if old == "" {
			current, found, err := remote.Version(ctx, object)
			if err != nil {
				return err
			}
			if !found {
				if err = j.ForgetObject(ctx, old, object); err != nil {
					return err
				}
				continue
			}
			version = current
		}
		if e = remote.Delete(ctx, object, version); e != nil {
			return e
		}
		if e = j.ForgetObject(ctx, old, object); e != nil {
			return e
		}
		slog.Info("backup_object_expired", "backup_id", j.ID, "expired_backup_id", old)
	}
}
