package store

import (
	"context"
	"errors"
)

// SaveThumbnail replaces the disk-backed cache only for the captured URL. A URL
// edit or deletion while capture was running must never resurrect stale bytes.
func (s *Store) SaveThumbnail(ctx context.Context, l Link, data []byte) error {
	if len(data) > 512<<10 {
		return errors.New("thumbnail exceeds 512 KiB")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, "DELETE FROM thumbnails WHERE link_id=? AND EXISTS(SELECT 1 FROM links WHERE id=? AND url=?)", l.ID, l.ID, l.URL); err != nil {
		return err
	}
	if len(data) > 0 {
		_, err = tx.ExecContext(ctx, "INSERT INTO thumbnails(link_id,data) SELECT id,? FROM links WHERE id=? AND url=? AND status='ready'", data, l.ID, l.URL)
	}
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) Thumbnail(ctx context.Context, id int64) ([]byte, error) {
	var data []byte
	err := s.db.QueryRowContext(ctx, "SELECT data FROM thumbnails WHERE link_id=?", id).Scan(&data)
	return data, err
}
