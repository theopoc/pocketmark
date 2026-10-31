package observability

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
	"go.opentelemetry.io/otel/trace/noop"
)

type Observer struct {
	logger       *slog.Logger
	tracer       trace.Tracer
	measurements measurements
}

func New(logger *slog.Logger, tracer trace.Tracer) *Observer {
	if logger == nil {
		logger = slog.Default()
	}
	if tracer == nil {
		tracer = noop.NewTracerProvider().Tracer("pocketmark")
	}
	return &Observer{logger: logger, tracer: tracer, measurements: measurements{http: make(map[httpLabels]histogram)}}
}

func methodLabel(method string) string {
	switch method {
	case "GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "PROPFIND", "MOVE", "MKCOL", "COPY", "LOCK", "UNLOCK":
		return method
	default:
		return "_OTHER"
	}
}

// HTTP instruments the entire request, including early authentication/origin and
// capacity rejections. route must be a registered template, never r.URL.Path.
func (o *Observer) HTTP(w http.ResponseWriter, r *http.Request, route string, next http.HandlerFunc) {
	method := methodLabel(r.Method)
	if route == "" {
		route = "_unmatched"
	}
	// Only traceparent is accepted: arbitrary baggage/tracestate is not exported.
	ctx := propagation.TraceContext{}.Extract(r.Context(), propagation.MapCarrier{"traceparent": r.Header.Get("traceparent")})
	var span trace.Span
	if r.URL.Path != "/healthz" && r.URL.Path != "/metrics" {
		ctx, span = o.tracer.Start(ctx, method+" "+route, trace.WithSpanKind(trace.SpanKindServer), trace.WithAttributes(attribute.String("http.request.method", method), attribute.String("http.route", route)))
	}
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		panic(err)
	}
	requestID := hex.EncodeToString(id[:])
	logger := o.logger.With("request_id", requestID)
	if sc := trace.SpanContextFromContext(ctx); sc.IsValid() {
		logger = logger.With("trace_id", sc.TraceID().String(), "span_id", sc.SpanID().String())
	}
	ctx = context.WithValue(ctx, loggerKey{}, logger)
	w.Header().Set("X-Request-ID", requestID)
	response := &responseWriter{ResponseWriter: w, ctx: ctx}
	started := time.Now()
	o.measurements.inflight.Add(1)
	defer func() {
		problem := recover()
		aborted := false
		if problem != nil {
			logger.ErrorContext(ctx, "http_panic") // Never log the panic value or stack containing user data.
			aborted = problem == http.ErrAbortHandler || response.status != 0
			if !aborted {
				response.Header().Set("Content-Type", "application/json")
				response.WriteHeader(http.StatusInternalServerError)
				io.WriteString(response, "{\"error\":\"internal server error\"}\n")
			}
		}
		status := response.status
		if status == 0 {
			status = 200
		}
		if aborted {
			status = 500
		}
		elapsed := time.Since(started)
		o.measurements.inflight.Add(-1)
		o.measurements.observeHTTP(httpLabels{method, route, status}, elapsed)
		level := slog.LevelInfo
		if (r.URL.Path == "/healthz" || r.URL.Path == "/livez") || r.URL.Path == "/metrics" {
			level = slog.LevelDebug
		}
		if status >= 400 {
			level = slog.LevelWarn
		}
		if status >= 500 {
			level = slog.LevelError
		}
		logger.Log(ctx, level, "http_request", "method", method, "route", route, "status", status, "duration_ms", float64(elapsed)/float64(time.Millisecond), "bytes_written", response.bytes)
		if span != nil {
			span.SetAttributes(attribute.Int("http.response.status_code", status))
			if status >= 500 {
				span.SetStatus(codes.Error, "HTTP server error")
			}
			span.End()
		}
		if aborted {
			panic(http.ErrAbortHandler)
		}
	}()
	next(response, r.WithContext(ctx))
}

type responseWriter struct {
	http.ResponseWriter
	ctx    context.Context
	status int
	bytes  int64
}

func (w *responseWriter) Context() context.Context    { return w.ctx }
func (w *responseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *responseWriter) WriteHeader(status int) {
	if status >= 100 && status < 200 && status != http.StatusSwitchingProtocols {
		w.ResponseWriter.WriteHeader(status)
		return
	}
	if w.status != 0 {
		return
	}
	w.ResponseWriter.WriteHeader(status)
	w.status = status
}
func (w *responseWriter) Write(p []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(200)
	}
	n, err := w.ResponseWriter.Write(p)
	w.bytes += int64(n)
	return n, err
}
func (w *responseWriter) Flush() {
	if w.status == 0 {
		w.WriteHeader(200)
	}
	if err := http.NewResponseController(w.ResponseWriter).Flush(); err != nil {
		Error(w.ctx, "http_flush_failed", err)
	}
}

// Route strips only the registration's method prefix. All returned names originate
// from the application's finite ServeMux registrations, including WebDAV patterns.
func Route(pattern string) string {
	if _, path, ok := strings.Cut(pattern, " "); ok {
		return path
	}
	return pattern
}
