package store

import (
	"context"
	"errors"
	"io"
	"strings"
	"time"
)

const MaxAssetSize = 20 << 20
const assetChunkSize = 64 << 10

type Asset struct {
	ID        int64  `json:"id"`
	LinkID    int64  `json:"linkId"`
	Name      string `json:"name"`
	MediaType string `json:"mediaType"`
	Kind      string `json:"kind"`
	Size      int64  `json:"size"`
	CreatedAt string `json:"createdAt"`
}

// InitAssets keeps large attachments in small rows, so neither uploads nor
// downloads allocate an entire document. Cascades make deletion atomic.
func (s *Store) InitAssets(ctx context.Context) error {
	_, err := s.DB.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS assets(
id INTEGER PRIMARY KEY, link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
name TEXT NOT NULL, media_type TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS assets_link ON assets(link_id,id);
CREATE TABLE IF NOT EXISTS asset_chunks(asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(asset_id,ordinal));`)
	return err
}

func (s *Store) SaveAsset(ctx context.Context, a Asset, src io.Reader) (Asset, error) {
	if a.LinkID <= 0 || len(a.Name) == 0 || len(a.Name) > 240 || strings.ContainsAny(a.Name, "\r\n\x00/\\") {
		return a, errors.New("invalid attachment name or bookmark")
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return a, err
	}
	defer tx.Rollback()
	var count int
	if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM assets WHERE link_id=?`, a.LinkID).Scan(&count); err != nil {
		return a, err
	}
	if count >= 32 {
		return a, errors.New("a bookmark can have at most 32 attachments")
	}
	a.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	result, err := tx.ExecContext(ctx, `INSERT INTO assets(link_id,name,media_type,kind,created_at) VALUES(?,?,?,?,?)`, a.LinkID, a.Name, a.MediaType, a.Kind, a.CreatedAt)
	if err != nil {
		return a, err
	}
	a.ID, err = result.LastInsertId()
	if err != nil {
		return a, err
	}
	buf := make([]byte, assetChunkSize)
	for ordinal := 0; ; ordinal++ {
		n, readErr := io.ReadFull(src, buf)
		if n > 0 {
			a.Size += int64(n)
			if a.Size > MaxAssetSize {
				return a, errors.New("attachment exceeds 20 MiB")
			}
			if _, err = tx.ExecContext(ctx, `INSERT INTO asset_chunks VALUES(?,?,?)`, a.ID, ordinal, buf[:n]); err != nil {
				return a, err
			}
		}
		if readErr == io.EOF || readErr == io.ErrUnexpectedEOF {
			break
		}
		if readErr != nil {
			return a, readErr
		}
	}
	if a.Size == 0 {
		return a, errors.New("empty attachment")
	}
	if _, err = tx.ExecContext(ctx, `UPDATE assets SET size=? WHERE id=?`, a.Size, a.ID); err != nil {
		return a, err
	}
	return a, tx.Commit()
}

func (s *Store) Assets(ctx context.Context, linkID int64) ([]Asset, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT id,link_id,name,media_type,kind,size,created_at FROM assets WHERE link_id=? ORDER BY id DESC`, linkID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Asset{}
	for rows.Next() {
		var a Asset
		if err = rows.Scan(&a.ID, &a.LinkID, &a.Name, &a.MediaType, &a.Kind, &a.Size, &a.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
func (s *Store) Asset(ctx context.Context, assetID int64) (Asset, error) {
	var a Asset
	err := s.DB.QueryRowContext(ctx, `SELECT id,link_id,name,media_type,kind,size,created_at FROM assets WHERE id=?`, assetID).Scan(&a.ID, &a.LinkID, &a.Name, &a.MediaType, &a.Kind, &a.Size, &a.CreatedAt)
	return a, err
}
func (s *Store) WriteAsset(ctx context.Context, assetID int64, dst io.Writer) error {
	a, err := s.Asset(ctx, assetID)
	if err != nil {
		return err
	}
	// Release the sole SQLite connection before every potentially slow network
	// write, otherwise a download could block all requests and capture jobs.
	remaining := a.Size
	for ordinal := 0; remaining > 0; ordinal++ {
		var data []byte
		if err = s.DB.QueryRowContext(ctx, `SELECT data FROM asset_chunks WHERE asset_id=? AND ordinal=?`, assetID, ordinal).Scan(&data); err != nil {
			return err
		}
		n, writeErr := dst.Write(data)
		if writeErr != nil {
			return writeErr
		}
		if n != len(data) {
			return io.ErrShortWrite
		}
		remaining -= int64(n)
		if remaining < 0 {
			return errors.New("attachment size does not match stored chunks")
		}
		if err = ctx.Err(); err != nil {
			return err
		}
	}
	return nil
}
func (s *Store) DeleteAsset(ctx context.Context, assetID int64) error {
	r, err := s.DB.ExecContext(ctx, `DELETE FROM assets WHERE id=?`, assetID)
	return affected(r, err)
}
