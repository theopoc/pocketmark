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

	"github.com/mattn/go-sqlite3"
	"pocketmark/internal/capture"
	"pocketmark/internal/fault"
)

type diagnosis struct {
	kind, code string
	status     int
	attrs      []any
}

// diagnose uses typed causes, never string matching against untrusted messages.
func diagnose(err error) diagnosis {
	d := diagnosis{kind: "internal", code: "unexpected", status: 500}
	var app *fault.Error
	var sqlite sqlite3.Error
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
	case errors.Is(err, context.DeadlineExceeded):
		d.kind, d.code, d.status = "timeout", "deadline_exceeded", 504
	case errors.Is(err, sql.ErrNoRows):
		d.kind, d.code, d.status = "not_found", "not_found", 404
	case errors.As(err, &sqlite):
		d.kind, d.code = "database", "sqlite"
		d.attrs = []any{"sqlite_code", int(sqlite.Code), "sqlite_extended_code", int(sqlite.ExtendedCode)}
		if sqlite.Code == sqlite3.ErrConstraint {
			d.status = 400
		}
		if sqlite.Code == sqlite3.ErrBusy || sqlite.Code == sqlite3.ErrLocked {
			d.status = 503
		}
	case errors.As(err, &size):
		d.kind, d.code, d.status = "validation", "body_too_large", 413
	case errors.As(err, &app):
		d.kind, d.code = app.Kind, app.Code
		if app.Kind == "validation" || app.Kind == "capture" {
			d.status = 400
		}
	case errors.As(err, &remote):
		d.kind, d.code, d.status = "http", "upstream_status", 502
		d.attrs = []any{"http_status", remote.StatusCode, "http_status_text", http.StatusText(remote.StatusCode)}
	case errors.As(err, &syntax), errors.As(err, &value), errors.As(err, &xmlSyntax):
		d.kind, d.code, d.status = "validation", "invalid_document", 400
	case errors.As(err, &cert):
		d.kind, d.code, d.status = "tls", "certificate_verification", 502
	case errors.As(err, &dns):
		d.kind, d.code, d.status = "dns", "dns_failure", 502
		if dns.IsNotFound {
			d.code = "dns_not_found"
		}
		if dns.IsTimeout {
			d.code, d.status = "dns_timeout", 504
		}
	case errors.As(err, &network) && network.Timeout():
		d.kind, d.code, d.status = "timeout", "network_timeout", 504
	case errors.As(err, &connection):
		d.kind, d.code, d.status = "network", "network_failure", 502
	case errors.Is(err, os.ErrPermission):
		d.kind, d.code = "permission", "permission_denied"
	case errors.Is(err, os.ErrNotExist):
		d.kind, d.code = "filesystem", "file_not_found"
	case errors.Is(err, io.ErrUnexpectedEOF):
		d.kind, d.code = "io", "unexpected_eof"
	}
	if errors.As(err, &errno) {
		d.attrs = append(d.attrs, "errno", int(errno))
		if d.kind == "internal" {
			d.kind, d.code = "io", "system_error"
		}
	}
	return d
}

func HTTPStatus(err error) int { return diagnose(err).status }

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
