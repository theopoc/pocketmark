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

//go:embed migrations/003_session_addresses.sql
var sessionAddressSchema string

//go:embed migrations/004_backup.sql
var backupSchema string

//go:embed migrations/005_ai_tagging.sql
var aiTagSchema string

//go:embed migrations/006_reader_archive.sql
var readerArchiveSchema string

//go:embed migrations/007_ai_provider.sql
var aiProviderSchema string

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
		fallthrough
	case 2:
		if _, err = tx.ExecContext(ctx, sessionAddressSchema); err != nil {
			return fmt.Errorf("migrate session addresses: %w", err)
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO pocketmark_migrations VALUES(3)"); err != nil {
			return err
		}
		fallthrough
	case 3:
		if _, err = tx.ExecContext(ctx, backupSchema); err != nil {
			return fmt.Errorf("migrate scheduled backups: %w", err)
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO pocketmark_migrations VALUES(4)"); err != nil {
			return err
		}
		fallthrough
	case 4:
		if _, err = tx.ExecContext(ctx, aiTagSchema); err != nil {
			return fmt.Errorf("migrate AI tagging: %w", err)
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO pocketmark_migrations VALUES(5)"); err != nil {
			return err
		}
		fallthrough
	case 5:
		if _, err = tx.ExecContext(ctx, readerArchiveSchema); err != nil {
			return fmt.Errorf("migrate article reading copies: %w", err)
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO pocketmark_migrations VALUES(6)"); err != nil {
			return err
		}
		fallthrough
	case 6:
		if _, err = tx.ExecContext(ctx, aiProviderSchema); err != nil {
			return fmt.Errorf("migrate AI tagging provider: %w", err)
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO pocketmark_migrations VALUES(7)"); err != nil {
			return err
		}
	case 7:
	default:
		return fmt.Errorf("unsupported Pocketmark schema version %d", version)
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO ai_tag_settings(id) VALUES(1) ON CONFLICT DO NOTHING;
DELETE FROM mfa_challenges WHERE EXISTS(SELECT 1 FROM mfa WHERE restored=1);
DELETE FROM mfa_recovery WHERE EXISTS(SELECT 1 FROM mfa WHERE restored=1);
UPDATE mfa SET last_counter=greatest(last_counter,epoch_seconds()/30+1),restored=0 WHERE restored=1`); err != nil {
		return err
	}
	return tx.Commit()
}
