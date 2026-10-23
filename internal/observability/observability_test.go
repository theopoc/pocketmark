package observability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func testObserver(dst io.Writer) *Observer {
	return New(slog.New(slog.NewJSONHandler(dst, &slog.HandlerOptions{Level: slog.LevelDebug})), nil)
}

func records(t *testing.T, b *bytes.Buffer) []map[string]any {
	t.Helper()
	d := json.NewDecoder(b)
	var out []map[string]any
	for d.More() {
		var record map[string]any
		if err := d.Decode(&record); err != nil {
			t.Fatal(err)
		}
		out = append(out, record)
	}
	return out
}

func TestJSONLoggingLevelsAndLegacyBridge(t *testing.T) {
	previous := slog.Default()
	flags, prefix, writer := log.Flags(), log.Prefix(), log.Writer()
	t.Cleanup(func() { slog.SetDefault(previous); log.SetFlags(flags); log.SetPrefix(prefix); log.SetOutput(writer) })
	var out bytes.Buffer
	if err := ConfigureLogging(&out, "WARN"); err != nil {
		t.Fatal(err)
	}
	slog.Info("hidden")
	slog.Warn("visible", "count", 3)
	r := records(t, &out)
	if len(r) != 1 || r[0]["level"] != "WARN" || r[0]["service"] != "pocketmark" || r[0]["count"] != float64(3) {
		t.Fatalf("records: %v", r)
	}
	if err := ConfigureLogging(&out, "DEBUG"); err != nil {
		t.Fatal(err)
	}
	log.Print("legacy message")
	if r := records(t, &out); len(r) != 1 || r[0]["msg"] != "legacy message" {
		t.Fatalf("legacy record: %v", r)
	}
	if err := ConfigureLogging(io.Discard, "not-a-level"); err == nil {
		t.Fatal("invalid level accepted")
	}
}

func TestHTTPPrivacyCorrelationAndStreaming(t *testing.T) {
	var logs bytes.Buffer
	exporter := tracetest.NewInMemoryExporter()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	t.Cleanup(func() { provider.Shutdown(context.Background()) })
	o := testObserver(&logs)
	o.tracer = provider.Tracer("test")
	r := httptest.NewRequest("GET", "/api/links/private-bookmark?token=private-query", nil)
	r.Header.Set("Authorization", "Bearer private-bearer")
	r.Header.Set("Cookie", "pocketmark=private-cookie")
	r.Header.Set("X-Request-ID", "private-request-id")
	r.Header.Set("traceparent", "00-11111111111111111111111111111111-2222222222222222-01")
	r.Header.Set("tracestate", "secret=private-tracestate")
	r.Header.Set("baggage", "secret=private-baggage")
	w := httptest.NewRecorder()
	o.HTTP(w, r, "/api/links/{id}", func(w http.ResponseWriter, r *http.Request) {
		Error(ResponseContext(w), "synthetic_error", &url.Error{Op: "Get", URL: "https://user:private-password@site.test/?private-url", Err: errors.New("private-error-body")})
		w.WriteHeader(201)
		w.WriteHeader(202)
		io.WriteString(w, "stream")
		if err := http.NewResponseController(w).Flush(); err != nil {
			t.Fatal(err)
		}
		io.WriteString(w, "ed")
	})
	if w.Code != 201 || w.Body.String() != "streamed" || !w.Flushed {
		t.Fatalf("stream: %v", w)
	}
	if len(w.Header().Get("X-Request-ID")) != 32 {
		t.Fatal("missing server-generated request ID")
	}
	raw := logs.String()
	if strings.Contains(raw, "private-") {
		t.Fatalf("private input in logs: %s", raw)
	}
	entries := records(t, &logs)
	if len(entries) != 2 {
		t.Fatalf("logs: %v", entries)
	}
	for _, entry := range entries {
		if entry["request_id"] != w.Header().Get("X-Request-ID") || entry["trace_id"] != "11111111111111111111111111111111" {
			t.Fatalf("uncorrelated: %v", entry)
		}
	}
	if entries[1]["status"] != float64(201) || entries[1]["bytes_written"] != float64(8) {
		t.Fatalf("request: %v", entries[1])
	}
	spans := exporter.GetSpans()
	if len(spans) != 1 || spans[0].Parent.SpanID().String() != "2222222222222222" || spans[0].Name != "GET /api/links/{id}" || spans[0].SpanContext.TraceState().String() != "" {
		t.Fatalf("spans: %v", spans)
	}
	if strings.Contains(fmt.Sprint(spans), "private-") {
		t.Fatal("private input in traces")
	}
}

func TestPanicsAreSanitizedAndCounted(t *testing.T) {
	for _, committed := range []bool{false, true} {
		t.Run(fmt.Sprint(committed), func(t *testing.T) {
			var logs bytes.Buffer
			o := testObserver(&logs)
			w := httptest.NewRecorder()
			func() {
				defer func() {
					p := recover()
					if committed && p != http.ErrAbortHandler {
						t.Errorf("stream panic: %v", p)
					}
					if !committed && p != nil {
						t.Errorf("unexpected panic: %v", p)
					}
				}()
				o.HTTP(w, httptest.NewRequest("GET", "/", nil), "/", func(w http.ResponseWriter, _ *http.Request) {
					if committed {
						io.WriteString(w, "partial")
					}
					panic("private-panic")
				})
			}()
			if !committed && w.Code != 500 {
				t.Fatalf("status %d", w.Code)
			}
			if strings.Contains(logs.String(), "private-panic") || o.measurements.inflight.Load() != 0 {
				t.Fatal("panic leaked or in-flight count stuck")
			}
			if o.measurements.http[httpLabels{"GET", "/", 500}].Count != 1 {
				t.Fatal("panic was not counted")
			}
		})
	}
}

func TestMetricsBoundCardinalityAndConcurrency(t *testing.T) {
	o := testObserver(io.Discard)
	var wg sync.WaitGroup
	for n := 0; n < 8; n++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			for i := 0; i < 100; i++ {
				o.HTTP(httptest.NewRecorder(), httptest.NewRequest(fmt.Sprintf("UNTRUSTED%d", i), "/private-path", nil), fmt.Sprintf("/registered/%d", n*100+i), func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(503) })
			}
		}(n)
	}
	wg.Wait()
	if len(o.measurements.http) != maxHTTPSeries || o.measurements.overflow.Count != 800-maxHTTPSeries {
		t.Fatal("HTTP series are not bounded")
	}
	w := httptest.NewRecorder()
	o.Metrics(w, nil)
	body := w.Body.String()
	for _, want := range []string{`method="_OTHER"`, `route="_overflow"`, `status="503"`, `le="+Inf"`, "pocketmark_go_managed_memory_bytes", "pocketmark_go_heap_live_bytes", "pocketmark_capture_duration_seconds_count"} {
		if !strings.Contains(body, want) {
			t.Errorf("missing metric %s", want)
		}
	}
	if strings.Contains(body, "private-path") || strings.Contains(body, "UNTRUSTED") {
		t.Fatal("untrusted metric label")
	}
}

func TestHistogramCumulativeBuckets(t *testing.T) {
	var h histogram
	h.observe(7 * time.Millisecond)
	h.observe(3 * time.Second)
	var out bytes.Buffer
	writeHistogram(&out, "duration", `method="GET",`, h)
	for _, want := range []string{`duration_bucket{method="GET",le="0.005"} 0`, `duration_bucket{method="GET",le="0.01"} 1`, `duration_bucket{method="GET",le="5"} 2`, `duration_bucket{method="GET",le="+Inf"} 2`, `duration_count{method="GET"} 2`} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("missing %s", want)
		}
	}
}

func TestCaptureOutcomesAndTraceErrors(t *testing.T) {
	var logs bytes.Buffer
	exporter := tracetest.NewInMemoryExporter()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	defer provider.Shutdown(context.Background())
	o := testObserver(&logs)
	o.tracer = provider.Tracer("test")
	ctx := context.Background()
	for i := 0; i < 4; i++ {
		parent, cancel := context.WithCancel(ctx)
		_, done := o.Capture(parent, 123)
		var fetchErr, saveErr error
		if i == 1 {
			fetchErr = errors.New("private-url")
		}
		if i == 2 {
			saveErr = errors.New("private-content")
		}
		if i == 3 {
			cancel()
		}
		done(fetchErr, saveErr)
		cancel()
	}
	if strings.Contains(logs.String(), "private-") {
		t.Fatal("capture data leaked")
	}
	entries := records(t, &logs)
	for i, outcome := range captureOutcomes {
		if o.measurements.captures[i].Count != 1 || entries[i]["outcome"] != outcome || entries[i]["trace_id"] == nil {
			t.Errorf("missing capture %s", outcome)
		}
	}
	spans := exporter.GetSpans()
	if len(spans) != 4 || spans[0].Status.Code != codes.Unset || spans[1].Status.Code != codes.Error {
		t.Fatalf("capture spans: %v", spans)
	}
	if spans[0].Attributes[0] != attribute.String("capture.outcome", "ready") {
		t.Fatal("unexpected capture attributes")
	}
}

func BenchmarkHTTPDisabledTracing(b *testing.B) {
	o := testObserver(io.Discard)
	r := httptest.NewRequest("GET", "/api/links/1?private=query", nil)
	w := &discardResponse{header: make(http.Header)}
	for b.Loop() {
		o.HTTP(w, r, "/api/links/{id}", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) })
	}
	b.ReportAllocs()
}

type discardResponse struct{ header http.Header }

func (w *discardResponse) Header() http.Header       { return w.header }
func (*discardResponse) WriteHeader(int)             {}
func (*discardResponse) Write(p []byte) (int, error) { return len(p), nil }
