// Package observability provides bounded, best-effort application diagnostics.
package observability

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"log"
	"log/slog"
	"net"
	"net/http"
	"os"

	"github.com/mattn/go-sqlite3"
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

// ErrorAttrs deliberately excludes error messages: wrapped HTTP errors can contain
// bookmark URLs, query strings or credentials. SQLite codes remain actionable.
func ErrorAttrs(err error) []any {
	kind := "internal"
	var dns *net.DNSError
	var network net.Error
	var sqlite sqlite3.Error
	switch {
	case errors.Is(err, context.Canceled):
		kind = "canceled"
	case errors.Is(err, context.DeadlineExceeded):
		kind = "timeout"
	case errors.Is(err, sql.ErrNoRows):
		kind = "not_found"
	case errors.Is(err, os.ErrPermission):
		kind = "permission"
	case errors.Is(err, os.ErrNotExist):
		kind = "not_found"
	case errors.As(err, &sqlite):
		return []any{"error_kind", "database", "sqlite_code", int(sqlite.Code), "sqlite_extended_code", int(sqlite.ExtendedCode)}
	case errors.As(err, &dns):
		kind = "dns"
	case errors.As(err, &network):
		kind = "network"
		if network.Timeout() {
			kind = "timeout"
		}
	}
	return []any{"error_kind", kind, "error_type", fmt.Sprintf("%T", err)}
}

func Error(ctx context.Context, event string, err error) {
	Logger(ctx).ErrorContext(ctx, event, ErrorAttrs(err)...)
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
	slog.Error("http_server_error")
	return len(p), nil
}
