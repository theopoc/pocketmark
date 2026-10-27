package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// CreateSession persists only a credential digest, keeping at most 32 sessions.
// The salt comparison prevents a login racing a password change from issuing a
// new session based on the old password. All pruning and insertion is atomic.
func (s *Store) CreateSession(ctx context.Context, salt, hash string, expires time.Time, device ...string) error {
	label := ""
	if len(device) > 0 {
		label = device[0]
	}
	if len(label) > 256 {
		label = label[:256]
	}
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
	if _, err = tx.ExecContext(ctx, "INSERT INTO sessions(hash,expires_at,created_at,last_used_at,confirmed_at,idle_minutes,device) VALUES(?,?,unixepoch(),unixepoch(),unixepoch(),1440,?)", hash, expires.Unix(), label); err != nil {
		return err
	}
	return tx.Commit()
}

const liveSession = "expires_at>unixepoch() AND (idle_minutes=0 OR last_used_at>unixepoch()-idle_minutes*60)"

func (s *Store) SessionValid(ctx context.Context, hash string) bool {
	var one int
	return s.db.QueryRowContext(ctx, "SELECT 1 FROM sessions WHERE hash=? AND "+liveSession, hash).Scan(&one) == nil
}

// A conditional write prevents expired sessions from being revived by activity.
func (s *Store) TouchSession(ctx context.Context, hash string) bool {
	r, err := s.db.ExecContext(ctx, "UPDATE sessions SET last_used_at=unixepoch() WHERE hash=? AND "+liveSession, hash)
	if err != nil {
		return false
	}
	n, err := r.RowsAffected()
	return err == nil && n == 1
}

type Session struct {
	ID                 int64  `json:"id"`
	CreatedAt          int64  `json:"createdAt"`
	LastUsedAt         int64  `json:"lastUsedAt"`
	ExpiresAt          int64  `json:"expiresAt"`
	IdleTimeoutMinutes int    `json:"idleTimeoutMinutes"`
	Device             string `json:"device"`
	Current            bool   `json:"current"`
}

func (s *Store) Sessions(ctx context.Context, current string) ([]Session, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT id,created_at,last_used_at,expires_at,idle_minutes,device,hash=? FROM sessions WHERE "+liveSession+" ORDER BY id DESC", current)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	sessions := []Session{}
	for rows.Next() {
		var session Session
		if err = rows.Scan(&session.ID, &session.CreatedAt, &session.LastUsedAt, &session.ExpiresAt, &session.IdleTimeoutMinutes, &session.Device, &session.Current); err != nil {
			return nil, err
		}
		sessions = append(sessions, session)
	}
	return sessions, rows.Err()
}

func (s *Store) SessionConfirmed(ctx context.Context, hash string) bool {
	var one int
	return s.db.QueryRowContext(ctx, "SELECT 1 FROM sessions WHERE hash=? AND "+liveSession+" AND confirmed_at>unixepoch()-300", hash).Scan(&one) == nil
}

func (s *Store) ConfirmSession(ctx context.Context, hash, salt string) error {
	r, err := s.db.ExecContext(ctx, "UPDATE sessions SET confirmed_at=unixepoch() WHERE hash=? AND "+liveSession+" AND EXISTS(SELECT 1 FROM account WHERE salt=?)", hash, salt)
	return affected(r, err)
}

func (s *Store) SetSessionIdleTimeout(ctx context.Context, hash string, minutes int) error {
	r, err := s.db.ExecContext(ctx, "UPDATE sessions SET idle_minutes=? WHERE hash=? AND "+liveSession, minutes, hash)
	return affected(r, err)
}

func (s *Store) DeleteSession(ctx context.Context, id int64) error {
	r, err := s.db.ExecContext(ctx, "DELETE FROM sessions WHERE id=?", id)
	return affected(r, err)
}

func (s *Store) DeleteOtherSessions(ctx context.Context, hash string) error {
	if hash == "" {
		return sql.ErrNoRows
	}
	_, err := s.db.ExecContext(ctx, "DELETE FROM sessions WHERE hash!=?", hash)
	return err
}

func (s *Store) RevokeSession(ctx context.Context, hash string) error {
	_, err := s.db.ExecContext(ctx, "DELETE FROM sessions WHERE hash=?", hash)
	return err
}
