package observability

import (
	"context"
	"errors"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

const (
	traceQueueSize     = 32
	traceBatchSize     = 16
	traceExportTimeout = 2 * time.Second
)

type TraceConfig struct {
	Enabled               bool
	Endpoint, ServiceName string
	SampleRatio           float64
}

func TraceConfigFromEnv() (TraceConfig, error) {
	var c TraceConfig
	if value := os.Getenv("POCKETMARK_OTEL_ENABLED"); value != "" {
		enabled, err := strconv.ParseBool(value)
		if err != nil {
			return c, errors.New("POCKETMARK_OTEL_ENABLED must be true or false")
		}
		c.Enabled = enabled
	}
	if !c.Enabled {
		return c, nil
	}
	c.ServiceName = os.Getenv("OTEL_SERVICE_NAME")
	if c.ServiceName == "" {
		c.ServiceName = "pocketmark"
	}
	if len(c.ServiceName) > 128 {
		return c, errors.New("OTEL_SERVICE_NAME exceeds 128 bytes")
	}
	c.SampleRatio = 0.1
	if value := os.Getenv("POCKETMARK_OTEL_SAMPLE_RATIO"); value != "" {
		ratio, err := strconv.ParseFloat(value, 64)
		if err != nil || math.IsNaN(ratio) || math.IsInf(ratio, 0) || ratio < 0 || ratio > 1 {
			return c, errors.New("POCKETMARK_OTEL_SAMPLE_RATIO must be between 0 and 1")
		}
		c.SampleRatio = ratio
	}
	c.Endpoint = os.Getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")
	if c.Endpoint == "" {
		base := os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
		if base == "" {
			base = "http://localhost:4318"
		}
		c.Endpoint = strings.TrimRight(base, "/") + "/v1/traces"
	}
	if err := validateTraceEndpoint(c.Endpoint); err != nil {
		return c, err
	}
	return c, nil
}

func validateTraceEndpoint(endpoint string) error {
	u, err := url.Parse(endpoint)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || len(endpoint) > 2048 {
		return errors.New("OTLP trace endpoint must be an HTTP(S) URL without credentials, query or fragment")
	}
	return nil
}

// EnableTracing creates exporter goroutines only on explicit opt-in. Limits are
// passed as options so OTEL_BSP_* / OTEL_SPAN_* cannot lift the memory budget.
func (o *Observer) EnableTracing(ctx context.Context, c TraceConfig) (func(context.Context) error, error) {
	if !c.Enabled {
		return func(context.Context) error { return nil }, nil
	}
	if err := validateTraceEndpoint(c.Endpoint); err != nil {
		return nil, err
	}
	if math.IsNaN(c.SampleRatio) || math.IsInf(c.SampleRatio, 0) || c.SampleRatio < 0 || c.SampleRatio > 1 || len(c.ServiceName) > 128 {
		return nil, errors.New("invalid trace sampling ratio or service name")
	}
	transport := &http.Transport{
		Proxy:        http.ProxyFromEnvironment,
		DialContext:  (&net.Dialer{Timeout: traceExportTimeout}).DialContext,
		MaxIdleConns: 1, MaxIdleConnsPerHost: 1, MaxConnsPerHost: 1,
		IdleConnTimeout: 30 * time.Second, TLSHandshakeTimeout: traceExportTimeout,
		ResponseHeaderTimeout: traceExportTimeout, MaxResponseHeaderBytes: 8 << 10,
	}
	client := &http.Client{Transport: transport, Timeout: traceExportTimeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	exporter, err := otlptracehttp.New(ctx,
		otlptracehttp.WithEndpointURL(c.Endpoint),
		otlptracehttp.WithHTTPClient(client),
		otlptracehttp.WithCompression(otlptracehttp.NoCompression),
		otlptracehttp.WithMaxRequestSize(64<<10),
		otlptracehttp.WithMaxResponseSize(64<<10),
		otlptracehttp.WithRetry(otlptracehttp.RetryConfig{Enabled: false}),
	)
	if err != nil {
		transport.CloseIdleConnections()
		return nil, errors.New("could not initialize OTLP HTTP exporter")
	}
	processor := sdktrace.NewBatchSpanProcessor(&reportingExporter{SpanExporter: exporter, observer: o},
		sdktrace.WithMaxQueueSize(traceQueueSize), sdktrace.WithMaxExportBatchSize(traceBatchSize),
		sdktrace.WithBatchTimeout(5*time.Second), sdktrace.WithExportTimeout(traceExportTimeout))
	provider := sdktrace.NewTracerProvider(
		sdktrace.WithSpanProcessor(processor),
		sdktrace.WithSampler(sdktrace.ParentBased(sdktrace.TraceIDRatioBased(c.SampleRatio))),
		sdktrace.WithResource(resource.NewSchemaless(attribute.String("service.name", c.ServiceName))),
		sdktrace.WithRawSpanLimits(sdktrace.SpanLimits{AttributeValueLengthLimit: 128, AttributeCountLimit: 16}),
	)
	o.tracer = provider.Tracer("pocketmark")
	return func(ctx context.Context) error { defer transport.CloseIdleConnections(); return provider.Shutdown(ctx) }, nil
}

type reportingExporter struct {
	sdktrace.SpanExporter
	observer *Observer
	nextLog  atomic.Int64
}

func (e *reportingExporter) ExportSpans(ctx context.Context, spans []sdktrace.ReadOnlySpan) error {
	if err := e.SpanExporter.ExportSpans(ctx, spans); err != nil {
		e.observer.measurements.exportErrors.Add(1)
		now, previous := time.Now().Unix(), e.nextLog.Load()
		if now >= previous && e.nextLog.CompareAndSwap(previous, now+60) {
			e.observer.logger.Warn("trace_export_failed", ErrorAttrs(err)...)
		}
	}
	// Best effort: no retries, and no default SDK handler printing collector URLs
	// or response bodies. The error counter records failed batches independently.
	return nil
}
