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
	"strings"

	"pocketmark/internal/fault"
)

type loggerKey struct{}

// LevelFatal marks an unrecoverable failure: the process exits right after
// logging it. slog has no fatal level, so it is rendered as "FATAL".
const LevelFatal = slog.Level(12)

// ConfigureLogging installs one JSON logger, including for legacy log.Print calls.
func ConfigureLogging(dst io.Writer, level string) error {
	var minimum slog.Level
	if level == "" {
		level = "INFO"
	}
	if err := minimum.UnmarshalText([]byte(level)); err != nil {
		return fault.New("configuration", "invalid_log_level", "POCKETMARK_LOG_LEVEL must be DEBUG, INFO, WARN or ERROR")
	}
	slog.SetDefault(slog.New(slog.NewJSONHandler(dst, &slog.HandlerOptions{Level: minimum, ReplaceAttr: renderLevel})).With("service", "pocketmark"))
	return nil
}

func renderLevel(groups []string, a slog.Attr) slog.Attr {
	if len(groups) == 0 && a.Key == slog.LevelKey {
		if level, ok := a.Value.Any().(slog.Level); ok && level >= LevelFatal {
			return slog.String(slog.LevelKey, "FATAL")
		}
	}
	return a
}

func Logger(ctx context.Context) *slog.Logger {
	if logger, ok := ctx.Value(loggerKey{}).(*slog.Logger); ok {
		return logger
	}
	return slog.Default()
}

// Log writes one event: "msg" is a sentence for the person reading the log and
// "event" is the stable identifier for queries and alerts. See docs/LOGGING.md.
func Log(ctx context.Context, level slog.Level, event, message string, attrs ...any) {
	logEvent(ctx, Logger(ctx), level, event, message, attrs...)
}

func logEvent(ctx context.Context, logger *slog.Logger, level slog.Level, event, message string, attrs ...any) {
	logger.Log(ctx, level, message, append([]any{"event", event}, attrs...)...)
}

// Error logs a classified failure once at the boundary that handles it.
// The message names the event and explains the cause with Describe; raw error
// text never crosses this boundary. A failed operation logs at ERROR; a client
// error (4xx) in a request at WARN, since the service keeps working; a
// cancellation at INFO. Outside a request, every failure is an ERROR.
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
	_, inRequest := ctx.Value(failureKey{}).(*requestFailure)
	if status < 500 && inRequest {
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
	Log(ctx, level, event, Failure(event, err), attrs...)
}

// Fatal logs the failure that stops the process. The caller exits afterwards.
func Fatal(ctx context.Context, event string, err error) {
	Log(ctx, LevelFatal, event, Failure(event, err), ErrorAttrs(err)...)
}

var acronyms = map[string]string{"ai": "AI", "api": "API", "dav": "WebDAV", "html": "HTML", "http": "HTTP", "mfa": "MFA", "otlp": "OTLP", "s3": "S3", "zip": "ZIP"}

// Failure builds the log message of a failed event: "Backup failed: S3 bucket
// does not exist". The event identifier names what failed, Describe says why.
func Failure(event string, err error) string {
	words := strings.Split(event, "_")
	for i, word := range words {
		if acronym, ok := acronyms[word]; ok {
			words[i] = acronym
		}
	}
	what := strings.Join(words, " ")
	if what != "" {
		what = strings.ToUpper(what[:1]) + what[1:]
	}
	if err == nil {
		return what
	}
	return what + ": " + Describe(err)
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
	// Classify only known net/http prefixes; never emit the supplied text.
	// Protocol and TLS errors come from clients and leave the server running.
	kind, level, message := "server_protocol", slog.LevelWarn, "HTTP server rejected a malformed client connection"
	if bytes.HasPrefix(p, []byte("http: TLS handshake error")) {
		kind, message = "tls_handshake", "TLS handshake with a client failed"
	}
	if bytes.HasPrefix(p, []byte("http: panic serving")) {
		kind, level, message = "panic", slog.LevelError, "HTTP server recovered from a panic"
	}
	logEvent(context.Background(), slog.Default(), level, "http_server_error", message, "error_code", kind)
	return len(p), nil
}
