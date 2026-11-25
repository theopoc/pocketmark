package server

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"pocketmark/internal/observability"
)

func TestObservabilityProtectsMetricsAndCountsEarlyRejections(t *testing.T) {
	a := newTestServer(t, "", false)
	var logs bytes.Buffer
	a.observer = observability.New(slog.New(slog.NewJSONHandler(&logs, nil)), nil)
	// Route registration retains the same observer as the middleware.
	a = a.withServer(New(a.Store, testToken, "", false, a.observer))
	requireStatus(t, request(a, "GET", "/metrics", "", false, nil), 401)
	requireStatus(t, request(a, "GET", "/metrics", "", true, nil), 200)
	// A named key can scrape without sharing the recovery token.
	key := namedAPIKey(t, a)
	requireStatus(t, request(a, "GET", "/metrics", "", false, map[string]string{"Authorization": "Bearer " + key}), 200)
	requireStatus(t, request(a, "GET", "/api/links/123?token=private-query", "", false, nil), 401)
	requireStatus(t, request(a, "POST", "/api/links", "{\"url\":\"https://private-bookmark.test\"}", true, map[string]string{"Origin": "https://private-origin.test"}), 403)
	for i := 0; i < cap(a.requests); i++ {
		a.requests <- struct{}{}
	}
	requireStatus(t, request(a, "GET", "/api/stats", "", true, nil), 503)
	for i := 0; i < cap(a.requests); i++ {
		<-a.requests
	}
	w := request(a, "GET", "/metrics", "", true, nil)
	for _, want := range []string{`route="/api/links/{id}",status="401"`, `route="/api/links",status="403"`, `route="/api/stats",status="503"`} {
		if !strings.Contains(w.Body.String(), want) {
			t.Errorf("missing request metric %s", want)
		}
	}
	if strings.Contains(w.Body.String(), "private-") || strings.Contains(logs.String(), "private-") {
		t.Fatal("request data leaked")
	}
	if strings.Contains(logs.String(), `"route":"/metrics","status":200`) {
		t.Fatal("successful scrapes should only be debug logs")
	}
}

func namedAPIKey(t *testing.T, a *testServer) string {
	t.Helper()
	w := request(a, "POST", "/api/tokens", `{"name":"metrics-test"}`, true, nil)
	requireStatus(t, w, 201)
	var result struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result.Token
}

func TestMetricsExposeQueueBacklogAndWorkerHeartbeats(t *testing.T) {
	a := newTestServer(t, "", false)
	requireStatus(t, request(a, "POST", "/api/links", `{"url":"https://queued.example.test/"}`, true, nil), 201)
	body := request(a, "GET", "/metrics", "", true, nil).Body.String()
	for _, want := range []string{
		"pocketmark_queue_metrics_up 1\n",
		`pocketmark_queue_pending{queue="capture"} 1` + "\n",
		`pocketmark_queue_pending{queue="ai_tagging"} 0` + "\n",
		`pocketmark_queue_pending{queue="backup"} 0` + "\n",
		`pocketmark_queue_oldest_age_seconds{queue="capture"} `,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("missing %q", want)
		}
	}
	if strings.Contains(body, "pocketmark_worker_last_activity_timestamp_seconds{") {
		t.Error("heartbeat for a loop that never started")
	}

	ctx, cancel := context.WithCancel(context.Background())
	var workers sync.WaitGroup
	workers.Add(2)
	go func() { defer workers.Done(); a.AITagWorker(ctx, false) }()
	go func() { defer workers.Done(); a.BackupWorker(ctx) }()
	defer func() { cancel(); workers.Wait() }()
	want := []string{"ai_tagging", "backup_schedule", "backup_notify", "backup_run"}
	deadline := time.Now().Add(5 * time.Second)
	for {
		body = request(a, "GET", "/metrics", "", true, nil).Body.String()
		missing := ""
		for _, worker := range want {
			if !strings.Contains(body, `pocketmark_worker_last_activity_timestamp_seconds{worker="`+worker+`"} `) {
				missing = worker
			}
		}
		if missing == "" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no %s heartbeat:\n%s", missing, body)
		}
		time.Sleep(50 * time.Millisecond)
	}

	// A slow queue read drops only the queue gauges, with one WARN.
	var logs bytes.Buffer
	a = a.withServer(New(a.Store, testToken, "", false, observability.New(slog.New(slog.NewJSONHandler(&logs, nil)), nil)))
	defer func(previous time.Duration) { queueMetricsTimeout = previous }(queueMetricsTimeout)
	queueMetricsTimeout = 200 * time.Millisecond
	tx, err := a.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err = tx.Exec("LOCK TABLE ai_tag_jobs IN ACCESS EXCLUSIVE MODE"); err != nil {
		t.Fatal(err)
	}
	w := request(a, "GET", "/metrics", "", true, nil)
	requireStatus(t, w, 200)
	body = w.Body.String()
	for _, want := range []string{"pocketmark_queue_metrics_up 0\n", "pocketmark_backup_metrics_up 1\n", "pocketmark_go_goroutines"} {
		if !strings.Contains(body, want) {
			t.Fatalf("slow queue read: missing %q", want)
		}
	}
	if strings.Contains(body, "pocketmark_queue_pending{") || strings.Count(logs.String(), `"level":"WARN"`) != 1 || !strings.Contains(logs.String(), "queue_metrics_unavailable") {
		t.Fatalf("slow queue read:\n%s\n%s", body, logs.String())
	}
}

func TestMetricsSurviveBackupMetricsDatabaseFailure(t *testing.T) {
	a := newTestServer(t, "", false)
	var logs bytes.Buffer
	a = a.withServer(New(a.Store, testToken, "", false, observability.New(slog.New(slog.NewJSONHandler(&logs, nil)), nil)))
	w := request(a, "GET", "/metrics", "", true, nil)
	requireStatus(t, w, 200)
	for _, want := range []string{"pocketmark_backup_metrics_up 1\n", "pocketmark_backup_enabled 0\n"} {
		if !strings.Contains(w.Body.String(), want) {
			t.Fatalf("healthy scrape missing %q", want)
		}
	}
	unavailable := func(t *testing.T, name string) {
		t.Helper()
		logs.Reset()
		w := request(a, "GET", "/metrics", "", true, nil)
		requireStatus(t, w, 200)
		body := w.Body.String()
		for _, want := range []string{"pocketmark_backup_metrics_up 0\n", "pocketmark_http_request_duration_seconds_count", "pocketmark_go_goroutines"} {
			if !strings.Contains(body, want) {
				t.Fatalf("%s: scrape missing %q", name, want)
			}
		}
		if strings.Contains(body, "pocketmark_backup_enabled") {
			t.Fatalf("%s: unreadable backup metrics reported as values", name)
		}
		if !strings.Contains(logs.String(), `"level":"WARN","msg":"backup_metrics_read_failed"`) || strings.Count(logs.String(), "backup_metrics_read_failed") != 1 || strings.Contains(logs.String(), `"level":"ERROR"`) {
			t.Fatalf("%s: expected one WARN log, got %s", name, logs.String())
		}
	}

	// A slow database: an exclusive lock blocks the read past the scrape budget.
	defer func(previous time.Duration) { backupMetricsTimeout = previous }(backupMetricsTimeout)
	backupMetricsTimeout = 200 * time.Millisecond
	tx, err := a.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec("LOCK TABLE backup_metrics IN ACCESS EXCLUSIVE MODE"); err != nil {
		t.Fatal(err)
	}
	unavailable(t, "slow")
	if err = tx.Rollback(); err != nil {
		t.Fatal(err)
	}

	// A failing read while authentication still works.
	if _, err = a.db.Exec("ALTER TABLE backup_metrics RENAME TO backup_metrics_unavailable"); err != nil {
		t.Fatal(err)
	}
	unavailable(t, "failed")
}

func TestMetricsHaveTheirOwnAdmissionSlots(t *testing.T) {
	a := newTestServer(t, "", false)
	for i := 0; i < cap(a.requests); i++ {
		a.requests <- struct{}{}
	}
	requireStatus(t, request(a, "GET", "/metrics", "", true, nil), 200)
	for i := 0; i < cap(a.requests); i++ {
		<-a.requests
	}
	for i := 0; i < cap(a.metricsRequests); i++ {
		a.metricsRequests <- struct{}{}
	}
	requireStatus(t, request(a, "GET", "/metrics", "", true, nil), 503)
	requireStatus(t, request(a, "GET", "/api/stats", "", true, nil), 200)
}

func TestMetricsAuthenticationIsBoundedWhenDatabaseHangs(t *testing.T) {
	a := newTestServer(t, "", false)
	// Create the session fixture before the lock: inserting it would block too.
	cookie := fixtureOwnerCookie(a)
	scrape := func() *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", "/metrics", nil)
		r.AddCookie(cookie)
		w := httptest.NewRecorder()
		a.ServeHTTP(w, r)
		return w
	}
	requireStatus(t, scrape(), 200)
	defer func(previous time.Duration) { metricsRequestTimeout = previous }(metricsRequestTimeout)
	metricsRequestTimeout = 200 * time.Millisecond
	tx, err := a.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err = tx.Exec("LOCK TABLE sessions IN ACCESS EXCLUSIVE MODE"); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	requireStatus(t, scrape(), 503)
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("hung authentication held the scrape for %s", elapsed)
	}
	if len(a.metricsRequests) != 0 {
		t.Fatal("scrape slot not released")
	}
}
