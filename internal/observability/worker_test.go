package observability

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRecoverLogsWorkerPanicWithoutItsValue(t *testing.T) {
	var logs bytes.Buffer
	o := testObserver(&logs)
	ctx := context.Background()
	if err := o.Recover(ctx, WorkerAITag, func() error { panic("private-panic-value") }); !errors.Is(err, ErrWorkerPanic) {
		t.Fatalf("panic result: %v", err)
	}
	failure := errors.New("ordinary failure")
	if err := o.Recover(ctx, WorkerAITag, func() error { return failure }); err != failure {
		t.Fatalf("ordinary result: %v", err)
	}
	if strings.Contains(logs.String(), "private-panic-value") {
		t.Fatal("panic value leaked")
	}
	entries := records(t, &logs)
	if len(entries) != 1 {
		t.Fatalf("want one record, got %v", entries)
	}
	entry := entries[0]
	if entry["level"] != "ERROR" || entry["event"] != "worker_panic" || entry["worker"] != "ai_tag" || entry["error_code"] != "panic" || !strings.HasPrefix(entry["msg"].(string), "AI tagging worker recovered from a panic") {
		t.Fatalf("worker panic record: %v", entry)
	}
	stack, ok := entry["stack"].([]any)
	if !ok || len(stack) == 0 || len(stack) > 16 || !strings.Contains(fmt.Sprint(stack), "TestRecoverLogsWorkerPanicWithoutItsValue") {
		t.Fatalf("stack: %v", entry["stack"])
	}
	w := httptest.NewRecorder()
	o.Metrics(w, nil)
	for _, want := range []string{`pocketmark_worker_panics_total{worker="ai_tag"} 1`, `pocketmark_worker_panics_total{worker="capture"} 0`} {
		if !strings.Contains(w.Body.String(), want) {
			t.Fatalf("missing %s", want)
		}
	}
}

func TestCaptureFinishLeavesPanicToWorkerPanic(t *testing.T) {
	var logs bytes.Buffer
	o := testObserver(&logs)
	ctx, finish := o.Capture(context.Background(), 7)
	o.Recover(ctx, WorkerCapture, func() error { panic("private-panic-value") })
	finish(fmt.Errorf("saved: %w", ErrWorkerPanic), nil)
	entries := records(t, &logs)
	if len(entries) != 1 || entries[0]["event"] != "worker_panic" || entries[0]["link_id"] != float64(7) || len(fmt.Sprint(entries[0]["capture_id"])) != 32 {
		t.Fatalf("capture panic records: %v", entries)
	}
	w := httptest.NewRecorder()
	o.Metrics(w, nil)
	if !strings.Contains(w.Body.String(), `pocketmark_capture_duration_seconds_count{outcome="failed"} 1`) {
		t.Fatal("panicked capture missing from capture outcomes")
	}
}
