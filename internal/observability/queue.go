package observability

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"time"
)

// Worker names a background loop that reports a heartbeat. The set is fixed so
// the heartbeat gauge has a bounded label set and lives in a fixed array.
type Worker int

const (
	WorkerCapture Worker = iota
	WorkerAITagging
	WorkerBackupSchedule
	WorkerBackupNotify
	WorkerBackupRun
	workerCount
)

var workerNames = [workerCount]string{"capture", "ai_tagging", "backup_schedule", "backup_notify", "backup_run"}

// Beat records that w finished an iteration without a queue error: it polled
// an empty queue or completed a job. Call it once when the loop starts too, so
// a loop that hangs in its first iteration still exposes a series that ages.
func (o *Observer) Beat(w Worker) {
	if w >= 0 && w < workerCount {
		o.measurements.heartbeats[w].Store(time.Now().Unix())
	}
}

// QueueStat is the backlog of one durable queue, read from PostgreSQL.
type QueueStat struct {
	Queue            string
	Pending          int64
	OldestAgeSeconds float64
}

// WriteWorkerMetrics writes the heartbeat of every loop that has started. A loop
// that never started (for example capture with -no-capture) has no series.
func (o *Observer) WriteWorkerMetrics(w io.Writer) {
	fmt.Fprintln(w, "# HELP pocketmark_worker_last_activity_timestamp_seconds Unix time a background loop last finished an iteration without a queue error.\n# TYPE pocketmark_worker_last_activity_timestamp_seconds gauge")
	for i := range o.measurements.heartbeats {
		if at := o.measurements.heartbeats[i].Load(); at != 0 {
			fmt.Fprintf(w, "pocketmark_worker_last_activity_timestamp_seconds{worker=%q} %d\n", workerNames[i], at)
		}
	}
}

// WriteQueueMetrics writes queue backlog gauges. When the database read failed
// it writes only pocketmark_queue_metrics_up 0 and logs a warning; the rest of
// the scrape stays available.
func WriteQueueMetrics(ctx context.Context, w io.Writer, stats []QueueStat, err error) {
	up := 1
	if err != nil {
		up = 0
	}
	// A scraper that went away needs no diagnosis; a deadline hit does.
	if err != nil && !errors.Is(ctx.Err(), context.Canceled) {
		Log(ctx, slog.LevelWarn, "queue_metrics_unavailable", Failure("queue_metrics_unavailable", err)+"; queue gauges omitted from this scrape", ErrorAttrs(err)...)
	}
	fmt.Fprintf(w, "# HELP pocketmark_queue_metrics_up Whether the queue backlog read from PostgreSQL succeeded in this scrape.\n# TYPE pocketmark_queue_metrics_up gauge\npocketmark_queue_metrics_up %d\n", up)
	if err != nil {
		return
	}
	fmt.Fprintln(w, "# HELP pocketmark_queue_pending Jobs not yet finished (waiting or in progress) per durable queue.\n# TYPE pocketmark_queue_pending gauge")
	for _, s := range stats {
		fmt.Fprintf(w, "pocketmark_queue_pending{queue=%q} %d\n", s.Queue, s.Pending)
	}
	fmt.Fprintln(w, "# HELP pocketmark_queue_oldest_age_seconds Age of the oldest unfinished job per durable queue; 0 when the queue is empty.\n# TYPE pocketmark_queue_oldest_age_seconds gauge")
	for _, s := range stats {
		fmt.Fprintf(w, "pocketmark_queue_oldest_age_seconds{queue=%q} %g\n", s.Queue, s.OldestAgeSeconds)
	}
}
