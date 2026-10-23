package main

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pocketmark/internal/observability"
	"pocketmark/internal/store"
)

// The production worker must report an ordinary fetch failure even when saving
// that failure to SQLite succeeds. The loopback URL is rejected without network.
func TestWorkerReportsPersistedCaptureFailure(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "worker.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	id, err := s.Create(context.Background(), store.Link{URL: "http://127.0.0.1/private-bookmark?secret=private-query"})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	log := &captureLog{finished: make(chan []byte, 1)}
	o := observability.New(slog.New(slog.NewJSONHandler(log, nil)), nil)
	done := make(chan struct{})
	go func() { defer close(done); worker(ctx, s, o) }()
	select {
	case line := <-log.finished:
		if !bytes.Contains(line, []byte(`"outcome":"failed"`)) || bytes.Contains(line, []byte("private-")) {
			t.Errorf("unsafe/missing capture event: %s", line)
		}
	case <-time.After(3 * time.Second):
		t.Error("worker did not log capture failure")
	}
	cancel()
	<-done
	link, err := s.Get(context.Background(), id)
	if err != nil || link.Status != "failed" {
		t.Fatalf("capture state: %v %v", link, err)
	}
	w := httptest.NewRecorder()
	o.Metrics(w, nil)
	if !strings.Contains(w.Body.String(), `pocketmark_capture_duration_seconds_count{outcome="failed"} 1`) {
		t.Fatal("missing worker failure metric")
	}
}

type captureLog struct{ finished chan []byte }

func (w *captureLog) Write(p []byte) (int, error) {
	if bytes.Contains(p, []byte(`"msg":"capture_finished"`)) {
		select {
		case w.finished <- bytes.Clone(p):
		default:
		}
	}
	return len(p), nil
}

var _ io.Writer = (*captureLog)(nil)
