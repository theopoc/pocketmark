package store

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"time"
)

const (
	aiCredentialLock = 1678904020
	aiSettingsLock   = 1678904021
)

func readAIEnvelope(ctx context.Context, db executor) ([]byte, error) {
	var envelope []byte
	// Read one extra byte to let the provider detect a damaged oversized value.
	err := db.QueryRowContext(ctx, "SELECT substr(envelope,1,262145) FROM ai_tag_credentials WHERE id=1").Scan(&envelope)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return envelope, err
}

func (s *Store) ReadAITagCredentials(ctx context.Context) ([]byte, error) {
	readCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return readAIEnvelope(readCtx, s.db)
}

func (s *Store) tryAILock(ctx context.Context, key int64) (*sql.Conn, error) {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return nil, err
	}
	var locked bool
	if err = conn.QueryRowContext(ctx, "SELECT pg_try_advisory_lock($1)", key).Scan(&locked); err != nil {
		// The server may have acquired the lock before the client lost its reply.
		conn.Raw(func(any) error { return driver.ErrBadConn })
		conn.Close()
		return nil, err
	}
	if !locked {
		conn.Close()
		return nil, nil
	}
	return conn, nil
}

func releaseAILock(conn *sql.Conn, key int64) {
	defer conn.Close()
	release, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	var released bool
	if err := conn.QueryRowContext(release, "SELECT pg_advisory_unlock($1)", key).Scan(&released); err != nil || !released {
		conn.Raw(func(any) error { return driver.ErrBadConn })
	}
}

// TryAITagSettings serializes owner mutations, including their provider calls,
// across replicas. Credential refresh can still acquire its own lock.
func (s *Store) TryAITagSettings(ctx context.Context, fn func()) (bool, error) {
	attempt, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	conn, err := s.tryAILock(attempt, aiSettingsLock)
	if err != nil {
		if errors.Is(attempt.Err(), context.DeadlineExceeded) && ctx.Err() == nil {
			return false, nil
		}
		return false, err
	}
	if conn == nil {
		return false, nil
	}
	defer releaseAILock(conn, aiSettingsLock)
	fn()
	return true, nil
}

// All replicas serialize token rotation on the same PostgreSQL session lock.
// One connection holds the lock during an OAuth exchange; waiting callers
// release theirs between attempts, leaving the pool available to other work.
func (s *Store) UpdateAITagCredentials(ctx context.Context, update func([]byte, func([]byte) error) error) error {
	wait, cancel := context.WithTimeout(ctx, 65*time.Second)
	defer cancel()
	var conn *sql.Conn
	for {
		var err error
		conn, err = s.tryAILock(wait, aiCredentialLock)
		if err != nil {
			return err
		}
		if conn != nil {
			break
		}
		select {
		case <-wait.Done():
			return wait.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
	defer releaseAILock(conn, aiCredentialLock)
	envelope, err := readAIEnvelope(ctx, conn)
	if err != nil {
		return err
	}
	return update(envelope, func(next []byte) error {
		// The remote may already have consumed the authorization code or rotated
		// a refresh token. Commit each change even if later steps or the owner's
		// HTTP request fail, and do not send secrets back through error text.
		persist, done := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer done()
		if next == nil {
			_, err := conn.ExecContext(persist, "DELETE FROM ai_tag_credentials WHERE id=1")
			return err
		}
		_, err := conn.ExecContext(persist, `INSERT INTO ai_tag_credentials(id,envelope) VALUES(1,$1)
			ON CONFLICT(id) DO UPDATE SET envelope=EXCLUDED.envelope`, next)
		return err
	})
}
