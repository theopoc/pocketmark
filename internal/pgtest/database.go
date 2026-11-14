// Package pgtest provides isolated databases for integration tests.
package pgtest

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"
)

// URL returns a database unique to the test's temporary path. Reopening the
// same path preserves its state for restart tests. Credentials stay in env.
func URL(t testing.TB, path string) string {
	t.Helper()
	raw := os.Getenv("POCKETMARK_TEST_DATABASE_URL")
	if raw == "" {
		t.Fatal("set POCKETMARK_TEST_DATABASE_URL to a disposable PostgreSQL cluster with CREATEDB privileges")
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") {
		t.Fatal("invalid test database URL")
	}
	sum := sha256.Sum256([]byte(path))
	name := fmt.Sprintf("pocketmark_test_%x", sum[:12])
	db, err := sql.Open("pgx", raw)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var exists bool
	if err = db.QueryRow("SELECT EXISTS(SELECT FROM pg_database WHERE datname=$1)", name).Scan(&exists); err != nil {
		t.Fatal(err)
	}
	if !exists {
		if _, err = db.Exec("CREATE DATABASE " + name + " TEMPLATE template0"); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			admin, err := sql.Open("pgx", raw)
			if err != nil {
				t.Error(err)
				return
			}
			defer admin.Close()
			if _, err = admin.ExecContext(context.Background(), "DROP DATABASE "+name+" WITH (FORCE)"); err != nil {
				t.Error(err)
			}
		})
	}
	u.Path = "/" + name
	return u.String()
}

// Directory returns a shared local work directory for each logical store.
func Directory(path string) string { return filepath.Dir(path) }

// Restore imports the native SQL snapshot into a fresh, dedicated test database.
func Restore(t testing.TB, path string) string {
	t.Helper()
	target := URL(t, path)
	cmd := exec.Command("psql", "-X", "-q", "--single-transaction", "-v", "ON_ERROR_STOP=1", "-d", target, "-f", path)
	if result, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("restore failed: %v: %s", err, result)
	}
	return target
}

// Migrate constructs a private SQLite 1.3.4 fixture and runs the shipped
// offline importer against the same PostgreSQL cluster used by the server.
func Migrate(t testing.TB, path, inserts string) {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	scripts := filepath.Join(filepath.Dir(file), "..", "..", "scripts")
	source := filepath.Join(t.TempDir(), "pocketmark.db")
	cmd := exec.Command("python3", "-c", `import pathlib, sqlite3, sys
with sqlite3.connect(sys.argv[1]) as db:
    db.executescript(pathlib.Path(sys.argv[2]).read_text())
    db.executescript(sys.stdin.read())`, source, filepath.Join(scripts, "testdata", "sqlite_v1_3_4.sql"))
	cmd.Stdin = strings.NewReader(inserts)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("SQLite fixture: %v: %s", err, output)
	}
	cmd = exec.Command("python3", filepath.Join(scripts, "migrate_sqlite.py"), source)
	target, err := url.Parse(URL(t, path))
	if err != nil {
		t.Fatal(err)
	}
	host := target.Hostname()
	if host == "" {
		host = target.Query().Get("host")
	}
	cmd.Env = append(os.Environ(), "PGDATABASE="+strings.TrimPrefix(target.Path, "/"), "PGUSER="+target.User.Username(), "PGHOST="+host)
	if port := target.Port(); port != "" {
		cmd.Env = append(cmd.Env, "PGPORT="+port)
	}
	if password, ok := target.User.Password(); ok {
		cmd.Env = append(cmd.Env, "PGPASSWORD="+password)
	}
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("migration: %v: %s", err, output)
	}
}
