package store

import (
	"context"
	"errors"
	"time"
)

// CreateSession persists only a credential digest, keeping at most 32 sessions.
// The salt comparison prevents a login racing a password change from issuing a
// new session based on the old password. All pruning and insertion is atomic.
func (s *Store) CreateSession(ctx context.Context, salt, hash string, expires time.Time) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var current string
	if err = tx.QueryRowContext(ctx, "SELECT salt FROM account WHERE id=1").Scan(&current); err != nil {
		return err
	}
	if current != salt {
		return errors.New("account changed during login")
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM sessions WHERE expires_at<=?", time.Now().Unix()); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM sessions WHERE id NOT IN (SELECT id FROM sessions ORDER BY id DESC LIMIT 31)"); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO sessions(hash,expires_at) VALUES(?,?)", hash, expires.Unix()); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) SessionValid(ctx context.Context, hash string) bool {
	var one int
	return s.db.QueryRowContext(ctx, "SELECT 1 FROM sessions WHERE hash=? AND expires_at>?", hash, time.Now().Unix()).Scan(&one) == nil
}

func (s *Store) RevokeSession(ctx context.Context, hash string) error {
	_, err := s.db.ExecContext(ctx, "DELETE FROM sessions WHERE hash=?", hash)
	return err
}
