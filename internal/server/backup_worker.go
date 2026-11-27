package server

import (
	"context"
	"database/sql"
	"errors"
	"sync"
	"time"

	"pocketmark/internal/backup"
	"pocketmark/internal/observability"
	"pocketmark/internal/store"
)

func (a *Server) BackupWorker(ctx context.Context) {
	since := time.Now()
	var workers sync.WaitGroup
	loop := func(worker observability.Worker, work func() error, event string) {
		defer workers.Done()
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		a.observer.Beat(worker)
		for ctx.Err() == nil {
			// A panic is logged by Recover; the loop waits for the next tick.
			err := a.observer.Recover(ctx, worker, work)
			if err != nil && ctx.Err() == nil && !errors.Is(err, observability.ErrWorkerPanic) {
				observability.Error(ctx, event, err)
			} else if err == nil {
				a.observer.Beat(worker)
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}
	workers.Add(3)
	go loop(observability.WorkerBackupSchedule, func() error { return a.Store.ScheduleBackup(ctx, since) }, "backup_schedule_failed")
	// A panicked alert keeps its claim; the next claim records it as unknown
	// after a minute instead of sending it twice.
	go loop(observability.WorkerBackupNotification, func() error { return a.dispatchBackupNotification(ctx) }, "backup_notification_worker_failed")
	go loop(observability.WorkerBackup, func() error {
		return a.Store.WorkBackup(ctx, func(j store.BackupJob) error { return a.backupJob(ctx, j, a.runBackup) })
	}, "backup_worker_failed")
	workers.Wait()
}

// runBackup performs one claimed attempt; the claimed job is its backup journal.
func (a *Server) runBackup(ctx context.Context, j store.BackupJob) error {
	r := backup.Runner{Secret: a.token, Contents: a.Store, TempFile: a.Store.AnonymousFile}
	return r.Run(ctx, j.Job(), j)
}

// backupJob runs one claimed backup under Recover. A run that panicked is
// finished as failed on the job's own connection, which still holds the backup
// lock: left running, it would be claimed and re-run at the next tick.
func (a *Server) backupJob(ctx context.Context, j store.BackupJob, run func(context.Context, store.BackupJob) error) error {
	err := a.observer.Recover(ctx, observability.WorkerBackup, func() error { return run(ctx, j) })
	if !errors.Is(err, observability.ErrWorkerPanic) || ctx.Err() != nil {
		return err
	}
	finish, release := context.WithTimeout(ctx, 10*time.Second)
	defer release()
	// sql.ErrNoRows: the run had already finished before the panic.
	if _, e := j.Finish(finish, "failed", 0, map[string]any{"error_code": "panic"}); e != nil && !errors.Is(e, sql.ErrNoRows) {
		return e
	}
	return err
}
