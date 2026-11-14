package store

import (
	"context"
	"database/sql"
	"errors"
	"pocketmark/internal/fault"
	"time"
	"unicode/utf8"
)

// insertSessionTx keeps at most 32 sessions and rejects a credential change
// racing sign-in. The caller consumes MFA proof in the same transaction.
func insertSessionTx(ctx context.Context, tx *sql.Tx, salt, hash string, expires time.Time, label string, recovery bool) error {
	if len(label) > 256 {
		label = label[:256]
		for !utf8.ValidString(label) {
			label = label[:len(label)-1]
		}
	}
	var current string
	if err := tx.QueryRowContext(ctx, "SELECT salt FROM account WHERE id=1").Scan(&current); err != nil {
		return err
	}
	if current != salt {
		return ErrMFAChanged
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM sessions WHERE expires_at<=$1", time.Now().Unix()); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM sessions WHERE id NOT IN (SELECT id FROM sessions ORDER BY id DESC LIMIT 31)"); err != nil {
		return err
	}
	recoveryUntil := int64(0)
	if recovery {
		recoveryUntil = time.Now().Add(5 * time.Minute).Unix()
	}
	_, err := tx.ExecContext(ctx, "INSERT INTO sessions(hash,expires_at,created_at,last_used_at,confirmed_at,idle_minutes,device,recovery_until) VALUES($1,$2,epoch_seconds(),epoch_seconds(),epoch_seconds(),1440,$3,$4)", hash, expires.Unix(), label, recoveryUntil)
	return err
}

const liveSession = "expires_at>epoch_seconds() AND (idle_minutes=0 OR last_used_at>epoch_seconds()-idle_minutes*60)"

// CheckAndTouchSession distinguishes expired credentials from failed storage.
func (s *Store) CheckAndTouchSession(ctx context.Context, hash string) (bool, error) {
	r, err := s.db.ExecContext(ctx, "UPDATE sessions SET last_used_at=epoch_seconds() WHERE hash=$1 AND "+liveSession, hash)
	if err != nil {
		return false, fault.Wrap("session.touch", err)
	}
	n, err := r.RowsAffected()
	return n == 1, fault.Wrap("session.touch", err)
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
	rows, err := s.db.QueryContext(ctx, "SELECT id,created_at,last_used_at,expires_at,idle_minutes,device,hash=$1 FROM sessions WHERE "+liveSession+" ORDER BY id DESC", current)
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

func (s *Store) CheckSessionConfirmed(ctx context.Context, hash string) (bool, error) {
	var one int
	err := s.db.QueryRowContext(ctx, "SELECT 1 FROM sessions WHERE hash=$1 AND "+liveSession+" AND confirmed_at>epoch_seconds()-300", hash).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, fault.Wrap("session.confirmation", err)
}

func (s *Store) ConfirmSession(ctx context.Context, hash, salt string) error {
	r, err := s.db.ExecContext(ctx, "UPDATE sessions SET confirmed_at=epoch_seconds() WHERE hash=$1 AND "+liveSession+" AND EXISTS(SELECT 1 FROM account WHERE salt=$2)", hash, salt)
	return affected(r, err)
}

func (s *Store) SetSessionIdleTimeout(ctx context.Context, hash string, minutes int) error {
	r, err := s.db.ExecContext(ctx, "UPDATE sessions SET idle_minutes=$1 WHERE hash=$2 AND "+liveSession, minutes, hash)
	return affected(r, err)
}

func (s *Store) DeleteSession(ctx context.Context, id int64) error {
	r, err := s.db.ExecContext(ctx, "DELETE FROM sessions WHERE id=$1", id)
	return affected(r, err)
}

func (s *Store) DeleteOtherSessions(ctx context.Context, hash string) error {
	if hash == "" {
		return sql.ErrNoRows
	}
	_, err := s.db.ExecContext(ctx, "DELETE FROM sessions WHERE hash!=$1", hash)
	return err
}

func (s *Store) RevokeSession(ctx context.Context, hash string) error {
	_, err := s.db.ExecContext(ctx, "DELETE FROM sessions WHERE hash=$1", hash)
	return err
}
