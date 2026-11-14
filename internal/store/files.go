package store

import (
	"context"
	"io"
	"pocketmark/internal/fault"
	"strings"
)

// CreateFile commits a document record and its chunked payload together. A
// failed, interrupted, or oversized upload leaves neither metadata nor bytes.
func (s *Store) CreateFile(ctx context.Context, l Link, a Asset, src io.Reader) (int64, Asset, error) {
	if !IsFileURL(l.URL) {
		return 0, a, fault.Invalid("invalid file identifier")
	}
	if len(a.Name) == 0 || len(a.Name) > 240 || strings.ContainsAny(a.Name, "\r\n\x00/\\") {
		return 0, a, fault.Invalid("invalid file name")
	}
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		return 0, a, e
	}
	defer tx.Rollback()
	id, e := Insert(ctx, tx, l)
	if e != nil {
		return 0, a, e
	}
	a.LinkID = id
	a, e = insertAsset(ctx, tx, a, src, "file")
	if e != nil {
		return 0, a, e
	}
	if l.Content != "" {
		if len(l.Content) > 256<<10 {
			return 0, a, fault.Invalid("indexed text exceeds 256 KiB")
		}
		if _, e = tx.ExecContext(ctx, "UPDATE links SET content=$1 WHERE id=$2", l.Content, id); e != nil {
			return 0, a, e
		}
	}
	return id, a, tx.Commit()
}
