package observability

import (
	"context"
	"crypto/tls"
	"database/sql"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"syscall"

	"github.com/jackc/pgx/v5/pgconn"
	"pocketmark/internal/capture"
	"pocketmark/internal/fault"
	"strings"
)

type diagnosis struct {
	kind, code, message string
	status              int
	attrs               []any
}

// diagnose uses typed causes, never string matching against untrusted messages.
// Every message is static text or a value Go/PostgreSQL defines (status text,
// SQLSTATE, errno text), so it can be logged without copying external input.
func diagnose(err error) diagnosis {
	d := diagnosis{kind: "internal", code: "unexpected", status: 500}
	var app *fault.Error
	var postgres *pgconn.PgError
	var connect *pgconn.ConnectError
	var remote *capture.HTTPStatusError
	var dns *net.DNSError
	var network net.Error
	var connection *net.OpError
	var errno syscall.Errno
	var cert *tls.CertificateVerificationError
	var syntax *json.SyntaxError
	var value *json.UnmarshalTypeError
	var xmlSyntax *xml.SyntaxError
	var size *http.MaxBytesError
	switch {
	case errors.Is(err, context.Canceled):
		d.kind, d.code, d.status = "canceled", "canceled", 499
		d.message = "operation canceled"
	case errors.As(err, &connect):
		// Checked before PostgreSQL errors: pgx wraps server errors raised while
		// connecting (57P03, 53300, 28P01, 3D000) in a ConnectError.
		d.kind, d.code, d.status = "database", "database_unreachable", 503
		d.message = "cannot connect to PostgreSQL"
		if cause := connect.Unwrap(); cause != nil {
			if reason := diagnose(cause); reason.code != "unexpected" {
				d.message += ": " + reason.message
				d.attrs = reason.attrs
			}
		}
	case errors.Is(err, context.DeadlineExceeded):
		d.kind, d.code, d.status = "timeout", "deadline_exceeded", 504
		d.message = "operation timed out"
	case errors.Is(err, sql.ErrNoRows):
		d.kind, d.code, d.status = "not_found", "not_found", 404
		d.message = "record not found"
	case errors.As(err, &postgres):
		d.kind, d.code = "database", "postgresql"
		d.attrs = []any{"sqlstate", postgres.Code}
		d.message = postgresMessage(postgres)
		if strings.HasPrefix(postgres.Code, "23") {
			d.status = 400
		}
		if postgres.Code == "55P03" || postgres.Code == "40001" || postgres.Code == "40P01" {
			d.status = 503
		}
	case errors.As(err, &size):
		d.kind, d.code, d.status = "validation", "body_too_large", 413
		d.message = "request body exceeds the size limit"
	case errors.As(err, &app):
		d.kind, d.code = app.Kind, app.Code
		d.message = "invalid input"
		if message, ok := app.Message(); ok {
			d.message = message
		}
		if app.Kind == "validation" || app.Kind == "capture" {
			d.status = 400
		}
	case errors.As(err, &remote):
		d.kind, d.code, d.status = "http", "upstream_status", 502
		d.attrs = []any{"http_status", remote.StatusCode, "http_status_text", http.StatusText(remote.StatusCode)}
		d.message = strings.TrimSpace(fmt.Sprintf("remote server answered HTTP %d %s", remote.StatusCode, http.StatusText(remote.StatusCode)))
	case errors.As(err, &syntax), errors.As(err, &value), errors.As(err, &xmlSyntax):
		d.kind, d.code, d.status = "validation", "invalid_document", 400
		d.message = "document is not valid JSON or XML"
	case errors.As(err, &cert):
		d.kind, d.code, d.status = "tls", "certificate_verification", 502
		d.message = "TLS certificate verification failed"
	case errors.As(err, &dns):
		d.kind, d.code, d.status = "dns", "dns_failure", 502
		d.message = "DNS lookup failed"
		if dns.IsNotFound {
			d.code, d.message = "dns_not_found", "DNS name does not exist"
		}
		if dns.IsTimeout {
			d.code, d.status, d.message = "dns_timeout", 504, "DNS lookup timed out"
		}
	case errors.As(err, &network) && network.Timeout():
		d.kind, d.code, d.status = "timeout", "network_timeout", 504
		d.message = "network operation timed out"
	case errors.As(err, &connection):
		d.kind, d.code, d.status = "network", "network_failure", 502
		d.message = "network " + connection.Op + " failed"
	case errors.Is(err, os.ErrPermission):
		d.kind, d.code = "permission", "permission_denied"
		d.message = "permission denied"
	case errors.Is(err, os.ErrNotExist):
		d.kind, d.code = "filesystem", "file_not_found"
		d.message = "file not found"
	case errors.Is(err, io.ErrUnexpectedEOF):
		d.kind, d.code = "io", "unexpected_eof"
		d.message = "data ended unexpectedly"
	}
	// A PostgreSQL connection failure already carries its cause's errno.
	if d.code != "database_unreachable" && errors.As(err, &errno) {
		d.attrs = append(d.attrs, "errno", int(errno))
		if d.kind == "internal" {
			d.kind, d.code = "io", "system_error"
			d.message = "system call failed"
		}
		// Errno text comes from the operating system's static table.
		if d.kind == "io" || d.kind == "network" {
			d.message += ": " + errno.Error()
		}
	}
	if d.message == "" {
		root := err
		for i := 0; i < 16 && errors.Unwrap(root) != nil; i++ {
			root = errors.Unwrap(root)
		}
		d.message = fmt.Sprintf("unexpected error (%T); define a fault with a message for this failure", root)
	}
	return d
}

var postgresStates = map[string]string{
	"23502": "a required column is missing",
	"23503": "a referenced record does not exist",
	"23505": "a unique value already exists",
	"23514": "a check constraint rejected the value",
	"28000": "PostgreSQL rejected the role",
	"28P01": "PostgreSQL password authentication failed",
	"3D000": "the PostgreSQL database does not exist",
	"40001": "transaction serialization conflict",
	"40P01": "deadlock detected",
	"42501": "PostgreSQL permission denied",
	"42P01": "a table is missing; the schema may be outdated",
	"53100": "PostgreSQL disk is full",
	"53200": "PostgreSQL is out of memory",
	"53300": "PostgreSQL has too many connections",
	"55P03": "a PostgreSQL lock is held by another transaction",
	"57014": "PostgreSQL canceled the statement",
	"57P01": "PostgreSQL is shutting down",
	"57P03": "PostgreSQL is not accepting connections yet",
}

// postgresMessage never uses the server's message, which may quote values.
// Constraint and table names are schema identifiers owned by the application.
func postgresMessage(e *pgconn.PgError) string {
	message := "PostgreSQL error SQLSTATE " + e.Code
	if known, ok := postgresStates[e.Code]; ok {
		message = known + " (SQLSTATE " + e.Code + ")"
	}
	if e.ConstraintName != "" {
		message += ", constraint " + e.ConstraintName
	} else if e.TableName != "" {
		message += ", table " + e.TableName
	}
	return message
}

func HTTPStatus(err error) int { return diagnose(err).status }

// Describe explains a failure in one sentence that is safe to log: the
// developer-owned fault message, followed by the classified cause when known.
// It never copies raw error text, which may carry URLs, paths or input.
func Describe(err error) string {
	if err == nil {
		return ""
	}
	d := diagnose(err)
	var app *fault.Error
	if !errors.As(err, &app) {
		return d.message
	}
	message, ok := app.Message()
	if !ok {
		return d.message
	}
	cause := app.Unwrap()
	if d.kind != app.Kind || d.code != app.Code {
		// A typed cause outside the fault (for example PostgreSQL) classified it.
		return message + ": " + d.message
	}
	if cause != nil {
		if reason := diagnose(cause); reason.code != "unexpected" {
			return message + ": " + reason.message
		}
	}
	return message
}

// ErrorAttrs excludes raw messages, URLs, filesystem paths, SQL and credentials.
func ErrorAttrs(err error) []any {
	d := diagnose(err)
	root := err
	for i := 0; i < 16; i++ {
		next := errors.Unwrap(root)
		if next == nil {
			break
		}
		root = next
	}
	attrs := []any{"error_kind", d.kind, "error_code", d.code, "error_type", fmt.Sprintf("%T", root)}
	if op := fault.Operation(err); op != "" {
		attrs = append(attrs, "operation", op)
	}
	return append(attrs, d.attrs...)
}

type codeFrame struct {
	Function string `json:"function"`
	File     string `json:"file"`
	Line     int    `json:"line"`
}

// CallersFrames contains code locations only, unlike panic text or argument dumps.
func stackFrames(skip, limit int) []codeFrame {
	var pcs [24]uintptr
	n := runtime.Callers(skip, pcs[:])
	frames := runtime.CallersFrames(pcs[:n])
	out := make([]codeFrame, 0, limit)
	for len(out) < limit {
		f, more := frames.Next()
		out = append(out, codeFrame{f.Function, filepath.Base(f.File), f.Line})
		if !more {
			break
		}
	}
	return out
}
