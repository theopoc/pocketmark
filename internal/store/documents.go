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
)

var (
	ErrHTMLAssetNotFound = errors.New("HTML attachment not found")
	ErrReaderTooLarge    = errors.New("rich reader accepts HTML up to 2 MiB; download the larger archive")
	ErrNoReaderDocument  = errors.New("capture or upload an HTML page first")
)

func (s *Store) TemporaryFile(pattern string) (*os.File, error) {
	return os.CreateTemp(s.directory, pattern)
}

// Snapshot writes a consistent logical dump of the dedicated application database.
// pg_dump opens its own snapshot, leaving the application pool available.
func (s *Store) Snapshot(ctx context.Context) (*os.File, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	f, err := s.TemporaryFile(".backup-*.sql")
	if err != nil {
		return nil, err
	}
	success := false
	defer func() {
		if !success {
			f.Close()
			os.Remove(f.Name())
		}
	}()
	// libpq accepts a connection URI as --dbname. Keep credentials out of argv.
	u, err := url.Parse(s.databaseURL)
	if err != nil {
		return nil, errors.New("invalid database configuration")
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
		"--exclude-table-data=*.sessions", "--exclude-table-data=*.mfa_recovery", "--dbname="+u.String())
	cmd.Env = os.Environ()
	if user != "" {
		cmd.Env = append(cmd.Env, "PGUSER="+user)
	}
	if hasPassword {
		cmd.Env = append(cmd.Env, "PGPASSWORD="+password)
	}
	cmd.Stdout = f
	if err = cmd.Run(); err != nil {
		return nil, fmt.Errorf("PostgreSQL backup: %w", err)
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
	_, err := s.db.ExecContext(ctx, `UPDATE links SET content=$1,title=CASE WHEN title=url AND $2<>'' THEN $3 ELSE title END, description=CASE WHEN description='' THEN $4 ELSE description END,status='ready',error='',updated_at=$5 WHERE id=$6 AND url=$7`, content, title, title, description, time.Now().UTC().Format(time.RFC3339Nano), id, url)
	return err
}

func (s *Store) Archive(ctx context.Context, id int64) ([]byte, error) {
	var body []byte
	err := s.db.QueryRowContext(ctx, "SELECT archive FROM links WHERE id=$1 AND archive IS NOT NULL", id).Scan(&body)
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
