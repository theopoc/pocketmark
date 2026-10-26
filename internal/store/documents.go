package store

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"net/url"
	"os"
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

// Snapshot includes committed WAL data but excludes ephemeral login sessions.
// The caller owns closing and removing
// the returned file; every failed snapshot is removed here.
func (s *Store) Snapshot(ctx context.Context) (*os.File, error) {
	f, err := s.TemporaryFile(".backup-*.db")
	if err != nil {
		return nil, err
	}
	path := f.Name()
	if err = f.Close(); err != nil {
		os.Remove(path)
		return nil, err
	}
	if err = os.Remove(path); err != nil {
		return nil, err
	}
	_, err = s.db.ExecContext(ctx, "VACUUM INTO ?", path)
	if err == nil {
		err = os.Chmod(path, 0600)
	}
	if err == nil {
		// Scrub only the standalone copy. Restoring a backup must not resurrect
		// cookies revoked after it was taken, nor sign out the live server.
		u := url.URL{Scheme: "file", Path: path}
		var backup *sql.DB
		backup, err = sql.Open("pocketmark-sqlite3", u.String()+"?_journal_mode=DELETE&_cache_size=-2048")
		if err == nil {
			backup.SetMaxOpenConns(1)
			_, err = backup.ExecContext(ctx, "DELETE FROM sessions")
			closeErr := backup.Close()
			if err == nil {
				err = closeErr
			}
		}
	}
	if err == nil {
		f, err = os.Open(path)
	}
	if err != nil {
		os.Remove(path)
		return nil, err
	}
	return f, nil
}

// IndexDocument preserves personal metadata and ignores a stale upload after a
// URL edit. The saved attachment remains intact if indexing fails separately.
func (s *Store) IndexDocument(ctx context.Context, id int64, url, title, description, content string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE links SET content=?,title=CASE WHEN title=url AND ?<>'' THEN ? ELSE title END, description=CASE WHEN description='' THEN ? ELSE description END,status='ready',error='',updated_at=? WHERE id=? AND url=?`, content, title, title, description, time.Now().UTC().Format(time.RFC3339Nano), id, url)
	return err
}

func (s *Store) Archive(ctx context.Context, id int64) ([]byte, error) {
	var body []byte
	err := s.db.QueryRowContext(ctx, "SELECT archive FROM links WHERE id=? AND archive IS NOT NULL", id).Scan(&body)
	return body, err
}

// ReaderDocument owns HTML selection, ownership checks and the reader's bound.
// nil selects the newest HTML attachment, then falls back to automatic capture.
func (s *Store) ReaderDocument(ctx context.Context, id int64, assetID *int64) ([]byte, error) {
	if assetID == nil {
		var latest int64
		if err := s.db.QueryRowContext(ctx, `SELECT id FROM assets WHERE link_id=? AND media_type='text/html' AND kind='html' ORDER BY id DESC LIMIT 1`, id).Scan(&latest); err == nil {
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
	err := s.db.QueryRowContext(ctx, "SELECT archive FROM links WHERE id=?", id).Scan(&body)
	if err != nil {
		return nil, err
	}
	if len(body) == 0 {
		return nil, ErrNoReaderDocument
	}
	return body, nil
}
