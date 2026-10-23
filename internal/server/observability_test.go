package server

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"

	"pocketmark/internal/observability"
)

func TestObservabilityProtectsMetricsAndCountsEarlyRejections(t *testing.T) {
	a := newTestServer(t, "", false)
	var logs bytes.Buffer
	a.observer = observability.New(slog.New(slog.NewJSONHandler(&logs, nil)), nil)
	// Route registration retains the same observer as the middleware.
	a = New(a.Store, testToken, "", false, a.observer)
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

func namedAPIKey(t *testing.T, a *Server) string {
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
