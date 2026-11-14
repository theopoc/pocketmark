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
	Started                    time.Time
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

func (s *Store) BackupConfig(ctx context.Context) (c backup.Config, secret []byte, next *time.Time, err error) {
	var raw []byte
	err = s.db.QueryRowContext(ctx, "SELECT config,credentials,next_at FROM backup_settings WHERE id=1").Scan(&raw, &secret, &next)
	if errors.Is(err, sql.ErrNoRows) {
		return backup.Default(), nil, nil, nil
	}
	if err == nil {
		err = json.Unmarshal(raw, &c)
	}
	return
}
func (s *Store) SaveBackup(ctx context.Context, c backup.Config, secret []byte) error {
	raw, _ := json.Marshal(c)
	var next *time.Time
	if c.Enabled {
		times, e := c.Upcoming(time.Now())
		if e != nil {
			return e
		}
		next = &times[0]
	}
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if _, e = tx.ExecContext(ctx, `INSERT INTO backup_settings(id,config,credentials,next_at) VALUES(1,$1,$2,$3) ON CONFLICT(id) DO UPDATE SET config=excluded.config,credentials=excluded.credentials,next_at=CASE WHEN excluded.next_at IS NOT NULL AND backup_settings.next_at IS NOT NULL AND backup_settings.config->>'Cron'=excluded.config->>'Cron' AND backup_settings.config->>'Zone'=excluded.config->>'Zone' THEN backup_settings.next_at ELSE excluded.next_at END`, raw, secret, next); e != nil {
		return e
	}
	if !c.Enabled {
		if _, e = tx.ExecContext(ctx, `UPDATE backup_runs SET retry_allowed=false,cancel=cancel OR status='retry' WHERE finished IS NULL`); e != nil {
			return e
		}
	}
	return tx.Commit()
}
func (s *Store) QueueBackup(ctx context.Context, trigger string) (string, error) {
	var id string
	e := s.db.QueryRowContext(ctx, `INSERT INTO backup_runs(trigger,config,credentials,instance) SELECT $1,config,credentials,instance FROM backup_settings WHERE id=1 ON CONFLICT DO NOTHING RETURNING id`, trigger).Scan(&id)
	if errors.Is(e, sql.ErrNoRows) {
		return "", ErrBackupBusy
	}
	return id, e
}
func (s *Store) ScheduleBackup(ctx context.Context) error {
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	var raw []byte
	if e = tx.QueryRowContext(ctx, "SELECT config FROM backup_settings WHERE id=1 AND next_at<=now() FOR UPDATE SKIP LOCKED").Scan(&raw); errors.Is(e, sql.ErrNoRows) {
		return nil
	} else if e != nil {
		return e
	}
	var c backup.Config
	if e = json.Unmarshal(raw, &c); e != nil {
		return e
	}
	times, e := c.Upcoming(time.Now())
	if e != nil {
		return e
	}
	if _, e = tx.ExecContext(ctx, `INSERT INTO backup_runs(trigger,config,credentials,instance) SELECT 'scheduled',config,credentials,instance FROM backup_settings WHERE id=1 ON CONFLICT DO NOTHING`); e != nil {
		return e
	}
	if _, e = tx.ExecContext(ctx, "UPDATE backup_settings SET next_at=$1 WHERE id=1", times[0]); e != nil {
		return e
	}
	return tx.Commit()
}
func (s *Store) History(ctx context.Context) ([]BackupRun, error) {
	rows, e := s.db.QueryContext(ctx, `SELECT r.id,r.trigger,r.status,r.stage,r.started,r.finished,r.attempt,r.due,r.bytes,r.total,r.diagnostic,r.timings,r.config,r.object_key,(r.status IN ('succeeded','warning') AND NOT EXISTS(SELECT FROM backup_objects o WHERE o.id=r.id)) FROM backup_runs r ORDER BY started DESC LIMIT 20`)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	result := []BackupRun{}
	for rows.Next() {
		var r BackupRun
		var d, t, c []byte
		if e = rows.Scan(&r.ID, &r.Trigger, &r.Status, &r.Stage, &r.Started, &r.Finished, &r.Attempt, &r.Due, &r.Bytes, &r.Total, &d, &t, &c, &r.ObjectKey, &r.Removed); e != nil {
			return nil, e
		}
		if e = json.Unmarshal(c, &r.Config); e != nil {
			return nil, e
		}
		json.Unmarshal(d, &r.Diagnostic)
		json.Unmarshal(t, &r.Timings)
		result = append(result, r)
	}
	return result, rows.Err()
}

// Hold the lock on its own session throughout execution. PostgreSQL releases it if the worker dies.
func (s *Store) WorkBackup(ctx context.Context, work func(BackupJob) error) error {
	var pending bool
	if e := s.db.QueryRowContext(ctx, "SELECT EXISTS(SELECT FROM backup_runs WHERE finished IS NULL AND (due<=now() OR cancel))").Scan(&pending); e != nil || !pending {
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
	e = conn.QueryRowContext(ctx, `UPDATE backup_runs SET status='running',stage='prepare',timings='{}',bytes=0,attempt=attempt+1 WHERE finished IS NULL AND (due<=now() OR cancel) RETURNING id,trigger,started,attempt,config,credentials,instance`).Scan(&j.ID, &j.Trigger, &j.Started, &j.Attempt, &raw, &j.Secret, &j.Instance)
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
	r, e := s.db.ExecContext(ctx, "UPDATE backup_runs SET cancel=true WHERE id=$1 AND finished IS NULL", id)
	if e == nil {
		n, _ := r.RowsAffected()
		if n == 0 {
			return sql.ErrNoRows
		}
	}
	return e
}
func (j BackupJob) Progress(ctx context.Context, stage string, n, total int64, times map[string]int64) error {
	t, _ := json.Marshal(times)
	_, e := j.conn.ExecContext(ctx, "UPDATE backup_runs SET stage=$2,bytes=$3,total=$4,timings=$5 WHERE id=$1", j.ID, stage, n, total, t)
	return e
}
func (j BackupJob) Finish(ctx context.Context, status string, retry time.Duration, diagnostic map[string]any) (string, error) {
	id := j.ID
	d, _ := json.Marshal(diagnostic)
	tx, e := j.conn.BeginTx(ctx, nil)
	if e != nil {
		return "", e
	}
	defer tx.Rollback()
	if status == "retry" {
		var allowed bool
		if e = tx.QueryRowContext(ctx, "SELECT retry_allowed AND NOT cancel FROM backup_runs WHERE id=$1 FOR UPDATE", id).Scan(&allowed); e != nil {
			return "", e
		}
		if !allowed {
			status = "cancelled"
			retry = 0
		}
	}
	_, e = tx.ExecContext(ctx, `UPDATE backup_runs SET status=$2,diagnostic=$3,due=now()+($4 * interval '1 second'),finished=CASE WHEN $2='retry' THEN NULL ELSE now() END,credentials=CASE WHEN $2='retry' THEN credentials ELSE ''::bytea END WHERE id=$1`, id, status, d, int(retry.Seconds()))
	if e != nil {
		return "", e
	}
	if _, e = tx.ExecContext(ctx, `INSERT INTO backup_metrics(name,value)
 SELECT 'stage_'||key||'_milliseconds_total',value::bigint FROM backup_runs,jsonb_each_text(timings) WHERE id=$1
 ON CONFLICT(name) DO UPDATE SET value=backup_metrics.value+excluded.value`, id); e != nil {
		return "", e
	}
	if status == "retry" {
		if _, e = tx.ExecContext(ctx, `INSERT INTO backup_metrics(name,value) VALUES('retries_total',1) ON CONFLICT(name) DO UPDATE SET value=backup_metrics.value+1`); e != nil {
			return "", e
		}
	}
	if status != "retry" {
		if _, e = tx.ExecContext(ctx, `INSERT INTO backup_metrics(name,value) SELECT $2,1 FROM backup_runs WHERE id=$1 ON CONFLICT(name) DO UPDATE SET value=backup_metrics.value+1`, id, status+"_total"); e != nil {
			return "", e
		}
		if _, e = tx.ExecContext(ctx, `INSERT INTO backup_metrics(name,value) SELECT 'last_duration_seconds',extract(epoch FROM finished-started)::bigint FROM backup_runs WHERE id=$1 ON CONFLICT(name) DO UPDATE SET value=excluded.value`, id); e != nil {
			return "", e
		}
		if status == "succeeded" || status == "warning" {
			if _, e = tx.ExecContext(ctx, `INSERT INTO backup_metrics(name,value) SELECT 'last_success_timestamp_seconds',extract(epoch FROM finished)::bigint FROM backup_runs WHERE id=$1 UNION ALL SELECT 'last_size_bytes',total FROM backup_runs WHERE id=$1 UNION ALL SELECT 'last_success_duration_seconds',extract(epoch FROM finished-started)::bigint FROM backup_runs WHERE id=$1 ON CONFLICT(name) DO UPDATE SET value=excluded.value`, id); e != nil {
				return "", e
			}
		}
	}
	if _, e = tx.ExecContext(ctx, `DELETE FROM backup_runs WHERE finished IS NOT NULL AND id IN (SELECT id FROM backup_runs ORDER BY started DESC OFFSET 20)`); e != nil {
		return "", e
	}
	return status, tx.Commit()
}

// All writes by a worker use the session holding the advisory lock. A disconnected
// worker cannot publish state, even if another replica immediately claims the run.
func (j BackupJob) Pending(ctx context.Context, key string) error {
	_, e := j.conn.ExecContext(ctx, `INSERT INTO backup_pending(instance,destination,object_key) VALUES($1,$2,$3)`, j.Instance, j.Config.Binding(), key)
	return e
}
func (j BackupJob) Verified(ctx context.Context) (bool, int64, error) {
	var found bool
	var total int64
	e := j.conn.QueryRowContext(ctx, `SELECT EXISTS(SELECT FROM backup_objects WHERE id=$1),total FROM backup_runs WHERE id=$1`, j.ID).Scan(&found, &total)
	return found, total, e
}
func (j BackupJob) RecordObject(ctx context.Context, key string) error {
	tx, e := j.conn.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if _, e = tx.ExecContext(ctx, `INSERT INTO backup_objects(id,instance,destination,object_key) VALUES($1,$2,$3,$4)`, j.ID, j.Instance, j.Config.Binding(), key); e != nil {
		return e
	}
	if _, e = tx.ExecContext(ctx, "UPDATE backup_runs SET object_key=$2 WHERE id=$1", j.ID, key); e != nil {
		return e
	}
	if _, e = tx.ExecContext(ctx, "DELETE FROM backup_pending WHERE instance=$1 AND destination=$2 AND object_key=$3", j.Instance, j.Config.Binding(), key); e != nil {
		return e
	}
	return tx.Commit()
}
func (j BackupJob) ExpiredObject(ctx context.Context) (id, key string, err error) {
	err = j.conn.QueryRowContext(ctx, `SELECT id::text,object_key FROM (SELECT id,object_key FROM backup_objects WHERE instance=$1 AND destination=$2 ORDER BY verified DESC,id DESC OFFSET $3) old UNION ALL SELECT '',object_key FROM backup_pending WHERE instance=$1 AND destination=$2 LIMIT 1`, j.Instance, j.Config.Binding(), j.Config.Keep).Scan(&id, &key)
	return
}
func (j BackupJob) ForgetObject(ctx context.Context, id, key string) error {
	if id == "" {
		_, e := j.conn.ExecContext(ctx, "DELETE FROM backup_pending WHERE instance=$1 AND destination=$2 AND object_key=$3", j.Instance, j.Config.Binding(), key)
		return e
	}
	_, e := j.conn.ExecContext(ctx, "WITH gone AS (DELETE FROM backup_objects WHERE id=$1 RETURNING id) INSERT INTO backup_metrics(name,value) SELECT 'deleted_total',count(*) FROM gone ON CONFLICT(name) DO UPDATE SET value=backup_metrics.value+excluded.value", id)
	return e
}

func (s *Store) BackupMetrics(ctx context.Context) (map[string]int64, error) {
	m := map[string]int64{}
	rows, e := s.db.QueryContext(ctx, `SELECT name,value FROM backup_metrics UNION ALL SELECT 'next_timestamp_seconds',coalesce(extract(epoch FROM max(next_at))::bigint,0) FROM backup_settings UNION ALL SELECT 'enabled',count(*) FROM backup_settings WHERE next_at IS NOT NULL UNION ALL SELECT 'in_progress',count(*) FROM backup_runs WHERE status='running' AND finished IS NULL`)
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
	m["retention_errors_total"] = m["warning_total"]
	return m, rows.Err()
}
