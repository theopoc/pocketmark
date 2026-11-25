package server

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"

	"pocketmark/internal/observability"
	"pocketmark/internal/store"
)

type panicLog struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (w *panicLog) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.Write(p)
}

func (w *panicLog) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.String()
}

func logPanics(a *testServer) *panicLog {
	logs := &panicLog{}
	a.observer = observability.New(slog.New(slog.NewJSONHandler(logs, nil)), nil)
	return logs
}

func requireOnePanic(t *testing.T, logs *panicLog, worker string) {
	t.Helper()
	output := logs.String()
	if strings.Contains(output, "private-panic-value") {
		t.Fatalf("panic value leaked: %s", output)
	}
	if n := strings.Count(output, `"event":"worker_panic"`); n != 1 || !strings.Contains(output, `"worker":"`+worker+`"`) {
		t.Fatalf("want one %s worker_panic record, got %d: %s", worker, n, output)
	}
}

// The AI tagging worker panic test lives with the module in internal/aitagging.

func TestBackupWorkerFailsPanickedRunAndContinues(t *testing.T) {
	ctx := t.Context()
	a := newTestServer(t, "", false)
	logs := logPanics(a)
	c, credentials, _ := testS3(t)
	panicking := func(context.Context, store.BackupJob) error { panic("private-panic-value") }
	work := func(run func(context.Context, store.BackupJob) error) {
		t.Helper()
		if err := a.Store.WorkBackup(ctx, func(j store.BackupJob) error { return a.backupJob(ctx, j, run) }); err != nil && !errors.Is(err, observability.ErrWorkerPanic) {
			t.Fatal(err)
		}
	}
	configureBackup(t, a, c, credentials)
	requireStatus(t, request(a, "POST", "/api/backups/run", "", true, nil), 202)
	work(panicking)
	rows, err := a.Store.History(ctx)
	if err != nil || len(rows) != 1 || rows[0].Status != "failed" || rows[0].Diagnostic["error_code"] != "panic" {
		t.Fatalf("panicked run: %+v %v", rows, err)
	}
	// The failed run is finished, so the next tick does not claim it again.
	work(panicking)
	requireOnePanic(t, logs, "backup")
	requireStatus(t, request(a, "POST", "/api/backups/run", "", true, nil), 202)
	work(a.runBackup)
	rows, err = a.Store.History(ctx)
	if err != nil || len(rows) != 2 || rows[0].Status != "succeeded" {
		t.Fatalf("next run: %+v %v", rows, err)
	}
}
