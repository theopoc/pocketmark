package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"pocketmark/internal/backup"
)

type BackupNotification struct {
	ID, Stage   string
	Finished    time.Time
	LastSuccess int64
	Verified    bool
	Config      backup.Config
	Credentials []byte
}

// Telegram has no idempotency key. Persist the claim before sending so another
// replica cannot duplicate an alert after a crash or an ambiguous HTTP response.
func (s *Store) ClaimBackupNotification(ctx context.Context) (*BackupNotification, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `WITH lost AS (
		DELETE FROM backup_notifications WHERE claimed_at < now()-interval '1 minute' RETURNING id
	), recorded AS (
		UPDATE backup_runs SET notification='unknown' FROM lost WHERE backup_runs.id=lost.id RETURNING 1
	) INSERT INTO backup_metrics(name,value) SELECT 'notification_unknown_total',count(*) FROM recorded HAVING count(*)>0
	ON CONFLICT(name) DO UPDATE SET value=backup_metrics.value+excluded.value`); err != nil {
		return nil, err
	}
	var item BackupNotification
	var raw []byte
	err = tx.QueryRowContext(ctx, `WITH next AS (
		SELECT n.id FROM backup_notifications n JOIN backup_runs r ON r.id=n.id
		WHERE n.claimed_at IS NULL ORDER BY r.finished,n.id LIMIT 1 FOR UPDATE OF n SKIP LOCKED
	), claimed AS (
		UPDATE backup_notifications n SET claimed_at=now() FROM next WHERE n.id=next.id RETURNING n.*
	) SELECT c.id,c.config,c.credentials,r.stage,r.finished,r.verified_at IS NOT NULL,c.last_success
	FROM claimed c JOIN backup_runs r ON r.id=c.id`).Scan(&item.ID, &raw, &item.Credentials, &item.Stage, &item.Finished, &item.Verified, &item.LastSuccess)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, tx.Commit()
	}
	if err != nil {
		return nil, err
	}
	if err = json.Unmarshal(raw, &item.Config); err != nil {
		return nil, err
	}
	return &item, tx.Commit()
}

func (s *Store) CompleteBackupNotification(ctx context.Context, id string, sent bool) error {
	status := "failed"
	if sent {
		status = "sent"
	}
	_, err := s.db.ExecContext(ctx, `WITH done AS (
		DELETE FROM backup_notifications WHERE id=$1 AND claimed_at IS NOT NULL RETURNING id
	), recorded AS (
		UPDATE backup_runs SET notification=$2 FROM done WHERE backup_runs.id=done.id RETURNING 1
	) INSERT INTO backup_metrics(name,value) SELECT $3,count(*) FROM recorded HAVING count(*)>0
	ON CONFLICT(name) DO UPDATE SET value=backup_metrics.value+excluded.value`, id, status, "notification_"+status+"_total")
	return err
}
