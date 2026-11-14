package store

import (
	"context"
)

func (s *Store) Thumbnail(ctx context.Context, id int64) ([]byte, error) {
	var data []byte
	err := s.db.QueryRowContext(ctx, "SELECT data FROM thumbnails WHERE link_id=$1", id).Scan(&data)
	return data, err
}
