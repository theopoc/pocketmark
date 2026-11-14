package store

import "context"

type Stats struct {
	Links       int `json:"links"`
	Pending     int `json:"pending"`
	Failed      int `json:"failed"`
	Collections int `json:"collections"`
}

func (s *Store) Ping(ctx context.Context) error { return s.db.PingContext(ctx) }

// FindURL uses the same metadata projection as List and never loads a capture.
func (s *Store) FindURL(ctx context.Context, url string) (Link, error) {
	return scan(s.db.QueryRowContext(ctx, "SELECT "+columns+" FROM links l WHERE url_digest(l.url)=url_digest($1) AND l.url=$1", url), false)
}

func (s *Store) Stats(ctx context.Context) (Stats, error) {
	var stats Stats
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*),COUNT(*) FILTER (WHERE status IN ('pending','processing')),COUNT(*) FILTER (WHERE status='failed'),(SELECT COUNT(*) FROM collections) FROM links`).Scan(&stats.Links, &stats.Pending, &stats.Failed, &stats.Collections)
	return stats, err
}
