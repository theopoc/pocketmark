package store

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"pocketmark/internal/fault"
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

func (s *Store) SaveAsset(ctx context.Context, a Asset, src io.Reader) (Asset, error) {
	if a.LinkID <= 0 || len(a.Name) == 0 || len(a.Name) > 240 || strings.ContainsAny(a.Name, "\r\n\x00/\\") {
		return a, fault.Invalid("invalid attachment name or bookmark")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return a, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, "SELECT id FROM links WHERE id=$1 FOR UPDATE", a.LinkID); err != nil {
		return a, err
	}
	var count int
	if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM assets WHERE link_id=$1`, a.LinkID).Scan(&count); err != nil {
		return a, err
	}
	if count >= 32 {
		return a, fault.Invalid("a bookmark can have at most 32 attachments")
	}
	a, err = insertAsset(ctx, tx, a, src, "attachment")
	if err != nil {
		return a, err
	}
	return a, tx.Commit()
}

// insertAsset writes metadata and bounded chunks inside the caller's transaction.
// It never commits: standalone files must commit their bookmark and bytes together.
func insertAsset(ctx context.Context, tx *sql.Tx, a Asset, src io.Reader, noun string) (Asset, error) {
	a.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	err := tx.QueryRowContext(ctx, `INSERT INTO assets(link_id,name,media_type,kind,created_at) VALUES($1,$2,$3,$4,$5) RETURNING id`, a.LinkID, a.Name, a.MediaType, a.Kind, a.CreatedAt).Scan(&a.ID)
	if err != nil {
		return a, err
	}
	buf := make([]byte, assetChunkSize)
	for ordinal := 0; ; ordinal++ {
		n, readErr := io.ReadFull(src, buf)
		if n > 0 {
			a.Size += int64(n)
			if a.Size > MaxAssetSize {
				return a, fault.Invalid(noun + " exceeds 20 MiB")
			}
			if _, err = tx.ExecContext(ctx, `INSERT INTO asset_chunks VALUES($1,$2,$3)`, a.ID, ordinal, buf[:n]); err != nil {
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
		return a, fault.Invalid("empty " + noun)
	}
	if _, err = tx.ExecContext(ctx, `UPDATE assets SET size=$1 WHERE id=$2`, a.Size, a.ID); err != nil {
		return a, err
	}
	return a, nil
}

func (s *Store) Assets(ctx context.Context, linkID int64) ([]Asset, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id,link_id,name,media_type,kind,size,created_at FROM assets WHERE link_id=$1 ORDER BY id DESC`, linkID)
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
	err := s.db.QueryRowContext(ctx, `SELECT id,link_id,name,media_type,kind,size,created_at FROM assets WHERE id=$1`, assetID).Scan(&a.ID, &a.LinkID, &a.Name, &a.MediaType, &a.Kind, &a.Size, &a.CreatedAt)
	return a, err
}
func (s *Store) WriteAsset(ctx context.Context, assetID int64, dst io.Writer) error {
	a, err := s.Asset(ctx, assetID)
	if err != nil {
		return err
	}
	// Release the database connection before every potentially slow network
	// write, otherwise a download could block all requests and capture jobs.
	remaining := a.Size
	for ordinal := 0; remaining > 0; ordinal++ {
		var data []byte
		if err = s.db.QueryRowContext(ctx, `SELECT data FROM asset_chunks WHERE asset_id=$1 AND ordinal=$2`, assetID, ordinal).Scan(&data); err != nil {
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
	r, err := s.db.ExecContext(ctx, `DELETE FROM assets WHERE id=$1`, assetID)
	return affected(r, err)
}
