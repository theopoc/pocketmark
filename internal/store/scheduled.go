package store

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"time"

	"pocketmark/internal/backup"
)

type BackupRun struct {
	ID, Trigger, Status, Stage string
	Requested, Started         time.Time
	Deadline, VerifiedAt       *time.Time
	Notification               string
	Finished                   *time.Time
	Attempt                    int
	Due                        time.Time
	Bytes, Total               int64
	Diagnostic                 map[string]any
	Timings                    map[string]int64
	Config                     backup.Config
	ObjectKey                  string
	Removed                    bool
}
type BackupJob struct {
	BackupRun
	conn     *sql.Conn
	Secret   []byte
	Instance string
}

var ErrBackupBusy = errors.New("another backup is active")

var ErrBackupChanged = errors.New("backup settings changed")

func (s *Store) BackupDraft(ctx context.Context) (c backup.Config, secret []byte, next *time.Time, revision string, err error) {
	var raw []byte
	err = s.db.QueryRowContext(ctx, "SELECT config,credentials,next_at,revision FROM backup_settings WHERE id=1").Scan(&raw, &secret, &next, &revision)
	if errors.Is(err, sql.ErrNoRows) {
		return backup.Default(), nil, nil, "", nil
	}
	if err == nil {
		err = json.Unmarshal(raw, &c)
	}
	return
}

func (s *Store) BackupConfig(ctx context.Context) (backup.Config, []byte, *time.Time, error) {
	c, secret, next, _, err := s.BackupDraft(ctx)
	return c, secret, next, err
}

func (s *Store) SaveBackup(ctx context.Context, c backup.Config, secret []byte) error {
	return s.SaveBackupSettings(ctx, c, secret, c, secret)
}

func (s *Store) SaveBackupSettings(ctx context.Context, draft backup.Config, draftSecret []byte, effective backup.Config, effectiveSecret []byte, expectedRevision ...string) error {
	draftJSON, err := json.Marshal(draft)
	if err != nil {
		return err
	}
	effectiveJSON, err := json.Marshal(effective)
	if err != nil {
		return err
	}
	var next *time.Time
	if effective.Enabled {
		times, err := effective.Upcoming(time.Now())
		if err != nil {
			return err
		}
		next = &times[0]
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// Serialize the initial insert as well as edits from separate replicas.
	if _, err = tx.ExecContext(ctx, "SELECT pg_advisory_xact_lock(1678904019)"); err != nil {
		return err
	}
	if len(expectedRevision) > 0 {
		var revision string
		err = tx.QueryRowContext(ctx, "SELECT revision FROM backup_settings WHERE id=1").Scan(&revision)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if revision != expectedRevision[0] {
			return ErrBackupChanged
		}
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO backup_settings(id,config,credentials,effective_config,effective_credentials,next_at)
		VALUES(1,$1,COALESCE($2,''::bytea),$3,COALESCE($4,''::bytea),$5)
		ON CONFLICT(id) DO UPDATE SET revision=gen_random_uuid(), config=excluded.config,credentials=excluded.credentials,
		  effective_config=excluded.effective_config,effective_credentials=excluded.effective_credentials,
		  missed_at=CASE WHEN excluded.next_at IS NOT NULL
		    AND backup_settings.effective_config->>'Cron'=excluded.effective_config->>'Cron'
		    AND backup_settings.effective_config->>'Zone'=excluded.effective_config->>'Zone'
		    THEN backup_settings.missed_at END,
		  next_at=CASE WHEN excluded.next_at IS NOT NULL AND backup_settings.next_at IS NOT NULL
		    AND backup_settings.effective_config->>'Cron'=excluded.effective_config->>'Cron'
		    AND backup_settings.effective_config->>'Zone'=excluded.effective_config->>'Zone'
		    THEN backup_settings.next_at ELSE excluded.next_at END`, draftJSON, draftSecret, effectiveJSON, effectiveSecret, next)
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) QueueBackup(ctx context.Context, trigger string, expectedRevision ...string) (string, error) {
	if trigger != "manual" {
		return "", errors.New("only manual backups can be requested")
	}
	var id string
	var revision *string
	if len(expectedRevision) > 0 {
		revision = &expectedRevision[0]
	}
	err := s.db.QueryRowContext(ctx, `WITH settings AS (
		  SELECT instance,effective_config,effective_credentials FROM backup_settings WHERE id=1 AND ($1::text IS NULL OR revision::text=$1) FOR UPDATE
		) INSERT INTO backup_runs(trigger,config,credentials,instance)
		SELECT 'manual',effective_config,effective_credentials,instance FROM settings
		ON CONFLICT(instance) WHERE trigger='manual' AND started IS NULL AND finished IS NULL
		DO UPDATE SET id=backup_runs.id RETURNING id`, revision).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		if revision != nil {
			return "", ErrBackupChanged
		}
		return "", ErrBackupBusy
	}
	return id, err
}

// ScheduleBackup consumes the next due occurrence only if this scheduler was up at that time.
func (s *Store) ScheduleBackup(ctx context.Context, since time.Time) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var raw, secret []byte
	var instance string
	var due, now time.Time
	var missed *time.Time
	err = tx.QueryRowContext(ctx, `SELECT effective_config,effective_credentials,instance,next_at,missed_at,now() FROM backup_settings
		WHERE id=1 AND next_at IS NOT NULL AND (next_at<=now() OR missed_at>$1) FOR UPDATE`, since).Scan(&raw, &secret, &instance, &due, &missed, &now)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	var c backup.Config
	if err = json.Unmarshal(raw, &c); err != nil {
		return err
	}
	// A replica starting just after a due time must not discard it on behalf of
	// another replica that was already online. The new replica advances the UI
	// cursor, but the older one may still consume that occurrence exactly once.
	if due.After(now) && missed != nil && missed.After(since) {
		due = *missed
	}
	// If next_at predates startup, compute the first occurrence strictly after startup.
	// A live occurrence can be due even if the persisted cursor was several days old.
	if !due.After(since) {
		previous := due
		missed = &previous
		times, err := c.Upcoming(since)
		if err != nil {
			return err
		}
		due = times[0]
	}
	next := due
	if !due.After(now) {
		missed = nil
		var overlaps bool
		err = tx.QueryRowContext(ctx, `SELECT EXISTS (SELECT FROM backup_runs WHERE instance=$1
		  AND (finished IS NULL OR (requested<=$2 AND finished>=$2 AND status<>'skipped')))`, instance, due).Scan(&overlaps)
		if err != nil {
			return err
		}
		if overlaps {
			_, err = tx.ExecContext(ctx, `INSERT INTO backup_runs(trigger,config,credentials,instance,requested,finished,status,stage,diagnostic,notification)
				VALUES('scheduled',$1,''::bytea,$2,$3,now(),'skipped','schedule','{"error_code":"overlap"}','not_required')`, raw, instance, due)
			if err == nil {
				err = incrementBackupMetric(ctx, tx, "skipped_total")
			}
			if err == nil {
				_, err = tx.ExecContext(ctx, pruneBackupRuns)
			}
		} else {
			deadline := due.Add(time.Duration(c.WindowMinutes) * time.Minute)
			_, err = tx.ExecContext(ctx, `INSERT INTO backup_runs(trigger,config,credentials,instance,requested,deadline)
				VALUES('scheduled',$1,$2,$3,$4,$5)`, raw, secret, instance, due, deadline)
		}
		if err != nil {
			return err
		}
		times, err := c.Upcoming(now)
		if err != nil {
			return err
		}
		next = times[0]
	}
	if _, err = tx.ExecContext(ctx, "UPDATE backup_settings SET next_at=$1,missed_at=$2 WHERE id=1", next, missed); err != nil {
		return err
	}
	return tx.Commit()
}

const pruneBackupRuns = `DELETE FROM backup_runs r WHERE r.finished IS NOT NULL
	AND NOT EXISTS (SELECT FROM backup_notifications n WHERE n.id=r.id)
	AND r.id IN (SELECT id FROM backup_runs ORDER BY (finished IS NULL) DESC,coalesce(finished,requested) DESC,id DESC OFFSET 20)`

func incrementBackupMetric(ctx context.Context, tx *sql.Tx, name string) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO backup_metrics(name,value) VALUES($1,1)
		ON CONFLICT(name) DO UPDATE SET value=backup_metrics.value+1`, name)
	return err
}

func (s *Store) History(ctx context.Context) ([]BackupRun, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT r.id,r.trigger,r.status,r.stage,r.requested,r.started,r.deadline,r.verified_at,
		r.finished,r.attempt,r.due,r.bytes,r.total,r.diagnostic,r.timings,r.config,r.object_key,r.notification,
		(r.verified_at IS NOT NULL AND NOT EXISTS(SELECT FROM backup_objects o WHERE o.id=r.id))
		FROM backup_runs r ORDER BY (r.finished IS NULL) DESC,coalesce(r.finished,r.requested) DESC,r.id DESC LIMIT 20`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []BackupRun{}
	for rows.Next() {
		var r BackupRun
		var started *time.Time
		var d, t, c []byte
		if err = rows.Scan(&r.ID, &r.Trigger, &r.Status, &r.Stage, &r.Requested, &started, &r.Deadline, &r.VerifiedAt, &r.Finished,
			&r.Attempt, &r.Due, &r.Bytes, &r.Total, &d, &t, &c, &r.ObjectKey, &r.Notification, &r.Removed); err != nil {
			return nil, err
		}
		if started != nil {
			r.Started = *started
		}
		if err = json.Unmarshal(c, &r.Config); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(d, &r.Diagnostic); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(t, &r.Timings); err != nil {
			return nil, err
		}
		result = append(result, r)
	}
	return result, rows.Err()
}

// Hold the lock on its own session throughout execution. PostgreSQL releases it if the worker dies.
func (s *Store) WorkBackup(ctx context.Context, work func(BackupJob) error) error {
	var pending bool
	if e := s.db.QueryRowContext(ctx, "SELECT EXISTS(SELECT FROM backup_runs WHERE finished IS NULL AND (due<=now() OR deadline<=now() OR cancel))").Scan(&pending); e != nil || !pending {
		return e
	}
	conn, e := s.db.Conn(ctx)
	if e != nil {
		return e
	}
	defer conn.Close()
	var locked bool
	if e = conn.QueryRowContext(ctx, "SELECT pg_try_advisory_lock(1678904018)").Scan(&locked); e != nil || !locked {
		return e
	}
	defer func() {
		release, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if _, err := conn.ExecContext(release, "SELECT pg_advisory_unlock(1678904018)"); err != nil {
			conn.Raw(func(any) error { return driver.ErrBadConn })
		}
	}()
	var j BackupJob
	var raw []byte
	// The active row owns the slot even while waiting for a retry. Test eligibility
	// after selecting it so that a queued manual request cannot jump ahead.
	e = conn.QueryRowContext(ctx, `WITH head AS (
		  SELECT id FROM backup_runs WHERE finished IS NULL
		  ORDER BY (started IS NOT NULL) DESC,requested,(trigger='manual') DESC,id LIMIT 1
		) UPDATE backup_runs r SET status='running',attempt=attempt+1,timings='{}',
		  started=coalesce(started,now()),
		  deadline=coalesce(deadline,now()+(config->>'WindowMinutes')::int*interval '1 minute'),
		  stage=CASE WHEN verified_at IS NOT NULL THEN 'retention' WHEN started IS NULL THEN 'prepare' ELSE stage END,
		  bytes=CASE WHEN verified_at IS NULL THEN 0 ELSE total END
		FROM head WHERE r.id=head.id AND r.finished IS NULL AND (due<=now() OR deadline<=now() OR cancel)
		RETURNING r.id,r.trigger,r.requested,r.started,r.deadline,r.verified_at,r.attempt,r.config,r.credentials,
		  r.instance,r.stage,r.bytes,r.total,r.status`).Scan(&j.ID, &j.Trigger, &j.Requested, &j.Started, &j.Deadline,
		&j.VerifiedAt, &j.Attempt, &raw, &j.Secret, &j.Instance, &j.Stage, &j.Bytes, &j.Total, &j.Status)
	if errors.Is(e, sql.ErrNoRows) {
		return nil
	}
	if e != nil {
		return e
	}
	if e = json.Unmarshal(raw, &j.Config); e != nil {
		return e
	}
	j.conn = conn
	return work(j)
}
func (j BackupJob) Cancelled(ctx context.Context) (bool, error) {
	var v bool
	e := j.conn.QueryRowContext(ctx, "SELECT cancel FROM backup_runs WHERE id=$1 AND attempt=$2 AND finished IS NULL", j.ID, j.Attempt).Scan(&v)
	return v, e
}
func (s *Store) CancelBackup(ctx context.Context, id string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// A waiting request can release its place immediately. A running worker
	// observes cancel and finishes the active row on its own connection.
	var queued bool
	err = tx.QueryRowContext(ctx, `UPDATE backup_runs SET cancel=true,
		status=CASE WHEN started IS NULL THEN 'cancelled' ELSE status END,
		finished=CASE WHEN started IS NULL THEN clock_timestamp() END,
		credentials=CASE WHEN started IS NULL THEN ''::bytea ELSE credentials END,
		notification=CASE WHEN started IS NULL THEN 'not_required' ELSE notification END
		WHERE id=$1 AND finished IS NULL RETURNING started IS NULL`, id).Scan(&queued)
	if err != nil {
		return err
	}
	if queued {
		if err = incrementBackupMetric(ctx, tx, "cancelled_total"); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, pruneBackupRuns); err != nil {
			return err
		}
	}
	return tx.Commit()
}
func (j BackupJob) Progress(ctx context.Context, stage string, n, total int64, times map[string]int64) error {
	t, err := json.Marshal(times)
	if err != nil {
		return err
	}
	_, err = j.conn.ExecContext(ctx, `UPDATE backup_runs SET stage=$2,bytes=$3,total=$4,timings=$5
		WHERE id=$1 AND attempt=$6 AND finished IS NULL`, j.ID, stage, n, total, t, j.Attempt)
	return err
}

func (j BackupJob) Finish(ctx context.Context, status string, retry time.Duration, diagnostic map[string]any) (string, error) {
	switch status {
	case "succeeded", "failed", "cancelled", "retry":
	default:
		return "", errors.New("invalid backup result")
	}
	tx, err := j.conn.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	var stage string
	var cancelled, timedOut, notify bool
	err = tx.QueryRowContext(ctx, `SELECT stage,cancel,clock_timestamp()>=deadline,coalesce(config->>'TelegramChatID','')<>''
		FROM backup_runs WHERE id=$1 AND attempt=$2 AND status='running' FOR UPDATE`, j.ID, j.Attempt).Scan(&stage, &cancelled, &timedOut, &notify)
	if err != nil {
		return "", err
	}
	if cancelled {
		status = "cancelled"
	} else if timedOut && (status == "retry" || status == "succeeded") {
		status = "failed"
		diagnostic = map[string]any{"error_code": "deadline_exceeded", "stage": stage}
	}
	var notification string
	switch {
	case status == "retry":
	case status != "failed":
		notification = "not_required"
	case !notify:
		notification = "disabled"
	default:
		notification = "pending"
		_, err = tx.ExecContext(ctx, `INSERT INTO backup_notifications(id,config,credentials,last_success)
			SELECT id,config,credentials,coalesce((SELECT value FROM backup_metrics WHERE name='last_success_timestamp_seconds'),0)
			FROM backup_runs WHERE id=$1`, j.ID)
		if err != nil {
			return "", err
		}
	}
	d, err := json.Marshal(diagnostic)
	if err != nil {
		return "", err
	}
	_, err = tx.ExecContext(ctx, `UPDATE backup_runs SET status=$2,diagnostic=$3,
		  due=least(deadline,now()+($4 * interval '1 millisecond')),notification=$5,
		  finished=CASE WHEN $2='retry' THEN NULL ELSE clock_timestamp() END,
		  credentials=CASE WHEN $2='retry' THEN credentials ELSE ''::bytea END WHERE id=$1`,
		j.ID, status, d, retry.Milliseconds(), notification)
	if err != nil {
		return "", err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO backup_metrics(name,value)
		SELECT 'stage_'||key||'_milliseconds_total',value::bigint FROM backup_runs,jsonb_each_text(timings) WHERE id=$1
		ON CONFLICT(name) DO UPDATE SET value=backup_metrics.value+excluded.value`, j.ID); err != nil {
		return "", err
	}
	if status == "retry" {
		if err = incrementBackupMetric(ctx, tx, "retries_total"); err != nil {
			return "", err
		}
		return status, tx.Commit()
	}
	if err = incrementBackupMetric(ctx, tx, status+"_total"); err != nil {
		return "", err
	}
	if status == "failed" && stage == "retention" {
		if err = incrementBackupMetric(ctx, tx, "retention_errors_total"); err != nil {
			return "", err
		}
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO backup_metrics(name,value)
		SELECT 'last_duration_seconds',extract(epoch FROM finished-started)::bigint FROM backup_runs WHERE id=$1
		ON CONFLICT(name) DO UPDATE SET value=excluded.value`, j.ID); err != nil {
		return "", err
	}
	if status == "succeeded" {
		if _, err = tx.ExecContext(ctx, `INSERT INTO backup_metrics(name,value)
			SELECT 'last_success_timestamp_seconds',extract(epoch FROM finished)::bigint FROM backup_runs WHERE id=$1
			UNION ALL SELECT 'last_size_bytes',total FROM backup_runs WHERE id=$1
			UNION ALL SELECT 'last_success_duration_seconds',extract(epoch FROM finished-started)::bigint FROM backup_runs WHERE id=$1
			ON CONFLICT(name) DO UPDATE SET value=excluded.value`, j.ID); err != nil {
			return "", err
		}
	}
	if _, err = tx.ExecContext(ctx, pruneBackupRuns); err != nil {
		return "", err
	}
	return status, tx.Commit()
}

// All writes by a worker use the session holding the advisory lock. A disconnected
// worker cannot publish state, even if another replica immediately claims the run.
func (j BackupJob) Pending(ctx context.Context, key string) error {
	_, e := j.conn.ExecContext(ctx, `INSERT INTO backup_pending(instance,destination,mode,object_key) VALUES($1,$2,$3,$4)`, j.Instance, j.Config.Binding(), j.Config.Mode, key)
	return e
}
func (j BackupJob) Verified(ctx context.Context) (bool, int64, error) {
	var found bool
	var total int64
	e := j.conn.QueryRowContext(ctx, `SELECT verified_at IS NOT NULL,total FROM backup_runs WHERE id=$1`, j.ID).Scan(&found, &total)
	return found, total, e
}
func (j BackupJob) RecordObject(ctx context.Context, key, version string) error {
	tx, e := j.conn.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if _, e = tx.ExecContext(ctx, `INSERT INTO backup_objects(id,instance,destination,mode,object_key,version_id) VALUES($1,$2,$3,$4,$5,$6)`, j.ID, j.Instance, j.Config.Binding(), j.Config.Mode, key, version); e != nil {
		return e
	}
	if _, e = tx.ExecContext(ctx, "UPDATE backup_runs SET object_key=$2,verified_at=now(),stage='retention' WHERE id=$1", j.ID, key); e != nil {
		return e
	}
	if _, e = tx.ExecContext(ctx, "DELETE FROM backup_pending WHERE instance=$1 AND destination=$2 AND mode=$3 AND object_key=$4", j.Instance, j.Config.Binding(), j.Config.Mode, key); e != nil {
		return e
	}
	return tx.Commit()
}
func (j BackupJob) ExpiredObject(ctx context.Context) (id, key, version string, err error) {
	err = j.conn.QueryRowContext(ctx, `SELECT id::text,object_key,version_id FROM backup_objects
		WHERE instance=$1 AND destination=$2 AND mode=$3 AND id<>$5
		  AND verified < now() - $4 * interval '24 hours'
		UNION ALL SELECT '',object_key,'' FROM backup_pending WHERE instance=$1 AND destination=$2 AND mode=$3
		LIMIT 1`, j.Instance, j.Config.Binding(), j.Config.Mode, j.Config.RetentionDays, j.ID).Scan(&id, &key, &version)
	return
}
func (j BackupJob) ForgetObject(ctx context.Context, id, key string) error {
	if id == "" {
		_, e := j.conn.ExecContext(ctx, "DELETE FROM backup_pending WHERE instance=$1 AND destination=$2 AND mode=$3 AND object_key=$4", j.Instance, j.Config.Binding(), j.Config.Mode, key)
		return e
	}
	_, e := j.conn.ExecContext(ctx, "WITH gone AS (DELETE FROM backup_objects WHERE id=$1 AND instance=$2 AND destination=$3 AND mode=$4 AND object_key=$5 RETURNING id) INSERT INTO backup_metrics(name,value) SELECT 'deleted_total',count(*) FROM gone ON CONFLICT(name) DO UPDATE SET value=backup_metrics.value+excluded.value", id, j.Instance, j.Config.Binding(), j.Config.Mode, key)
	return e
}

func (s *Store) BackupMetrics(ctx context.Context) (map[string]int64, error) {
	m := map[string]int64{}
	rows, e := s.db.QueryContext(ctx, `SELECT name,value FROM backup_metrics UNION ALL SELECT 'next_timestamp_seconds',coalesce(extract(epoch FROM max(next_at))::bigint,0) FROM backup_settings UNION ALL SELECT 'enabled',count(*) FROM backup_settings WHERE next_at IS NOT NULL UNION ALL SELECT 'in_progress',count(*) FROM backup_runs WHERE started IS NOT NULL AND finished IS NULL`)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	for rows.Next() {
		var k string
		var v int64
		if e = rows.Scan(&k, &v); e != nil {
			return nil, e
		}
		m[k] = v
	}

	return m, rows.Err()
}
