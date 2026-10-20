package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"io"
	"time"
)

const MaxDAVSize = 8 << 20

var ErrDAVLocked = errors.New("another client holds the synchronization lock")

type DAVFile struct {
	Size     int64
	ETag     string
	Modified time.Time
	Revision int64
	Owner    string
}

func (s *Store) InitDAV(ctx context.Context) error {
	_, e := s.DB.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS dav_revision(id INTEGER PRIMARY KEY CHECK(id=1),value INTEGER NOT NULL,modified INTEGER NOT NULL);
INSERT OR IGNORE INTO dav_revision VALUES(1,0,unixepoch());
CREATE TABLE IF NOT EXISTS dav_ids(id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,local_id INTEGER NOT NULL,position INTEGER NOT NULL DEFAULT 2147483647,UNIQUE(kind,local_id));
CREATE TABLE IF NOT EXISTS dav_files(name TEXT PRIMARY KEY,size INTEGER NOT NULL,etag TEXT NOT NULL,modified INTEGER NOT NULL,revision INTEGER NOT NULL,owner TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS dav_chunks(name TEXT NOT NULL REFERENCES dav_files(name) ON DELETE CASCADE,ordinal INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(name,ordinal));
CREATE TABLE IF NOT EXISTS dav_lock(id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT NOT NULL,modified INTEGER NOT NULL,revision INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS dav_observed(owner TEXT PRIMARY KEY,revision INTEGER NOT NULL);
CREATE TRIGGER IF NOT EXISTS dav_li AFTER INSERT ON links BEGIN UPDATE dav_revision SET value=value+1,modified=unixepoch() WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS dav_lu AFTER UPDATE OF url,title,description,collection_id ON links WHEN NEW.url IS NOT OLD.url OR NEW.title IS NOT OLD.title OR NEW.description IS NOT OLD.description OR NEW.collection_id IS NOT OLD.collection_id BEGIN UPDATE dav_revision SET value=value+1,modified=unixepoch() WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS dav_ld AFTER DELETE ON links BEGIN DELETE FROM dav_ids WHERE kind='bookmark' AND local_id=OLD.id;UPDATE dav_revision SET value=value+1,modified=unixepoch() WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS dav_ci AFTER INSERT ON collections BEGIN UPDATE dav_revision SET value=value+1,modified=unixepoch() WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS dav_cu AFTER UPDATE OF name,parent_id ON collections WHEN NEW.name IS NOT OLD.name OR NEW.parent_id IS NOT OLD.parent_id BEGIN UPDATE dav_revision SET value=value+1,modified=unixepoch() WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS dav_cd AFTER DELETE ON collections BEGIN DELETE FROM dav_ids WHERE kind='folder' AND local_id=OLD.id;UPDATE dav_revision SET value=value+1,modified=unixepoch() WHERE id=1; END;`)
	return e
}

func ensureDAVIDs(ctx context.Context, tx *sql.Tx) error {
	_, e := tx.ExecContext(ctx, `INSERT INTO dav_ids(kind,local_id) SELECT 'folder',id FROM collections WHERE NOT EXISTS(SELECT 1 FROM dav_ids WHERE kind='folder' AND local_id=collections.id) ORDER BY id;
INSERT INTO dav_ids(kind,local_id) SELECT 'bookmark',id FROM links WHERE (url LIKE 'http://%' OR url LIKE 'https://%') AND NOT EXISTS(SELECT 1 FROM dav_ids WHERE kind='bookmark' AND local_id=links.id) ORDER BY id;`)
	return e
}
func davRevision(ctx context.Context, tx *sql.Tx) (int64, int64, error) {
	var rev, modified int64
	e := tx.QueryRowContext(ctx, "SELECT value,modified FROM dav_revision WHERE id=1").Scan(&rev, &modified)
	return rev, modified, e
}
func davFile(ctx context.Context, tx *sql.Tx, name string) (DAVFile, error) {
	var f DAVFile
	var modified int64
	e := tx.QueryRowContext(ctx, "SELECT size,etag,modified,revision,owner FROM dav_files WHERE name=?", name).Scan(&f.Size, &f.ETag, &modified, &f.Revision, &f.Owner)
	f.Modified = time.Unix(modified, 0)
	return f, e
}
func writeDAVChunks(ctx context.Context, tx *sql.Tx, name string, w io.Writer) error {
	rows, e := tx.QueryContext(ctx, "SELECT data FROM dav_chunks WHERE name=? ORDER BY ordinal", name)
	if e != nil {
		return e
	}
	defer rows.Close()
	for rows.Next() {
		var b []byte
		if e = rows.Scan(&b); e != nil {
			return e
		}
		if _, e = w.Write(b); e != nil {
			return e
		}
	}
	return rows.Err()
}
func saveDAVFile(ctx context.Context, tx *sql.Tx, name, owner string, rev int64, r io.Reader) (DAVFile, error) {
	f := DAVFile{Owner: owner, Revision: rev, Modified: time.Now().UTC()}
	if _, e := tx.ExecContext(ctx, "DELETE FROM dav_files WHERE name=?", name); e != nil {
		return f, e
	}
	if _, e := tx.ExecContext(ctx, "INSERT INTO dav_files VALUES(?,0,'',?,?,?)", name, f.Modified.Unix(), rev, owner); e != nil {
		return f, e
	}
	buf := make([]byte, 64<<10)
	h := sha256.New()
	for i := 0; ; i++ {
		n, e := io.ReadFull(r, buf)
		if n > 0 {
			f.Size += int64(n)
			if f.Size > MaxDAVSize {
				return f, errors.New("XBEL exceeds 8 MiB")
			}
			h.Write(buf[:n])
			if _, e := tx.ExecContext(ctx, "INSERT INTO dav_chunks VALUES(?,?,?)", name, i, buf[:n]); e != nil {
				return f, e
			}
		}
		if e == io.EOF || e == io.ErrUnexpectedEOF {
			break
		}
		if e != nil {
			return f, e
		}
	}
	f.ETag = `"` + hex.EncodeToString(h.Sum(nil)) + `"`
	_, e := tx.ExecContext(ctx, "UPDATE dav_files SET size=?,etag=? WHERE name=?", f.Size, f.ETag, name)
	return f, e
}

// WriteDAVSnapshot stages into a caller-owned disk file under one transaction.
// Uploaded bytes remain exact until metadata changes; then canonical XML is regenerated.
func (s *Store) WriteDAVSnapshot(ctx context.Context, w io.Writer) (DAVFile, error) {
	if e := s.InitDAV(ctx); e != nil {
		return DAVFile{}, e
	}
	tx, e := s.DB.BeginTx(ctx, nil)
	if e != nil {
		return DAVFile{}, e
	}
	defer tx.Rollback()
	if e = ensureDAVIDs(ctx, tx); e != nil {
		return DAVFile{}, e
	}
	rev, modified, e := davRevision(ctx, tx)
	if e != nil {
		return DAVFile{}, e
	}
	if f, err := davFile(ctx, tx, "snapshot"); err == nil && f.Revision == rev {
		if e = writeDAVChunks(ctx, tx, "snapshot", w); e != nil {
			return f, e
		}
		return f, tx.Commit()
	}
	h := sha256.New()
	count := &davCountingWriter{w: io.MultiWriter(w, h)}
	if e = exportXBEL(ctx, tx, count); e != nil {
		return DAVFile{}, e
	}
	f := DAVFile{Size: count.n, ETag: `"` + hex.EncodeToString(h.Sum(nil)) + `"`, Modified: time.Unix(modified, 0), Revision: rev}
	return f, tx.Commit()
}

type davCountingWriter struct {
	w io.Writer
	n int64
}

func (w *davCountingWriter) Write(p []byte) (int, error) {
	if w.n+int64(len(p)) > MaxDAVSize {
		return 0, errors.New("XBEL exceeds 8 MiB")
	}
	n, e := w.w.Write(p)
	w.n += int64(n)
	return n, e
}

func checkDAVLease(ctx context.Context, tx *sql.Tx, owner string, checkRevision bool) error {
	var held string
	var modified, base int64
	e := tx.QueryRowContext(ctx, "SELECT owner,modified,revision FROM dav_lock WHERE id=1").Scan(&held, &modified, &base)
	if e == sql.ErrNoRows {
		return nil
	}
	if e != nil {
		return e
	}
	if time.Since(time.Unix(modified, 0)) >= 15*time.Minute {
		if checkRevision {
			return ErrSyncConflict
		}
		return nil
	}
	if held != owner {
		return ErrDAVLocked
	}
	if checkRevision {
		rev, _, e := davRevision(ctx, tx)
		if e != nil {
			return e
		}
		if base != rev {
			return ErrSyncConflict
		}
		var observed int64
		if tx.QueryRowContext(ctx, "SELECT revision FROM dav_observed WHERE owner=?", owner).Scan(&observed) != nil || observed != rev {
			return ErrSyncConflict
		}
	}
	return nil
}
func (s *Store) DAVLock(ctx context.Context, owner string, set bool) (time.Time, error) {
	tx, e := s.DB.BeginTx(ctx, nil)
	if e != nil {
		return time.Time{}, e
	}
	defer tx.Rollback()
	if e = checkDAVLease(ctx, tx, owner, false); e != nil {
		return time.Time{}, e
	}
	if !set {
		_, e = tx.ExecContext(ctx, "DELETE FROM dav_lock WHERE id=1;DELETE FROM dav_observed")
		if e != nil {
			return time.Time{}, e
		}
		return time.Time{}, tx.Commit()
	}
	var held string
	var modified, base int64
	e = tx.QueryRowContext(ctx, "SELECT owner,modified,revision FROM dav_lock WHERE id=1").Scan(&held, &modified, &base)
	if e != nil && e != sql.ErrNoRows {
		return time.Time{}, e
	}
	if e == sql.ErrNoRows || time.Since(time.Unix(modified, 0)) >= 15*time.Minute {
		if _, e = tx.ExecContext(ctx, "DELETE FROM dav_observed"); e != nil {
			return time.Time{}, e
		}
		base, _, e = davRevision(ctx, tx)
		if e != nil {
			return time.Time{}, e
		}
	}
	now := time.Now().UTC()
	_, e = tx.ExecContext(ctx, "INSERT INTO dav_lock VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,modified=excluded.modified,revision=excluded.revision", owner, now.Unix(), base)
	if e != nil {
		return now, e
	}
	return now, tx.Commit()
}
func (s *Store) DAVLockTime(ctx context.Context) (time.Time, error) {
	var modified int64
	e := s.DB.QueryRowContext(ctx, "SELECT modified FROM dav_lock WHERE id=1").Scan(&modified)
	if e == nil && time.Since(time.Unix(modified, 0)) >= 15*time.Minute {
		return time.Time{}, sql.ErrNoRows
	}
	return time.Unix(modified, 0), e
}

// A new or expired/reacquired lease requires a fresh GET before writing. This
// prevents a browser resuming after sleep from refreshing its lock then pushing
// an old cached tree over native edits made while its lease was expired.
func (s *Store) ConfirmDAVRead(ctx context.Context, owner string, revision int64) error {
	_, e := s.DB.ExecContext(ctx, "INSERT INTO dav_observed(owner,revision) SELECT ?,? WHERE EXISTS(SELECT 1 FROM dav_lock WHERE owner=?) ON CONFLICT(owner) DO UPDATE SET revision=excluded.revision", owner, revision, owner)
	return e
}
func (s *Store) StageDAV(ctx context.Context, owner string, r io.Reader) error {
	tx, e := s.DB.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if e = checkDAVLease(ctx, tx, owner, true); e != nil {
		return e
	}
	if f, e := davFile(ctx, tx, "temp"); e == nil && f.Owner != owner && time.Since(f.Modified) < 15*time.Minute {
		return ErrDAVLocked
	}
	rev, _, e := davRevision(ctx, tx)
	if e != nil {
		return e
	}
	if _, e = saveDAVFile(ctx, tx, "temp", owner, rev, r); e != nil {
		return e
	}
	return tx.Commit()
}
func (s *Store) WriteDAVTemp(ctx context.Context, owner string, w io.Writer) (DAVFile, error) {
	tx, e := s.DB.BeginTx(ctx, nil)
	if e != nil {
		return DAVFile{}, e
	}
	defer tx.Rollback()
	f, e := davFile(ctx, tx, "temp")
	if e != nil {
		return f, e
	}
	if f.Owner != owner {
		return f, ErrDAVLocked
	}
	if e = writeDAVChunks(ctx, tx, "temp", w); e != nil {
		return f, e
	}
	return f, tx.Commit()
}
func (s *Store) DeleteDAVTemp(ctx context.Context, owner string) error {
	_, e := s.DB.ExecContext(ctx, "DELETE FROM dav_files WHERE name='temp' AND owner=?", owner)
	return e
}

func (s *Store) ApplyDAV(ctx context.Context, owner string, r io.ReadSeeker, expected, tempETag string) error {
	root, e := readXBEL(r)
	if e != nil {
		return e
	}
	if _, e = r.Seek(0, io.SeekStart); e != nil {
		return e
	}
	tx, e := s.DB.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if e = ensureDAVIDs(ctx, tx); e != nil {
		return e
	}
	if e = checkDAVLease(ctx, tx, owner, true); e != nil {
		return e
	}
	rev, _, e := davRevision(ctx, tx)
	if e != nil {
		return e
	}
	if tempETag != "" {
		f, e := davFile(ctx, tx, "temp")
		if e != nil {
			return e
		}
		if f.Owner != owner {
			return ErrDAVLocked
		}
		if f.ETag != tempETag || f.Revision != rev {
			return ErrSyncConflict
		}
	}
	if expected != "" && expected != "*" {
		current := ""
		if f, e := davFile(ctx, tx, "snapshot"); e == nil && f.Revision == rev {
			current = f.ETag
		} else {
			h := sha256.New()
			if e = exportXBEL(ctx, tx, h); e != nil {
				return e
			}
			current = `"` + hex.EncodeToString(h.Sum(nil)) + `"`
		}
		if expected != current {
			return ErrSyncConflict
		}
	}
	if e = replaceXBELTree(ctx, tx, root); e != nil {
		return e
	}
	rev, _, e = davRevision(ctx, tx)
	if e != nil {
		return e
	}
	if _, e = saveDAVFile(ctx, tx, "snapshot", owner, rev, r); e != nil {
		return e
	}
	if _, e = tx.ExecContext(ctx, "DELETE FROM dav_files WHERE name='temp' AND owner=?;UPDATE dav_lock SET revision=? WHERE id=1 AND owner=?;UPDATE dav_observed SET revision=? WHERE owner=?", owner, rev, owner, rev, owner); e != nil {
		return e
	}
	return tx.Commit()
}
