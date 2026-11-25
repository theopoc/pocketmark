package observability

import (
	"bytes"
	"context"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestWorkerHeartbeatsOnlyForStartedLoops(t *testing.T) {
	o := testObserver(&bytes.Buffer{})
	var out bytes.Buffer
	o.WriteWorkerMetrics(&out)
	if strings.Contains(out.String(), "pocketmark_worker_last_activity_timestamp_seconds{") {
		t.Fatalf("series before any loop started:\n%s", out.String())
	}
	before := time.Now().Unix()
	o.Beat(WorkerCapture)
	o.Beat(WorkerBackup)
	o.Beat(Worker(-1))
	o.Beat(workerCount)
	out.Reset()
	o.WriteWorkerMetrics(&out)
	body := out.String()
	for _, worker := range []string{"capture", "backup"} {
		var at int64
		prefix := fmt.Sprintf("pocketmark_worker_last_activity_timestamp_seconds{worker=%q} ", worker)
		i := strings.Index(body, prefix)
		if i < 0 {
			t.Fatalf("missing %s heartbeat:\n%s", worker, body)
		}
		if _, err := fmt.Sscan(body[i+len(prefix):], &at); err != nil || at < before || at > time.Now().Unix() {
			t.Fatalf("%s heartbeat %d: %v", worker, at, err)
		}
	}
	if strings.Count(body, "{worker=") != 2 || !strings.Contains(body, "# TYPE pocketmark_worker_last_activity_timestamp_seconds gauge") {
		t.Fatalf("heartbeats:\n%s", body)
	}
}

func TestQueueMetricsKeepScrapeWhenDatabaseReadFails(t *testing.T) {
	var out bytes.Buffer
	WriteQueueMetrics(context.Background(), &out, []QueueStat{{Queue: "capture", Pending: 3, OldestAgeSeconds: 42.5}, {Queue: "backup"}}, nil)
	for _, want := range []string{
		"pocketmark_queue_metrics_up 1\n",
		"# TYPE pocketmark_queue_pending gauge\n",
		`pocketmark_queue_pending{queue="capture"} 3` + "\n",
		`pocketmark_queue_pending{queue="backup"} 0` + "\n",
		`pocketmark_queue_oldest_age_seconds{queue="capture"} 42.5` + "\n",
		`pocketmark_queue_oldest_age_seconds{queue="backup"} 0` + "\n",
	} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("missing %q in:\n%s", want, out.String())
		}
	}

	var logs bytes.Buffer
	ctx := context.WithValue(context.Background(), loggerKey{}, testObserver(&logs).logger)
	out.Reset()
	WriteQueueMetrics(ctx, &out, nil, context.DeadlineExceeded)
	if !strings.Contains(out.String(), "pocketmark_queue_metrics_up 0\n") || strings.Contains(out.String(), "pocketmark_queue_pending{") {
		t.Fatalf("failed read:\n%s", out.String())
	}
	r := records(t, &logs)
	if len(r) != 1 || r[0]["event"] != "queue_metrics_unavailable" || r[0]["level"] != "WARN" {
		t.Fatalf("log: %v", r)
	}

	// A scraper that disconnected is not a database incident.
	gone, cancel := context.WithCancel(ctx)
	cancel()
	out.Reset()
	WriteQueueMetrics(gone, &out, nil, context.Canceled)
	if !strings.Contains(out.String(), "pocketmark_queue_metrics_up 0\n") || logs.Len() != 0 {
		t.Fatalf("cancelled scrape: %s %s", out.String(), logs.String())
	}
}
