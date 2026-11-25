package server

import (
	"context"
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

// runBackup performs one claimed attempt; the claimed job is its backup journal.
func (a *Server) runBackup(ctx context.Context, j store.BackupJob) error {
	r := backup.Runner{Secret: a.token, Contents: a.Store, TempFile: a.Store.AnonymousFile}
	return r.Run(ctx, j.Job(), j)
}
