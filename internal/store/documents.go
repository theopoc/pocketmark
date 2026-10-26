package store

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"net/url"
	"os"
	"time"

	"github.com/mattn/go-sqlite3"
)

var (
	ErrHTMLAssetNotFound = errors.New("HTML attachment not found")
	ErrReaderTooLarge    = errors.New("rich reader accepts HTML up to 2 MiB; download the larger archive")
	ErrNoReaderDocument  = errors.New("capture or upload an HTML page first")
)

func (s *Store) TemporaryFile(pattern string) (*os.File, error) {
	return os.CreateTemp(s.directory, pattern)
}

// Snapshot copies a stable WAL read view in bounded page batches. Its two
// temporary connections have small caches and leave the application's sole
// connection available. Ephemeral login sessions are scrubbed from the copy.
// The caller owns the completed file; failures remove it.
func (s *Store) Snapshot(ctx context.Context) (*os.File, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	f, err := s.TemporaryFile(".backup-*.db")
	if err != nil {
		return nil, err
	}
	path := f.Name()
	if err = f.Close(); err != nil {
		os.Remove(path)
		return nil, err
	}
	err = snapshotDatabase(ctx, s.path, path)
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

func snapshotDatabase(ctx context.Context, source, target string) error {
	open := func(path, mode string) (*sql.DB, error) {
		u := url.URL{Scheme: "file", Path: path}
		db, err := sql.Open("pocketmark-sqlite3", u.String()+"?mode="+mode+"&_cache_size=-2048&_busy_timeout=1000")
		if err == nil {
			db.SetMaxOpenConns(1)
		}
		return db, err
	}
	src, err := open(source, "ro")
	if err != nil {
		return err
	}
	defer src.Close()
	reader, err := src.Conn(ctx)
	if err != nil {
		return err
	}
	defer reader.Close()
	if _, err = reader.ExecContext(ctx, "PRAGMA mmap_size=0"); err != nil {
		return err
	}
	view, err := reader.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return err
	}
	defer view.Rollback()
	// Pin the read version so concurrent writes cannot restart the backup.
	var tables int
	if err = view.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_schema").Scan(&tables); err != nil {
		return err
	}
	var pageSize int
	if err = view.QueryRowContext(ctx, "PRAGMA page_size").Scan(&pageSize); err != nil {
		return err
	}
	dst, err := open(target, "rw")
	if err != nil {
		return err
	}
	defer dst.Close()
	writer, err := dst.Conn(ctx)
	if err != nil {
		return err
	}
	defer writer.Close()
	if _, err = writer.ExecContext(ctx, "PRAGMA mmap_size=0; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL"); err != nil {
		return err
	}
	spill, err := os.OpenFile(target, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer spill.Close()
	return reader.Raw(func(source any) error {
		return writer.Raw(func(target any) (err error) {
			backup, err := target.(*sqlite3.SQLiteConn).Backup("main", source.(*sqlite3.SQLiteConn), "main")
			if err != nil {
				return err
			}
			defer func() { err = errors.Join(err, backup.Finish()) }()
			remaining := -1
			syncedPages := 0
			for {
				if err := ctx.Err(); err != nil {
					return err
				}
				done, err := backup.Step(max(1, (1<<20)/pageSize))
				if err != nil || done {
					return err
				}
				next := backup.Remaining()
				copied := backup.PageCount() - next
				if copied-syncedPages >= max(1, (8<<20)/pageSize) {
					// A small SQLite cache alone does not bound dirty kernel
					// pages. Flush spilled pages before they fill a small cgroup
					// under concurrent reads. This private file is not published
					// until the backup commits successfully.
					if err := spill.Sync(); err != nil {
						return err
					}
					syncedPages = copied
				}
				if next == remaining {
					// The driver treats SQLITE_BUSY/LOCKED as unfinished work.
					select {
					case <-ctx.Done():
						return ctx.Err()
					case <-time.After(10 * time.Millisecond):
					}
				}
				remaining = next
			}
		})
	})
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
