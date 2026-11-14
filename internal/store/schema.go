package store

import (
	"context"
	_ "embed"
	"fmt"
)

//go:embed migrations/001_initial.sql
var initialSchema string

//go:embed migrations/002_mfa_challenges.sql
var challengeSchema string

func (s *Store) initializeSchema(ctx context.Context) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// Serialize first startup and future migrations across application replicas.
	if _, err = tx.ExecContext(ctx, "SELECT pg_advisory_xact_lock(1678904017)"); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "CREATE TABLE IF NOT EXISTS pocketmark_migrations(version integer PRIMARY KEY)"); err != nil {
		return err
	}
	var version int
	if err = tx.QueryRowContext(ctx, "SELECT COALESCE(max(version),0) FROM pocketmark_migrations").Scan(&version); err != nil {
		return err
	}
	switch version {
	case 0:
		if _, err = tx.ExecContext(ctx, initialSchema); err != nil {
			return fmt.Errorf("initialize PostgreSQL schema: %w", err)
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO pocketmark_migrations VALUES(1)"); err != nil {
			return err
		}
		fallthrough
	case 1:
		if _, err = tx.ExecContext(ctx, challengeSchema); err != nil {
			return fmt.Errorf("migrate MFA challenges: %w", err)
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO pocketmark_migrations VALUES(2)"); err != nil {
			return err
		}
	case 2:
	default:
		return fmt.Errorf("unsupported Pocketmark schema version %d", version)
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM mfa_challenges WHERE EXISTS(SELECT 1 FROM mfa WHERE restored=1);
DELETE FROM mfa_recovery WHERE EXISTS(SELECT 1 FROM mfa WHERE restored=1);
UPDATE mfa SET last_counter=greatest(last_counter,epoch_seconds()/30+1),restored=0 WHERE restored=1`); err != nil {
		return err
	}
	return tx.Commit()
}
