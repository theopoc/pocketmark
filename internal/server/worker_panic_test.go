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

func TestAITagWorkerDropsPanickedJobAndContinues(t *testing.T) {
	ctx := t.Context()
	a := newTestServer(t, "", false)
	logs := logPanics(a)
	if err := a.Store.SetAITagModel(ctx, "fixture"); err != nil {
		t.Fatal(err)
	}
	if err := a.Store.SetAITagEnabled(ctx, true); err != nil {
		t.Fatal(err)
	}
	poison, err := a.Store.Create(ctx, store.Link{URL: "https://example.org/poison", Title: "Poison article"})
	if err != nil {
		t.Fatal(err)
	}
	next, err := a.Store.Create(ctx, store.Link{URL: "https://example.org/next", Title: "Next article"})
	if err != nil {
		t.Fatal(err)
	}
	provider := &testTagProvider{}
	provider.selection = func([]string) ([]string, error) {
		if provider.articles[len(provider.articles)-1].Title == "Poison article" {
			panic("private-panic-value")
		}
		return []string{"machine learning"}, nil
	}
	a.aiTagging.provider = provider
	if err := a.nextAITag(ctx, false); !errors.Is(err, observability.ErrWorkerPanic) {
		t.Fatalf("panicked job: %v", err)
	}
	if err := a.nextAITag(ctx, false); err != nil {
		t.Fatalf("next job: %v", err)
	}
	// The dropped job is not handed back: the queue is empty.
	if err := a.nextAITag(ctx, false); err == nil {
		t.Fatal("panicked job was queued again")
	}
	requireOnePanic(t, logs, "ai_tag")
	if link, err := a.Store.Get(ctx, poison); err != nil || len(link.Tags) != 0 {
		t.Fatalf("panicked link: %v %v", link.Tags, err)
	}
	if link, err := a.Store.Get(ctx, next); err != nil || len(link.Tags) != 1 {
		t.Fatalf("next link: %v %v", link.Tags, err)
	}
	if state, err := a.Store.AITagStatus(ctx); err != nil || state.Remaining != 0 || state.Blocked != "" {
		t.Fatalf("queue: %+v %v", state, err)
	}
}

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
