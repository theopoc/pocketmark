package server

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
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
}
