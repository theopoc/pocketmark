package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// MFAState never contains an unencrypted TOTP secret.
type MFAState struct {
	Secret     []byte
	Generation int64
}

var ErrMFAChanged = errors.New("authentication state changed or proof was already used")

func initMFA(ctx context.Context, tx *sql.Tx) error {
	var existed int
	if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_schema WHERE type='table' AND name='mfa'").Scan(&existed); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS mfa(
 id INTEGER PRIMARY KEY CHECK(id=1), secret BLOB NOT NULL DEFAULT X'',
 generation INTEGER NOT NULL DEFAULT 0, last_counter INTEGER NOT NULL DEFAULT -1,
 restored INTEGER NOT NULL DEFAULT 0 CHECK(restored IN (0,1)));
 INSERT OR IGNORE INTO mfa(id) VALUES(1);
 CREATE TABLE IF NOT EXISTS mfa_recovery(hash TEXT PRIMARY KEY);`); err != nil {
		return err
	}
	if existed == 0 {
		// Sessions created by an older version never verified a second factor.
		if _, err := tx.ExecContext(ctx, "DELETE FROM sessions"); err != nil {
			return err
		}
	}
	// Only new native backup copies have this marker; the live database does not.
	_, err := tx.ExecContext(ctx, `DELETE FROM mfa_recovery WHERE EXISTS(SELECT 1 FROM mfa WHERE id=1 AND restored=1);
 UPDATE mfa SET last_counter=MAX(last_counter,unixepoch()/30+1),restored=0 WHERE id=1 AND restored=1`)
	return err
}

func (s *Store) MFA(ctx context.Context) (MFAState, error) {
	var state MFAState
	err := s.db.QueryRowContext(ctx, "SELECT secret,generation FROM mfa WHERE id=1").Scan(&state.Secret, &state.Generation)
	return state, err
}

// consumeFactorTx consumes a TOTP counter or a recovery code exactly once.
// The account salt and MFA generation bind a proof to the state it verified.
func consumeFactorTx(ctx context.Context, tx *sql.Tx, salt string, generation, counter int64, recoveryHash string) error {
	var currentSalt string
	var currentGeneration int64
	var enabled int
	if err := tx.QueryRowContext(ctx, `SELECT account.salt,mfa.generation,length(mfa.secret)>0
 FROM account JOIN mfa ON mfa.id=1 WHERE account.id=1`).Scan(&currentSalt, &currentGeneration, &enabled); err != nil {
		return err
	}
	if currentSalt != salt || currentGeneration != generation || enabled == 0 {
		return ErrMFAChanged
	}
	var result sql.Result
	var err error
	if recoveryHash != "" {
		result, err = tx.ExecContext(ctx, "DELETE FROM mfa_recovery WHERE hash=?", recoveryHash)
	} else if counter >= 0 {
		result, err = tx.ExecContext(ctx, "UPDATE mfa SET last_counter=? WHERE id=1 AND generation=? AND last_counter<?", counter, generation, counter)
	} else {
		return ErrMFAChanged
	}
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil || n != 1 {
		return ErrMFAChanged
	}
	return nil
}

// SignInMFA atomically consumes the proof and creates the session.
func (s *Store) SignInMFA(ctx context.Context, salt string, generation, counter int64, recoveryHash, sessionHash string, expires time.Time, device string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = consumeFactorTx(ctx, tx, salt, generation, counter, recoveryHash); err != nil {
		return err
	}
	if err = insertSessionTx(ctx, tx, salt, sessionHash, expires, device, recoveryHash != ""); err != nil {
		return err
	}
	return tx.Commit()
}

// AuthorizeMFAChange consumes a fresh factor. A recent recovery-code sign-in
// grants replacement authorization until the change is successfully committed.
func (s *Store) AuthorizeMFAChange(ctx context.Context, salt string, generation, counter int64, recoveryHash, sessionHash string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var one int
	if err = tx.QueryRowContext(ctx, "SELECT 1 FROM sessions WHERE hash=? AND "+liveSession, sessionHash).Scan(&one); err != nil {
		return ErrMFAChanged
	}
	if counter < 0 && recoveryHash == "" {
		err = tx.QueryRowContext(ctx, `SELECT 1 FROM sessions WHERE hash=? AND recovery_until>unixepoch()
 AND EXISTS(SELECT 1 FROM account WHERE id=1 AND salt=?)
		 AND EXISTS(SELECT 1 FROM mfa WHERE id=1 AND generation=? AND length(secret)>0)`, sessionHash, salt, generation).Scan(&one)
		if err != nil {
			return ErrMFAChanged
		}
	} else if err = consumeFactorTx(ctx, tx, salt, generation, counter, recoveryHash); err != nil {
		return err
	}
	return tx.Commit()
}

func insertRecoveryCodes(ctx context.Context, tx *sql.Tx, hashes []string) error {
	if _, err := tx.ExecContext(ctx, "DELETE FROM mfa_recovery"); err != nil {
		return err
	}
	for _, hash := range hashes {
		if _, err := tx.ExecContext(ctx, "INSERT INTO mfa_recovery(hash) VALUES(?)", hash); err != nil {
			return err
		}
	}
	return nil
}

// ActivateMFA replaces the factor and recovery codes in one transaction. An
// initial enrollment creates a session; a replacement keeps only its session.
func (s *Store) ActivateMFA(ctx context.Context, salt string, generation, counter int64, encrypted []byte, hashes []string, keepSession, newSession string, expires time.Time, device string, recoveryGrant bool) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var currentSalt string
	var currentGeneration int64
	var enabled int
	if err = tx.QueryRowContext(ctx, `SELECT account.salt,mfa.generation,length(mfa.secret)>0
 FROM account JOIN mfa ON mfa.id=1 WHERE account.id=1`).Scan(&currentSalt, &currentGeneration, &enabled); err != nil {
		return err
	}
	if currentSalt != salt || currentGeneration != generation || (keepSession == "" && enabled != 0) || (keepSession != "" && enabled == 0) {
		return ErrMFAChanged
	}
	if keepSession != "" {
		var one int
		if err = tx.QueryRowContext(ctx, "SELECT 1 FROM sessions WHERE hash=? AND "+liveSession, keepSession).Scan(&one); err != nil {
			return ErrMFAChanged
		}
	}
	if recoveryGrant {
		r, e := tx.ExecContext(ctx, "UPDATE sessions SET recovery_until=0 WHERE hash=? AND recovery_until>unixepoch() AND "+liveSession, keepSession)
		if e != nil {
			return e
		}
		n, e := r.RowsAffected()
		if e != nil || n != 1 {
			return ErrMFAChanged
		}
	}
	if _, err = tx.ExecContext(ctx, "UPDATE mfa SET secret=?,generation=generation+1,last_counter=? WHERE id=1", encrypted, counter); err != nil {
		return err
	}
	if err = insertRecoveryCodes(ctx, tx, hashes); err != nil {
		return err
	}
	if keepSession == "" {
		if _, err = tx.ExecContext(ctx, "DELETE FROM sessions"); err != nil {
			return err
		}
		if err = insertSessionTx(ctx, tx, salt, newSession, expires, device, false); err != nil {
			return err
		}
	} else {
		if _, err = tx.ExecContext(ctx, "DELETE FROM sessions WHERE hash!=?", keepSession); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "UPDATE sessions SET recovery_until=0,confirmed_at=unixepoch() WHERE hash=?", keepSession); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) ReplaceRecoveryCodes(ctx context.Context, salt string, generation int64, sessionHash string, hashes []string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var one int
	if err = tx.QueryRowContext(ctx, `SELECT 1 FROM sessions WHERE hash=? AND `+liveSession+`
 AND EXISTS(SELECT 1 FROM account WHERE id=1 AND salt=?)
 AND EXISTS(SELECT 1 FROM mfa WHERE id=1 AND generation=? AND length(secret)>0)`, sessionHash, salt, generation).Scan(&one); err != nil {
		return ErrMFAChanged
	}
	if err = insertRecoveryCodes(ctx, tx, hashes); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) ResetMFA(ctx context.Context) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `UPDATE mfa SET secret=X'',generation=generation+1,last_counter=-1 WHERE id=1;
 DELETE FROM mfa_recovery; DELETE FROM sessions`); err != nil {
		return err
	}
	return tx.Commit()
}
