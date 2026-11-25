package store

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"time"

	"pocketmark/internal/fault"
)

var (
	ErrHTMLAssetNotFound = errors.New("HTML attachment not found")
	ErrReaderTooLarge    = errors.New("rich reader accepts HTML up to 2 MiB; download the larger archive")
	ErrNoReaderDocument  = errors.New("capture or upload an HTML page first")
)

func (s *Store) TemporaryFile(pattern string) (*os.File, error) {
	return os.CreateTemp(s.directory, pattern)
}

// AnonymousFile lets the OS reclaim partial archives after a crash.
func (s *Store) AnonymousFile(pattern string) (*os.File, error) {
	f, e := s.TemporaryFile(pattern)
	if e != nil {
		return nil, e
	}
	if e = os.Remove(f.Name()); e != nil {
		f.Close()
		return nil, e
	}
	return f, nil
}
func (s *Store) BackupSnapshot(ctx context.Context) (*os.File, error) { return s.snapshot(ctx, true) }

// Snapshot writes a consistent logical dump of the dedicated application database.
// pg_dump opens its own snapshot, leaving the application pool available.
func (s *Store) Snapshot(ctx context.Context) (*os.File, error) {
	return s.snapshot(ctx, false)
}
func (s *Store) snapshot(ctx context.Context, anonymous bool) (*os.File, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	create := s.TemporaryFile
	if anonymous {
		create = s.AnonymousFile
	}
	f, err := create(".backup-*.sql")
	if err != nil {
		return nil, err
	}
	success := false
	defer func() {
		if !success {
			f.Close()
			if !anonymous {
				os.Remove(f.Name())
			}
		}
	}()
	// libpq accepts a connection URI as --dbname. Keep credentials out of argv.
	u, err := url.Parse(s.databaseURL)
	if err != nil {
		return nil, fault.New("configuration", "database_url_invalid", "POCKETMARK_DATABASE_URL is not a valid PostgreSQL connection URI")
	}
	password, hasPassword := u.User.Password()
	user := u.User.Username()
	u.User = nil
	query := u.Query()
	if query.Has("password") {
		password, hasPassword = query.Get("password"), true
		query.Del("password")
	}
	u.RawQuery = query.Encode()
	cmd := exec.CommandContext(ctx, "pg_dump", "--no-owner", "--no-acl", "--no-password",
		"--exclude-table-data=*.ai_tag_credentials", "--exclude-table-data=*.ai_tag_settings", "--exclude-table-data=*.ai_tag_jobs",
		"--exclude-table-data=*.backup_notifications", "--exclude-table-data=*.backup_settings", "--exclude-table-data=*.backup_runs", "--exclude-table-data=*.backup_objects", "--exclude-table-data=*.backup_pending", "--exclude-table-data=*.backup_metrics", "--exclude-table-data=*.mfa_challenges", "--exclude-table-data=*.sessions", "--exclude-table-data=*.mfa_recovery", "--dbname="+u.String())
	cmd.Env = os.Environ()
	if user != "" {
		cmd.Env = append(cmd.Env, "PGUSER="+user)
	}
	if hasPassword {
		cmd.Env = append(cmd.Env, "PGPASSWORD="+password)
	}
	cmd.Stdout = f
	stderr := &tailBuffer{}
	cmd.Stderr = stderr
	if err = cmd.Run(); err != nil {
		return nil, pgDumpFailure(err, stderr.b)
	}
	if _, err = f.WriteString("\nUPDATE public.mfa SET restored=1 WHERE id=1;\n"); err != nil {
		return nil, err
	}
	if _, err = f.Seek(0, 0); err != nil {
		return nil, err
	}
	success = true
	return f, nil
}

// IndexDocument preserves personal metadata and ignores a stale upload after a
// URL edit. The saved attachment remains intact if indexing fails separately.
func (s *Store) IndexDocument(ctx context.Context, id int64, url, title, description, content string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE links SET ai_private_title=ai_private_title OR (title=url AND $2<>''), ai_private_description=ai_private_description OR (description='' AND $4<>''), content=$1,title=CASE WHEN title=url AND $2<>'' THEN $3 ELSE title END, description=CASE WHEN description='' THEN $4 ELSE description END,status='ready',error='',updated_at=$5 WHERE id=$6 AND url=$7`, content, title, title, description, time.Now().UTC().Format(time.RFC3339Nano), id, url)
	return err
}

func (s *Store) Archive(ctx context.Context, id int64) ([]byte, error) {
	var body []byte
	err := s.db.QueryRowContext(ctx, "SELECT archive FROM links WHERE id=$1 AND archive IS NOT NULL", id).Scan(&body)
	return body, err
}

// ArticleArchive falls back to the original for legacy or text-only captures.
func (s *Store) ArticleArchive(ctx context.Context, id int64) ([]byte, error) {
	var body []byte
	err := s.db.QueryRowContext(ctx, "SELECT coalesce(reader_archive, archive) FROM links WHERE id=$1 AND archive IS NOT NULL", id).Scan(&body)
	return body, err
}

// ReaderDocument owns HTML selection, ownership checks and the reader's bound.
// nil selects the newest HTML attachment, then falls back to automatic capture.
func (s *Store) ReaderDocument(ctx context.Context, id int64, assetID *int64) ([]byte, error) {
	if assetID == nil {
		var latest int64
		if err := s.db.QueryRowContext(ctx, `SELECT id FROM assets WHERE link_id=$1 AND media_type='text/html' AND kind='html' ORDER BY id DESC LIMIT 1`, id).Scan(&latest); err == nil {
			assetID = &latest
		}
	}
	if assetID != nil {
		asset, err := s.Asset(ctx, *assetID)
		if err != nil || asset.LinkID != id || asset.MediaType != "text/html" {
			return nil, ErrHTMLAssetNotFound
		}
		if asset.Size > 2<<20 {
			return nil, ErrReaderTooLarge
		}
		var body bytes.Buffer
		if err = s.WriteAsset(ctx, asset.ID, &body); err != nil {
			return nil, err
		}
		return body.Bytes(), nil
	}
	var body []byte
	err := s.db.QueryRowContext(ctx, "SELECT archive FROM links WHERE id=$1", id).Scan(&body)
	if err != nil {
		return nil, err
	}
	if len(body) == 0 {
		return nil, ErrNoReaderDocument
	}
	return body, nil
}

// tailBuffer keeps the last 4 KiB of pg_dump diagnostics to classify a failure.
type tailBuffer struct{ b []byte }

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.b = append(t.b, p...)
	if len(t.b) > 4096 {
		t.b = append(t.b[:0], t.b[len(t.b)-4096:]...)
	}
	return len(p), nil
}

var pgDumpCauses = []struct{ match, code, message string }{
	{"server version mismatch", "pg_dump_version_mismatch", "pg_dump is older than the PostgreSQL server; install a pg_dump of the same major version or newer"},
	{"password authentication failed", "pg_dump_authentication_failed", "pg_dump could not authenticate to PostgreSQL; check the password in POCKETMARK_DATABASE_URL"},
	{"no password supplied", "pg_dump_authentication_failed", "pg_dump could not authenticate to PostgreSQL; POCKETMARK_DATABASE_URL has no password"},
	{"does not exist", "pg_dump_object_missing", "pg_dump could not find the database or role named in POCKETMARK_DATABASE_URL"},
	{"permission denied", "pg_dump_permission_denied", "pg_dump lacks permission to read a table; grant the role read access to the schema"},
	{"could not connect", "pg_dump_connection_failed", "pg_dump could not connect to PostgreSQL"},
	{"connection to server", "pg_dump_connection_failed", "pg_dump could not connect to PostgreSQL"},
	{"no space left on device", "pg_dump_disk_full", "pg_dump ran out of disk space"},
}

// pgDumpFailure selects a static message from pg_dump's diagnostics. The tool's
// output is matched only, never copied: it can name hosts, roles and objects.
func pgDumpFailure(err error, stderr []byte) error {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err // Cancellation and timeouts keep their own classification.
	}
	lower := bytes.ToLower(stderr)
	for _, cause := range pgDumpCauses {
		if bytes.Contains(lower, []byte(cause.match)) {
			return fault.Cause("backup", cause.code, cause.message, err)
		}
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return fault.Cause("backup", "pg_dump_failed", fmt.Sprintf("pg_dump exited with status %d", exit.ExitCode()), err)
	}
	if errors.Is(err, exec.ErrNotFound) {
		return fault.Cause("backup", "pg_dump_missing", "pg_dump is not installed or not in PATH", err)
	}
	return fault.Cause("backup", "pg_dump_failed", "pg_dump could not run", err)
}
