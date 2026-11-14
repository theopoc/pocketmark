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

func (s *Store) MFA(ctx context.Context) (MFAState, error) {
	var state MFAState
	err := s.db.QueryRowContext(ctx, "SELECT secret,generation FROM mfa WHERE id=1").Scan(&state.Secret, &state.Generation)
	return state, err
}

// Serialize changes to the personal account, its factors and session budget.
// The singleton exists even before enrollment. Each check after acquiring
// its lock observes the preceding transaction's commit at READ COMMITTED.
func (s *Store) beginAccountChange(ctx context.Context) (*sql.Tx, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, "SELECT id FROM mfa WHERE id=1 FOR UPDATE"); err != nil {
		tx.Rollback()
		return nil, err
	}
	return tx, nil
}

// consumeFactorTx consumes a TOTP counter or a recovery code exactly once.
// The account salt and MFA generation bind a proof to the state it verified.
func consumeFactorTx(ctx context.Context, tx *sql.Tx, salt string, generation, counter int64, recoveryHash string) error {
	var currentSalt string
	var currentGeneration int64
	var enabled bool
	if err := tx.QueryRowContext(ctx, `SELECT account.salt,mfa.generation,length(mfa.secret)>0
 FROM account JOIN mfa ON mfa.id=1 WHERE account.id=1`).Scan(&currentSalt, &currentGeneration, &enabled); err != nil {
		return err
	}
	if currentSalt != salt || currentGeneration != generation || !enabled {
		return ErrMFAChanged
	}
	var result sql.Result
	var err error
	if recoveryHash != "" {
		result, err = tx.ExecContext(ctx, "DELETE FROM mfa_recovery WHERE hash=$1", recoveryHash)
	} else if counter >= 0 {
		result, err = tx.ExecContext(ctx, "UPDATE mfa SET last_counter=$1 WHERE id=1 AND generation=$2 AND last_counter<$3", counter, generation, counter)
	} else {
		return ErrMFAChanged
	}
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return ErrMFAChanged
	}
	return nil
}

// SignInMFA atomically consumes the proof and creates the session.
func (s *Store) SignInMFA(ctx context.Context, digest, salt string, generation, counter int64, recoveryHash, sessionHash string, expires time.Time, device string) error {
	tx, err := s.beginAccountChange(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = consumeChallenge(ctx, tx, digest, salt, generation); err != nil {
		return err
	}
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
	tx, err := s.beginAccountChange(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var one int
	if err = tx.QueryRowContext(ctx, "SELECT 1 FROM sessions WHERE hash=$1 AND "+liveSession+" FOR UPDATE", sessionHash).Scan(&one); err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		return ErrMFAChanged
	}
	if counter < 0 && recoveryHash == "" {
		err = tx.QueryRowContext(ctx, `SELECT 1 FROM sessions WHERE hash=$1 AND recovery_until>epoch_seconds()
 AND EXISTS(SELECT 1 FROM account WHERE id=1 AND salt=$2)
		 AND EXISTS(SELECT 1 FROM mfa WHERE id=1 AND generation=$3 AND length(secret)>0) FOR UPDATE`, sessionHash, salt, generation).Scan(&one)
		if err != nil {
			if !errors.Is(err, sql.ErrNoRows) {
				return err
			}
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
		if _, err := tx.ExecContext(ctx, "INSERT INTO mfa_recovery(hash) VALUES($1)", hash); err != nil {
			return err
		}
	}
	return nil
}

// ActivateMFA replaces the factor and recovery codes in one transaction. An
// initial enrollment creates a session; a replacement keeps only its session.
func (s *Store) ActivateMFA(ctx context.Context, digest, salt string, generation, counter int64, encrypted []byte, hashes []string, keepSession, newSession string, expires time.Time, device string, recoveryGrant bool) error {
	tx, err := s.beginAccountChange(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = consumeChallenge(ctx, tx, digest, salt, generation); err != nil {
		return err
	}
	var currentSalt string
	var currentGeneration int64
	var enabled bool
	if err = tx.QueryRowContext(ctx, `SELECT account.salt,mfa.generation,length(mfa.secret)>0
 FROM account JOIN mfa ON mfa.id=1 WHERE account.id=1`).Scan(&currentSalt, &currentGeneration, &enabled); err != nil {
		return err
	}
	if currentSalt != salt || currentGeneration != generation || (keepSession == "" && enabled) || (keepSession != "" && !enabled) {
		return ErrMFAChanged
	}
	if keepSession != "" {
		var one int
		if err = tx.QueryRowContext(ctx, "SELECT 1 FROM sessions WHERE hash=$1 AND "+liveSession+" FOR UPDATE", keepSession).Scan(&one); err != nil {
			if !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			return ErrMFAChanged
		}
	}
	if recoveryGrant {
		r, e := tx.ExecContext(ctx, "UPDATE sessions SET recovery_until=0 WHERE hash=$1 AND recovery_until>epoch_seconds() AND "+liveSession, keepSession)
		if e != nil {
			return e
		}
		n, e := r.RowsAffected()
		if e != nil {
			return e
		}
		if n != 1 {
			return ErrMFAChanged
		}
	}
	if _, err = tx.ExecContext(ctx, "UPDATE mfa SET secret=$1,generation=generation+1,last_counter=$2 WHERE id=1", encrypted, counter); err != nil {
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
		if _, err = tx.ExecContext(ctx, "DELETE FROM sessions WHERE hash!=$1", keepSession); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "UPDATE sessions SET recovery_until=0,confirmed_at=epoch_seconds() WHERE hash=$1", keepSession); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) ReplaceRecoveryCodes(ctx context.Context, salt string, generation int64, sessionHash string, hashes []string) error {
	tx, err := s.beginAccountChange(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var one int
	if err = tx.QueryRowContext(ctx, `SELECT 1 FROM sessions WHERE hash=$1 AND `+liveSession+`
 AND EXISTS(SELECT 1 FROM account WHERE id=1 AND salt=$2)
 AND EXISTS(SELECT 1 FROM mfa WHERE id=1 AND generation=$3 AND length(secret)>0) FOR UPDATE`, sessionHash, salt, generation).Scan(&one); err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		return ErrMFAChanged
	}
	if err = insertRecoveryCodes(ctx, tx, hashes); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) ResetMFA(ctx context.Context) error {
	tx, err := s.beginAccountChange(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `UPDATE mfa SET secret=''::bytea,generation=generation+1,last_counter=-1,attempts=0,window_start='-infinity' WHERE id=1;
 DELETE FROM mfa_challenges;
 DELETE FROM mfa_recovery; DELETE FROM sessions`); err != nil {
		return err
	}
	return tx.Commit()
}
