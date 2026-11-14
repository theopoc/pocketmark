package store

import (
	"context"
	"database/sql"
	"errors"
)

type MFAChallenge struct {
	Kind, Salt, Username, Session string
	Generation                    int64
	Secret                        []byte // Encrypted by the server; never the cookie or a plaintext TOTP seed.
	RecoveryGrant                 bool
}

var ErrMFALimit = errors.New("MFA limit reached")

func (s *Store) CreateMFAChallenge(ctx context.Context, digest string, c MFAChallenge) error {
	tx, err := s.beginAccountChange(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, "DELETE FROM mfa_challenges WHERE expires_at<=clock_timestamp()"); err != nil {
		return err
	}
	r, err := tx.ExecContext(ctx, `INSERT INTO mfa_challenges(digest,kind,salt,username,session_hash,generation,secret,recovery_grant)
 SELECT $1,$2,$3,$4,$5,$6,$7,$8 WHERE (SELECT count(*) FROM mfa_challenges)<32`, digest, c.Kind, c.Salt, c.Username, c.Session, c.Generation, c.Secret, c.RecoveryGrant)
	if err != nil {
		return err
	}
	n, err := r.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrMFALimit
	}
	return tx.Commit()
}

// ReserveMFAAttempt charges both windows before proof verification, even if the
// process dies. An empty digest charges only the account (factor management).
func (s *Store) ReserveMFAAttempt(ctx context.Context, digest string) (MFAChallenge, error) {
	var c MFAChallenge
	tx, err := s.beginAccountChange(ctx)
	if err != nil {
		return c, err
	}
	defer tx.Rollback()
	const reset = "window_start <= statement_timestamp() - interval '1 minute'"
	const charge = " SET attempts=CASE WHEN " + reset + " THEN 1 ELSE attempts+1 END, window_start=CASE WHEN " + reset + " THEN statement_timestamp() ELSE window_start END"
	if digest != "" {
		var allowed bool
		err = tx.QueryRowContext(ctx, "SELECT kind,salt,username,session_hash,generation,secret,recovery_grant,("+reset+" OR attempts<5) FROM mfa_challenges WHERE digest=$1 AND expires_at>clock_timestamp()", digest).Scan(&c.Kind, &c.Salt, &c.Username, &c.Session, &c.Generation, &c.Secret, &c.RecoveryGrant, &allowed)
		if err != nil {
			return c, err
		}
		if !allowed {
			return c, ErrMFALimit
		}
		if _, err = tx.ExecContext(ctx, "UPDATE mfa_challenges"+charge+" WHERE digest=$1", digest); err != nil {
			return c, err
		}
	}
	r, err := tx.ExecContext(ctx, "UPDATE mfa"+charge+" WHERE id=1 AND ("+reset+" OR attempts<10)")
	if err != nil {
		return c, err
	}
	n, err := r.RowsAffected()
	if err != nil {
		return c, err
	}
	if n == 0 {
		return c, ErrMFALimit
	}
	return c, tx.Commit()
}

// The first enrollment request picks the seed. Concurrent pods return the
// same encrypted value, even if they generated different candidates.
func (s *Store) EnrollmentSecret(ctx context.Context, digest string, candidate []byte) ([]byte, error) {
	var secret []byte
	err := s.db.QueryRowContext(ctx, `UPDATE mfa_challenges SET secret=COALESCE(secret,$2)
 WHERE digest=$1 AND kind='enroll' AND expires_at>clock_timestamp() RETURNING secret`, digest, candidate).Scan(&secret)
	return secret, err
}

func consumeChallenge(ctx context.Context, tx *sql.Tx, digest, salt string, generation int64) error {
	r, err := tx.ExecContext(ctx, "DELETE FROM mfa_challenges WHERE digest=$1 AND salt=$2 AND generation=$3 AND expires_at>clock_timestamp()", digest, salt, generation)
	if err != nil {
		return err
	}
	n, err := r.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return ErrMFAChanged
	}
	return nil
}
