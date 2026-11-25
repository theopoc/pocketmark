package store

import (
	"errors"
	"os/exec"
	"strings"
	"testing"

	"pocketmark/internal/fault"
)

func TestPgDumpFailureSelectsStaticMessage(t *testing.T) {
	for _, tc := range []struct {
		stderr, code string
	}{
		{"pg_dump: error: aborting because of server version mismatch\npg_dump: detail: server version: 18.1; pg_dump version: 16.4 (private-host)", "pg_dump_version_mismatch"},
		{`pg_dump: error: connection to server at "private-host" failed: FATAL:  password authentication failed for user "private-user"`, "pg_dump_authentication_failed"},
		{`pg_dump: error: connection to server at "private-host" (10.0.0.1), port 5432 failed: Connection refused`, "pg_dump_connection_failed"},
		{"pg_dump: error: query failed: ERROR:  permission denied for table private_table", "pg_dump_permission_denied"},
		{"private unexpected output", "pg_dump_failed"},
	} {
		err := pgDumpFailure(errors.New("private-cause"), []byte(tc.stderr))
		var app *fault.Error
		if !errors.As(err, &app) || app.Code != tc.code {
			t.Fatalf("%q: got %v", tc.stderr, err)
		}
		if strings.Contains(err.Error(), "private") {
			t.Fatalf("pg_dump output leaked into %q", err.Error())
		}
	}
	missing := pgDumpFailure(&exec.Error{Name: "pg_dump", Err: exec.ErrNotFound}, nil)
	if !errors.Is(missing, exec.ErrNotFound) || missing.Error() != "pg_dump is not installed or not in PATH" {
		t.Fatalf("missing pg_dump: %v", missing)
	}
}

func TestTailBufferKeepsLastBytes(t *testing.T) {
	var b tailBuffer
	b.Write([]byte(strings.Repeat("a", 5000)))
	b.Write([]byte("end"))
	if len(b.b) != 4096 || !strings.HasSuffix(string(b.b), "end") {
		t.Fatalf("tail buffer: %d bytes", len(b.b))
	}
}
