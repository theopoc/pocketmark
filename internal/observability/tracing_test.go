package observability

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	collectortrace "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/protobuf/proto"
)

func cleanTraceEnv(t *testing.T) {
	t.Helper()
	for _, key := range []string{"POCKETMARK_OTEL_ENABLED", "POCKETMARK_OTEL_SAMPLE_RATIO", "OTEL_SERVICE_NAME", "OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "OTEL_EXPORTER_OTLP_HEADERS", "OTEL_EXPORTER_OTLP_TRACES_HEADERS"} {
		t.Setenv(key, "")
	}
}

type failedExporter struct{}

func (failedExporter) ExportSpans(context.Context, []sdktrace.ReadOnlySpan) error {
	return errors.New("https://user:private-secret@collector.test/private-path?private-query: private-response")
}
func (failedExporter) Shutdown(context.Context) error { return nil }

func TestExportFailureLogsAreSanitizedAndRateLimited(t *testing.T) {
	var logs bytes.Buffer
	o := testObserver(&logs)
	e := &reportingExporter{SpanExporter: failedExporter{}, observer: o}
	for i := 0; i < 3; i++ {
		if err := e.ExportSpans(context.Background(), nil); err != nil {
			t.Fatal(err)
		}
	}
	if o.measurements.exportErrors.Load() != 3 {
		t.Fatal("missing failed exports")
	}
	if strings.Contains(logs.String(), "private-") {
		t.Fatal("collector error leaked")
	}
	if r := records(t, &logs); len(r) != 1 || r[0]["msg"] != "trace_export_failed" {
		t.Fatalf("unbounded warnings: %v", r)
	}
}

func TestZeroRootSamplingAndCollectorRedirect(t *testing.T) {
	for _, ratio := range []float64{0, 1} {
		t.Run(fmtRatio(ratio), func(t *testing.T) {
			cleanTraceEnv(t)
			var requests, redirected atomic.Int64
			destination := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { redirected.Add(1) }))
			defer destination.Close()
			collector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				http.Redirect(w, r, destination.URL, 307)
			}))
			defer collector.Close()
			o := testObserver(io.Discard)
			shutdown, err := o.EnableTracing(context.Background(), TraceConfig{Enabled: true, Endpoint: collector.URL + "/v1/traces", ServiceName: "test", SampleRatio: ratio})
			if err != nil {
				t.Fatal(err)
			}
			_, span := o.tracer.Start(context.Background(), "test")
			span.End()
			if err := shutdown(context.Background()); err != nil {
				t.Fatal(err)
			}
			if requests.Load() != int64(ratio) || redirected.Load() != 0 {
				t.Fatal("sampling or redirect boundary failed")
			}
		})
	}
}

func fmtRatio(ratio float64) string {
	if ratio == 0 {
		return "no-root-spans"
	}
	return "redirect-rejected"
}

func TestTracingDisabledIgnoresOTELVariables(t *testing.T) {
	cleanTraceEnv(t)
	var requests atomic.Int64
	collector := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { requests.Add(1) }))
	defer collector.Close()
	t.Setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", collector.URL)
	t.Setenv("POCKETMARK_OTEL_SAMPLE_RATIO", "invalid-ignored")
	c, err := TraceConfigFromEnv()
	if err != nil || c.Enabled {
		t.Fatalf("disabled config: %v %v", c, err)
	}
	o := testObserver(io.Discard)
	shutdown, err := o.EnableTracing(context.Background(), c)
	if err != nil {
		t.Fatal(err)
	}
	_, span := o.tracer.Start(context.Background(), "test")
	if span.IsRecording() {
		t.Fatal("disabled tracer records spans")
	}
	span.End()
	if err := shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	if requests.Load() != 0 {
		t.Fatal("disabled tracing contacted collector")
	}
}

func TestTraceConfigValidation(t *testing.T) {
	cleanTraceEnv(t)
	t.Setenv("POCKETMARK_OTEL_ENABLED", "true")
	c, err := TraceConfigFromEnv()
	if err != nil || c.Endpoint != "http://localhost:4318/v1/traces" || c.SampleRatio != .1 || c.ServiceName != "pocketmark" {
		t.Fatalf("defaults: %v %v", c, err)
	}
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "https://collector.test/base/")
	c, err = TraceConfigFromEnv()
	if err != nil || c.Endpoint != "https://collector.test/base/v1/traces" {
		t.Fatalf("base endpoint: %v %v", c, err)
	}
	t.Setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "https://collector.test/custom")
	c, err = TraceConfigFromEnv()
	if err != nil || c.Endpoint != "https://collector.test/custom" {
		t.Fatalf("trace endpoint: %v %v", c, err)
	}
	for _, value := range []string{"NaN", "Inf", "-0.1", "1.1", "invalid"} {
		t.Setenv("POCKETMARK_OTEL_SAMPLE_RATIO", value)
		if _, err := TraceConfigFromEnv(); err == nil {
			t.Errorf("accepted sample ratio %s", value)
		}
	}
	t.Setenv("POCKETMARK_OTEL_SAMPLE_RATIO", "0")
	for _, value := range []string{"grpc://collector.test", "http://user:private-secret@collector.test", "http://collector.test?private-secret", "http://collector.test/#private-secret", "://private-secret", "http:///missing-host"} {
		t.Setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", value)
		_, err := TraceConfigFromEnv()
		if err == nil || strings.Contains(err.Error(), "private-secret") {
			t.Errorf("unsafe validation: %v", err)
		}
	}
}

func TestOTLPHTTPExportAndLimits(t *testing.T) {
	cleanTraceEnv(t)
	t.Setenv("OTEL_EXPORTER_OTLP_TRACES_HEADERS", "x-test=synthetic")
	// Environment settings cannot override the explicit hard limits.
	t.Setenv("OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT", "999999")
	t.Setenv("OTEL_SPAN_EVENT_COUNT_LIMIT", "999999")
	var mu sync.Mutex
	var received []*tracepb.ResourceSpans
	collector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/traces" || r.Header.Get("Content-Type") != "application/x-protobuf" || r.Header.Get("X-Test") != "synthetic" {
			t.Errorf("OTLP request: %v %v", r.URL, r.Header)
		}
		raw, err := io.ReadAll(io.LimitReader(r.Body, 64<<10))
		if err != nil {
			t.Error(err)
		}
		var request collectortrace.ExportTraceServiceRequest
		if err := proto.Unmarshal(raw, &request); err != nil {
			t.Error(err)
		}
		mu.Lock()
		received = append(received, request.ResourceSpans...)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/x-protobuf")
	}))
	defer collector.Close()
	o := testObserver(io.Discard)
	shutdown, err := o.EnableTracing(context.Background(), TraceConfig{Enabled: true, Endpoint: collector.URL + "/v1/traces", ServiceName: "test-pocketmark", SampleRatio: 1})
	if err != nil {
		t.Fatal(err)
	}
	_, span := o.tracer.Start(context.Background(), "bounded-test")
	for i := 0; i < 32; i++ {
		span.SetAttributes(attribute.Int(string(rune('A'+i)), i))
	}
	span.SetAttributes(attribute.String("A", strings.Repeat("x", 1000)))
	span.AddEvent("private-event")
	span.End()
	o.HTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/links/123?private-query", nil), "/api/links/{id}", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(503) })
	_, done := o.Capture(context.Background(), 123)
	done(nil, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	var spans []*tracepb.Span
	for _, resource := range received {
		if len(resource.Resource.Attributes) != 1 || resource.Resource.Attributes[0].Key != "service.name" || resource.Resource.Attributes[0].Value.GetStringValue() != "test-pocketmark" {
			t.Fatalf("resource: %v", resource.Resource)
		}
		for _, scope := range resource.ScopeSpans {
			spans = append(spans, scope.Spans...)
		}
	}
	if len(spans) != 3 {
		t.Fatalf("received %d spans", len(spans))
	}
	for _, s := range spans {
		if len(s.Attributes) > 16 || len(s.Events) != 0 || len(s.Links) != 0 {
			t.Fatalf("unbounded span: %v", s)
		}
		for _, a := range s.Attributes {
			if len(a.Value.GetStringValue()) > 128 {
				t.Fatal("unbounded attribute value")
			}
		}
		if strings.Contains(s.String(), "private-") {
			t.Fatal("private input in OTLP payload")
		}
	}
	if spans[1].Status.GetCode() != tracepb.Status_STATUS_CODE_ERROR {
		t.Fatalf("HTTP failure status: %v", spans[1].Status)
	}
}

func TestSlowCollectorDoesNotBlockRequests(t *testing.T) {
	cleanTraceEnv(t)
	entered, release := make(chan struct{}, 1), make(chan struct{})
	collector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case entered <- struct{}{}:
		default:
		}
		select {
		case <-release:
		case <-r.Context().Done():
		}
		w.WriteHeader(503)
		io.WriteString(w, "private-collector-error")
	}))
	defer collector.Close()
	o := testObserver(io.Discard)
	shutdown, err := o.EnableTracing(context.Background(), TraceConfig{Enabled: true, Endpoint: collector.URL + "/v1/traces", ServiceName: "test", SampleRatio: 1})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < traceBatchSize; i++ {
		_, s := o.tracer.Start(context.Background(), "test")
		s.End()
	}
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		close(release)
		t.Fatal("exporter did not start")
	}
	started := time.Now()
	for i := 0; i < 1000; i++ {
		o.HTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/stats", nil), "/api/stats", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) })
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Errorf("requests blocked by full export queue: %v", elapsed)
	}
	close(release)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	if o.measurements.exportErrors.Load() == 0 {
		t.Fatal("failed export was not counted")
	}
}
