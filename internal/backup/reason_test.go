package backup

import (
	"context"
	"os/exec"
	"testing"

	"github.com/minio/minio-go/v7"
	"pocketmark/internal/fault"
)

func TestReasonExplainsBackupFailures(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		code string
		want string
	}{
		{"bucket", minio.ErrorResponse{Code: "NoSuchBucket", StatusCode: 404, Message: "private-message", BucketName: "private-bucket"}, "NoSuchBucket", "the S3 bucket does not exist (HTTP 404)"},
		{"unknown s3", minio.ErrorResponse{Code: "PrivateCode", StatusCode: 409, Message: "private-message"}, "s3_error", "S3 request failed (HTTP 409 Conflict)"},
		{"pg_dump", fault.Cause("backup", "pg_dump_version_mismatch", "pg_dump is older than the PostgreSQL server", &exec.ExitError{}), "pg_dump_version_mismatch", "pg_dump is older than the PostgreSQL server"},
		{"checksum", ErrChecksum, "checksum_mismatch", "uploaded backup checksum does not match the local archive"},
		{"canceled pg_dump", fault.Cause("backup", "pg_dump_failed", "pg_dump could not run", context.Canceled), "cancelled", "pg_dump could not run: operation canceled"},
		{"missing tool", &exec.Error{Name: "pg_dump", Err: exec.ErrNotFound}, "pg_dump_missing", "pg_dump is not installed or not in PATH"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if code, _, _ := Diagnosis(tc.err); code != tc.code {
				t.Fatalf("Diagnosis = %q, want %q", code, tc.code)
			}
			if got := Reason(tc.err); got != tc.want {
				t.Fatalf("Reason = %q, want %q", got, tc.want)
			}
		})
	}
}
