package observability

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"syscall"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"pocketmark/internal/capture"
	"pocketmark/internal/fault"
)

func TestErrorDiagnosticsPreserveSafeCauses(t *testing.T) {
	for _, tc := range []struct {
		name       string
		err        error
		kind, code string
		status     int
	}{
		{"policy", fault.New("capture", "destination_blocked", "private-policy"), "capture", "destination_blocked", 400},
		{"upstream", &capture.HTTPStatusError{StatusCode: 503}, "http", "upstream_status", 502},
		{"dns", &net.DNSError{Name: "private-host", Err: "private-text", IsNotFound: true}, "dns", "dns_not_found", 502},
		{"disk", &os.PathError{Op: "write", Path: "private-path", Err: syscall.ENOSPC}, "io", "system_error", 500},
		{"database", &pgconn.PgError{Code: "55P03"}, "database", "postgresql", 503},
		{"validation", fault.Invalid("private-validation"), "validation", "invalid_input", 400},
		{"unknown", errors.New("private-unexpected"), "internal", "unexpected", 500},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := fault.Wrap("capture.http", &url.Error{Op: "Get", URL: "https://private-host/?secret=private-token", Err: fmt.Errorf("private-wrapper: %w", tc.err)})
			attrs := attributeMap(ErrorAttrs(err))
			if attrs["error_kind"] != tc.kind || attrs["error_code"] != tc.code || attrs["operation"] != "capture.http" || HTTPStatus(err) != tc.status {
				t.Fatalf("diagnostic: %v, status %d", attrs, HTTPStatus(err))
			}
			if strings.Contains(fmt.Sprint(attrs), "private-") {
				t.Fatal("private data leaked")
			}
		})
	}
}

func TestPanicRetainsOnlyCodeLocations(t *testing.T) {
	var logs bytes.Buffer
	o := testObserver(&logs)
	o.HTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/", nil), "/", func(http.ResponseWriter, *http.Request) { panic("private-panic") })
	if strings.Contains(logs.String(), "private-panic") {
		t.Fatal("panic value leaked")
	}
	entries := records(t, &logs)
	stack, ok := entries[0]["stack"].([]any)
	if !ok || len(stack) == 0 || len(stack) > 16 {
		t.Fatalf("missing bounded stack: %v", entries)
	}
	if !strings.Contains(fmt.Sprint(stack), "TestPanicRetainsOnlyCodeLocations") {
		t.Fatal("panic origin missing")
	}
}

func TestCaptureRetainsFetchAndSaveFailures(t *testing.T) {
	var logs bytes.Buffer
	ctx, cancel := context.WithCancel(context.Background())
	_, finish := testObserver(&logs).Capture(ctx, 42)
	cancel()
	finish(context.DeadlineExceeded, &os.PathError{Op: "write", Path: "private-path", Err: syscall.ENOSPC})
	entry := records(t, &logs)[0]
	if entry["level"] != "ERROR" || entry["capture_id"] == "" || entry["canceled"] != true {
		t.Fatalf("capture: %v", entry)
	}
	if entry["fetch_error"].(map[string]any)["error_code"] != "deadline_exceeded" || entry["save_error"].(map[string]any)["errno"] != float64(syscall.ENOSPC) {
		t.Fatalf("causes lost: %v", entry)
	}
	if strings.Contains(fmt.Sprint(entry), "private-path") {
		t.Fatal("path leaked")
	}
}

func TestStreamFailureMarksLogMetricAndSpan(t *testing.T) {
	var logs bytes.Buffer
	exporter := tracetest.NewInMemoryExporter()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	defer provider.Shutdown(context.Background())
	o := testObserver(&logs)
	o.tracer = provider.Tracer("test")
	o.HTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/export", nil), "/export", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("partial"))
		Error(r.Context(), "export_failed", errors.New("private-error"))
	})
	entries := records(t, &logs)
	if entries[1]["status"] != float64(200) || entries[1]["outcome"] != "failed" || entries[1]["level"] != "ERROR" {
		t.Fatalf("stream outcome: %v", entries)
	}
	if o.measurements.httpErrors.Load() != 1 || exporter.GetSpans()[0].Status.Code != codes.Error {
		t.Fatal("failure absent from metric/span")
	}
}

type brokenResponse struct{ header http.Header }

func (w *brokenResponse) Header() http.Header     { return w.header }
func (*brokenResponse) WriteHeader(int)           {}
func (*brokenResponse) Write([]byte) (int, error) { return 0, syscall.EPIPE }

func TestIgnoredResponseWriteFailureIsRecordedOnce(t *testing.T) {
	for _, handled := range []bool{false, true} {
		t.Run(fmt.Sprint(handled), func(t *testing.T) {
			var logs bytes.Buffer
			o := testObserver(&logs)
			o.HTTP(&brokenResponse{header: make(http.Header)}, httptest.NewRequest("GET", "/dav/bookmarks.xbel", nil), "/dav/", func(w http.ResponseWriter, r *http.Request) {
				_, err := w.Write([]byte("payload"))
				if handled {
					Error(r.Context(), "export_failed", fmt.Errorf("private-wrapper: %w", err))
				}
				w.Write([]byte("another chunk"))
			})
			entries := records(t, &logs)
			if len(entries) != 2 || entries[0]["msg"] != "response_write_failed" || entries[1]["outcome"] != "failed" || o.measurements.httpErrors.Load() != 1 {
				t.Fatalf("write failure missing/duplicated: %v", entries)
			}
		})
	}
}
