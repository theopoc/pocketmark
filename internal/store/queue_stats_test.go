package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	"pocketmark/internal/capture"
	"pocketmark/internal/observability"
	"pocketmark/internal/pgtest"
)

func queueStats(t *testing.T, s *Store) map[string]observability.QueueStat {
	t.Helper()
	stats, err := s.QueueStats(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]observability.QueueStat{}
	for _, q := range stats {
		out[q.Queue] = q
	}
	if len(stats) != 3 || len(out) != 3 {
		t.Fatalf("queues: %+v", stats)
	}
	return out
}

func TestQueueStatsReportBacklogAndOldestAge(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	for name, q := range queueStats(t, s) {
		if q.Pending != 0 || q.OldestAgeSeconds != 0 {
			t.Fatalf("empty %s queue: %+v", name, q)
		}
	}

	old := createLink(t, s, Link{URL: "https://example.test/old"})
	createLink(t, s, Link{URL: "https://example.test/new"})
	if _, err := s.db.Exec("UPDATE links SET capture_queued=now()-interval '10 minutes' WHERE id=$1", old); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`INSERT INTO ai_tag_jobs(link_id,url_hash,queued) SELECT id,url_digest(url),now()-interval '3 minutes' FROM links WHERE id=$1`, old); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`INSERT INTO backup_runs(trigger,config,credentials,instance,requested)
	VALUES('manual','{}','\x00',gen_random_uuid(),now()-interval '2 minutes'),
	      ('scheduled','{}','\x00',gen_random_uuid(),now()-interval '1 hour')`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`UPDATE backup_runs SET finished=now(),status='failed' WHERE trigger='scheduled'`); err != nil {
		t.Fatal(err)
	}
	q := queueStats(t, s)
	if c := q["capture"]; c.Pending != 2 || c.OldestAgeSeconds < 599 || c.OldestAgeSeconds > 900 {
		t.Fatalf("capture: %+v", c)
	}
	if a := q["ai_tagging"]; a.Pending != 1 || a.OldestAgeSeconds < 179 || a.OldestAgeSeconds > 400 {
		t.Fatalf("ai_tagging: %+v", a)
	}
	// Finished runs leave the backup queue.
	if b := q["backup"]; b.Pending != 1 || b.OldestAgeSeconds < 119 || b.OldestAgeSeconds > 400 {
		t.Fatalf("backup: %+v", b)
	}

	// A claimed capture is still unfinished and keeps its queue time.
	job, err := s.Next(ctx)
	if err != nil || job.ID != old {
		t.Fatalf("claim oldest: %d %v", job.ID, err)
	}
	if c := queueStats(t, s)["capture"]; c.Pending != 2 || c.OldestAgeSeconds < 599 {
		t.Fatalf("claimed capture: %+v", c)
	}
	if err = s.Finish(ctx, job, capture.Result{HTML: []byte("page")}, nil); err != nil {
		t.Fatal(err)
	}
	if c := queueStats(t, s)["capture"]; c.Pending != 1 || c.OldestAgeSeconds > 60 {
		t.Fatalf("after finish: %+v", c)
	}
	// Requeueing restarts the clock: the age measures the current wait.
	if _, err = s.db.Exec("UPDATE links SET capture_queued=now()-interval '1 day' WHERE id=$1", old); err != nil {
		t.Fatal(err)
	}
	if err = s.Queue(ctx, old); err != nil {
		t.Fatal(err)
	}
	if c := queueStats(t, s)["capture"]; c.Pending != 2 || c.OldestAgeSeconds > 60 {
		t.Fatalf("requeued capture: %+v", c)
	}
}

func TestCaptureQueueUpgradeKeepsPendingLinksAcrossRestart(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	uri := pgtest.URL(t, dir)
	db, err := sql.Open("pgx", uri)
	if err != nil {
		t.Fatal(err)
	}
	// A schema 7 database with an unfinished and a finished capture.
	_, err = db.Exec(initialSchema + challengeSchema + sessionAddressSchema + backupSchema + aiTagSchema + readerArchiveSchema + aiProviderSchema + `
CREATE TABLE pocketmark_migrations(version integer PRIMARY KEY);
INSERT INTO pocketmark_migrations VALUES (1),(2),(3),(4),(5),(6),(7);
INSERT INTO links(url,title,created_at,updated_at,status)
VALUES('https://example.test/pending','Pending','2015-01-01T00:00:00Z','2015-01-01T00:00:00Z','pending'),
      ('https://example.test/ready','Ready',utc_timestamp_text(),utc_timestamp_text(),'ready');`)
	db.Close()
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		s, err := Open(uri, filepath.Join(dir, "data"))
		if err != nil {
			t.Fatal(err)
		}
		// Legacy rows count from the upgrade, not from a years-old creation date.
		if c := queueStats(t, s)["capture"]; c.Pending != 1 || c.OldestAgeSeconds > 600 {
			t.Fatalf("legacy capture queue: %+v", c)
		}
		l, err := s.Get(ctx, 1)
		if err != nil || l.Status != "pending" || l.Title != "Pending" {
			t.Fatalf("legacy link: %+v %v", l, err)
		}
		s.Close()
	}
	// SQL issued by an already-running schema 7 replica still stamps the queue time.
	s, err := Open(uri, filepath.Join(dir, "data"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err = s.db.Exec("UPDATE links SET capture_queued=now()-interval '1 day'"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.Exec("UPDATE links SET status='pending',error='' WHERE id=2"); err != nil {
		t.Fatal(err)
	}
	var age float64
	if err = s.db.QueryRow("SELECT extract(epoch FROM now()-capture_queued)::float8 FROM links WHERE id=2").Scan(&age); err != nil || age > 60 {
		t.Fatalf("legacy requeue age: %v %v", age, err)
	}
}
