package observability

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"pocketmark/internal/fault"
)

func TestDescribeExplainsFailuresWithoutRawText(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want string
	}{
		{"fault", fault.New("backup", "s3_credentials_missing", "S3 access key or secret key is missing"), "S3 access key or secret key is missing"},
		{"fault cause", fault.Cause("notification", "telegram_unreachable", "Telegram connection failed", &net.DNSError{Name: "private-host", Err: "private-text", IsNotFound: true}), "Telegram connection failed: DNS name does not exist"},
		{"postgres", &pgconn.PgError{Code: "23505", Message: "private-value", ConstraintName: "links_url_key"}, "a unique value already exists (SQLSTATE 23505), constraint links_url_key"},
		{"fault over postgres", fault.Cause("database", "migrate_ai_tagging", "PostgreSQL schema step failed: migrate AI tagging", &pgconn.PgError{Code: "42501", Message: "private-value"}), "PostgreSQL schema step failed: migrate AI tagging: PostgreSQL permission denied (SQLSTATE 42501)"},
		{"network", &net.OpError{Op: "dial", Net: "tcp", Err: &net.AddrError{Err: "private-addr"}}, "network dial failed"},
		{"errno", &net.OpError{Op: "dial", Net: "tcp", Err: syscall.ECONNREFUSED}, "network dial failed: connection refused"},
		{"input", fault.Input(errors.New("private-input")), "invalid input"},
		{"unknown", fmt.Errorf("private-wrapper: %w", errors.New("private-unexpected")), "unexpected error (*errors.errorString); define a fault with a message for this failure"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := fault.Wrap("test.operation", &url.Error{Op: "Get", URL: "https://private-host/?token=private-token", Err: tc.err})
			if got := Describe(err); got != tc.want {
				t.Fatalf("Describe = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestFailureNamesTheEventAndTheCause(t *testing.T) {
	got := Failure("backup_notification_failed", fault.New("notification", "telegram_chat_invalid", "invalid Telegram chat ID"))
	if got != "Backup notification failed: invalid Telegram chat ID" {
		t.Fatalf("Failure = %q", got)
	}
	if got := Failure("ai_tag_queue_unavailable", nil); got != "AI tag queue unavailable" {
		t.Fatalf("acronym: %q", got)
	}
}

func TestDatabaseConnectionFailureIsUnavailable(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// Port 1 refuses connections locally, producing a real pgconn.ConnectError.
	_, err := pgconn.Connect(ctx, "postgres://private-user:private-password@127.0.0.1:1/private-db?connect_timeout=2")
	var connect *pgconn.ConnectError
	if !errors.As(err, &connect) {
		t.Skipf("no connection error: %v", err)
	}
	attrs := ErrorAttrs(err)
	errnos := 0
	for i := 0; i < len(attrs); i += 2 {
		if attrs[i] == "errno" {
			errnos++
		}
	}
	message := Describe(err)
	if HTTPStatus(err) != 503 || attributeMap(attrs)["error_code"] != "database_unreachable" || errnos > 1 ||
		!strings.HasPrefix(message, "cannot connect to PostgreSQL") || strings.Contains(message, "private") {
		t.Fatalf("status %d, attrs %v, message %q", HTTPStatus(err), attrs, message)
	}
}

func TestFatalRendersFatalLevel(t *testing.T) {
	var out bytes.Buffer
	if err := ConfigureLogging(&out, "ERROR"); err != nil {
		t.Fatal(err)
	}
	Fatal(context.Background(), "process_failed", fault.Wrap("config.rate_limit", fault.New("configuration", "invalid_rate_limit", "POCKETMARK_RATE_LIMIT must be an integer")))
	r := records(t, &out)
	if len(r) != 1 || r[0]["level"] != "FATAL" || r[0]["event"] != "process_failed" || r[0]["operation"] != "config.rate_limit" ||
		r[0]["msg"] != "Process failed: POCKETMARK_RATE_LIMIT must be an integer" {
		t.Fatalf("fatal record: %v", r)
	}
}

func TestClientErrorsWarnOnlyInsideRequests(t *testing.T) {
	invalid := fault.Invalid("title is too long")
	for _, tc := range []struct {
		name  string
		ctx   context.Context
		level string
	}{
		{"request", context.WithValue(context.Background(), failureKey{}, &requestFailure{}), "WARN"},
		{"background", context.Background(), "ERROR"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var out bytes.Buffer
			ctx := context.WithValue(tc.ctx, loggerKey{}, testObserver(&out).logger)
			Error(ctx, "request_failed", invalid)
			r := records(t, &out)
			if len(r) != 1 || r[0]["level"] != tc.level || r[0]["msg"] != "Request failed: title is too long" {
				t.Fatalf("record: %v", r)
			}
		})
	}
}

func TestLoggedMessagesNeverCopyRawErrorText(t *testing.T) {
	var out bytes.Buffer
	ctx := context.WithValue(context.Background(), loggerKey{}, testObserver(&out).logger)
	Error(ctx, "dav_upload_failed", &url.Error{Op: "Put", URL: "https://private-host/private-path", Err: errors.New("private-text")})
	if strings.Contains(out.String(), "private-") {
		t.Fatalf("raw error text leaked: %s", out.String())
	}
}

func TestCaptureCanceledDuringSaveIsInfo(t *testing.T) {
	var logs bytes.Buffer
	ctx, cancel := context.WithCancel(context.Background())
	_, finish := testObserver(&logs).Capture(ctx, 7)
	cancel()
	finish(nil, fmt.Errorf("save: %w", context.Canceled))
	r := records(t, &logs)
	if len(r) != 1 || r[0]["level"] != "INFO" || r[0]["outcome"] != "canceled" {
		t.Fatalf("capture: %v", r)
	}
}
