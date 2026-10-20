package store

import (
	"context"
	"errors"
	"io"
	"strings"
	"time"
)

// CreateFile commits a document record and its chunked payload together. A
// failed, interrupted, or oversized upload leaves neither metadata nor bytes.
func (s *Store) CreateFile(ctx context.Context, l Link, a Asset, src io.Reader) (int64, Asset, error) {
	if !IsFileURL(l.URL) {
		return 0, a, errors.New("invalid file identifier")
	}
	if len(a.Name) == 0 || len(a.Name) > 240 || strings.ContainsAny(a.Name, "\r\n\x00/\\") {
		return 0, a, errors.New("invalid file name")
	}
	tx, e := s.DB.BeginTx(ctx, nil)
	if e != nil {
		return 0, a, e
	}
	defer tx.Rollback()
	id, e := Insert(ctx, tx, l)
	if e != nil {
		return 0, a, e
	}
	a.LinkID = id
	a.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	result, e := tx.ExecContext(ctx, "INSERT INTO assets(link_id,name,media_type,kind,created_at) VALUES(?,?,?,?,?)", id, a.Name, a.MediaType, a.Kind, a.CreatedAt)
	if e != nil {
		return 0, a, e
	}
	a.ID, e = result.LastInsertId()
	if e != nil {
		return 0, a, e
	}
	buf := make([]byte, assetChunkSize)
	for ordinal := 0; ; ordinal++ {
		n, readErr := io.ReadFull(src, buf)
		if n > 0 {
			a.Size += int64(n)
			if a.Size > MaxAssetSize {
				return 0, a, errors.New("file exceeds 20 MiB")
			}
			if _, e = tx.ExecContext(ctx, "INSERT INTO asset_chunks VALUES(?,?,?)", a.ID, ordinal, buf[:n]); e != nil {
				return 0, a, e
			}
		}
		if readErr == io.EOF || readErr == io.ErrUnexpectedEOF {
			break
		}
		if readErr != nil {
			return 0, a, readErr
		}
	}
	if a.Size == 0 {
		return 0, a, errors.New("empty file")
	}
	if _, e = tx.ExecContext(ctx, "UPDATE assets SET size=? WHERE id=?", a.Size, a.ID); e != nil {
		return 0, a, e
	}
	if l.Content != "" {
		if len(l.Content) > 256<<10 {
			return 0, a, errors.New("indexed text exceeds 256 KiB")
		}
		if _, e = tx.ExecContext(ctx, "UPDATE links SET content=? WHERE id=?", l.Content, id); e != nil {
			return 0, a, e
		}
	}
	return id, a, tx.Commit()
}
