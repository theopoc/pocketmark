package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"pocketmark/internal/backup"
)

// ResetMFAWithBackupRecovery performs the offline reset with the current server secret.
func (s *Store) ResetMFAWithBackupRecovery(ctx context.Context, serverSecret string) (bool, error) {
	tx, err := s.beginAccountChange(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	if err = resetMFATx(ctx, tx); err != nil {
		return false, err
	}
	paused, err := recoverBackupSettings(ctx, tx, serverSecret)
	if err != nil {
		return false, err
	}
	if err = tx.Commit(); err != nil {
		return false, err
	}
	return paused, nil
}

// Recovery uses the secret that the next server process will use. Preserve
// the draft and the resolved settings independently when either can be opened.
func recoverBackupSettings(ctx context.Context, tx *sql.Tx, serverSecret string) (bool, error) {
	var draftJSON, effectiveJSON, draftSecret, effectiveSecret []byte
	err := tx.QueryRowContext(ctx, `SELECT config,effective_config,credentials,effective_credentials
		FROM backup_settings WHERE id=1 FOR UPDATE`).Scan(&draftJSON, &effectiveJSON, &draftSecret, &effectiveSecret)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	readable := func(raw, sealed []byte) (bool, error) {
		var cfg backup.Config
		if err := json.Unmarshal(raw, &cfg); err != nil {
			return false, err
		}
		_, err := backup.Open(serverSecret, sealed, cfg.Binding())
		return err == nil, nil
	}
	keepDraft, err := readable(draftJSON, draftSecret)
	if err != nil {
		return false, err
	}
	keepEffective, err := readable(effectiveJSON, effectiveSecret)
	if err != nil {
		return false, err
	}
	if keepDraft && keepEffective {
		return false, nil
	}
	_, err = tx.ExecContext(ctx, `UPDATE backup_settings SET revision=gen_random_uuid(),
		credentials=CASE WHEN $1 THEN credentials ELSE ''::bytea END,
		effective_credentials=CASE WHEN $2 THEN effective_credentials ELSE ''::bytea END,
		config=jsonb_set(config,'{Enabled}','false'),
		effective_config=jsonb_set(effective_config,'{Enabled}','false'),
		next_at=NULL,missed_at=NULL WHERE id=1`, keepDraft, keepEffective)
	return err == nil, err
}
