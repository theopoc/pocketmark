// Package observability provides bounded, best-effort application diagnostics.
package observability

import (
	"bytes"
	"context"
	"errors"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
	"io"
	"log"
	"log/slog"
	"net/http"
)

type loggerKey struct{}

// ConfigureLogging installs one JSON logger, including for legacy log.Print calls.
func ConfigureLogging(dst io.Writer, level string) error {
	var minimum slog.Level
	if level == "" {
		level = "INFO"
	}
	if err := minimum.UnmarshalText([]byte(level)); err != nil {
		return errors.New("POCKETMARK_LOG_LEVEL must be DEBUG, INFO, WARN or ERROR")
	}
	slog.SetDefault(slog.New(slog.NewJSONHandler(dst, &slog.HandlerOptions{Level: minimum})).With("service", "pocketmark"))
	return nil
}

func Logger(ctx context.Context) *slog.Logger {
	if logger, ok := ctx.Value(loggerKey{}).(*slog.Logger); ok {
		return logger
	}
	return slog.Default()
}

// Error logs a classified failure once at the boundary that handles it.
// Message contents never cross this boundary; the owning operation and code do.
func Error(ctx context.Context, event string, err error) {
	if err == nil {
		return
	}
	var write *responseWriteError
	if errors.As(err, &write) && write.reported.Swap(true) {
		return
	}
	attrs := ErrorAttrs(err)
	level := slog.LevelError
	status := HTTPStatus(err)
	if write != nil {
		status = 500
	}
	if status < 500 {
		level = slog.LevelWarn
	}
	if errors.Is(err, context.Canceled) {
		level = slog.LevelInfo
	}
	if status >= 500 && !errors.Is(err, context.Canceled) {
		span := trace.SpanFromContext(ctx)
		span.SetStatus(codes.Error, "application failure")
		if state, ok := ctx.Value(failureKey{}).(*requestFailure); ok {
			state.failed.Store(true)
		}
		attrs = append(attrs, "source", stackFrames(3, 4))
	}
	Logger(ctx).Log(ctx, level, event, attrs...)
}

// ResponseContext keeps existing response helpers correlated without changing
// every handler signature. Unwrapped writers are supported for unit tests.
func ResponseContext(w http.ResponseWriter) context.Context {
	if w, ok := w.(interface{ Context() context.Context }); ok {
		return w.Context()
	}
	return context.Background()
}

// HTTPErrorLog keeps net/http's low-level diagnostics JSON and excludes raw
// connection errors, which may contain addresses or attacker-controlled text.
func HTTPErrorLog() *log.Logger { return log.New(httpErrorWriter{}, "", 0) }

type httpErrorWriter struct{}

func (httpErrorWriter) Write(p []byte) (int, error) {
	kind := "server_protocol"
	// Classify only known net/http prefixes; never emit the supplied text.
	if bytes.HasPrefix(p, []byte("http: TLS handshake error")) {
		kind = "tls_handshake"
	}
	if bytes.HasPrefix(p, []byte("http: panic serving")) {
		kind = "panic"
	}
	slog.Error("http_server_error", "error_code", kind)
	return len(p), nil
}
