package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"pocketmark/internal/observability"
	"pocketmark/internal/store"
)

func diagnosticServer(t *testing.T) (*testServer, *bytes.Buffer) {
	t.Helper()
	a := newTestServer(t, "", false)
	logs := &bytes.Buffer{}
	return a.withServer(New(a.Store, testToken, "", false, observability.New(slog.New(slog.NewJSONHandler(logs, nil)), nil))), logs
}

func TestDatabaseFailureIsNotInvalidCredentials(t *testing.T) {
	a, logs := diagnosticServer(t)
	cookie := fixtureOwnerCookie(a)
	key := namedAPIKey(t, a)
	if err := a.Store.Close(); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		method, path, body string
		credential         bool
	}{
		{"GET", "/api/stats", "", true},
		{"GET", "/healthz", "", false},
		{"POST", "/api/login", `{"username":"fixture","password":"private-password"}`, false},
		{"GET", "/metrics", "", false},
	} {
		logs.Reset()
		r := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
		if tc.body != "" {
			r.Header.Set("Content-Type", "application/json")
		}
		if tc.credential {
			r.AddCookie(cookie)
		}
		if tc.path == "/metrics" {
			r.Header.Set("Authorization", "Bearer "+key)
		}
		w := httptest.NewRecorder()
		a.ServeHTTP(w, r)
		if w.Code != 503 {
			t.Fatalf("%s: status %d", tc.path, w.Code)
		}
		var entry map[string]any
		if err := json.NewDecoder(logs).Decode(&entry); err != nil {
			t.Fatal(err)
		}
		if entry["level"] != "ERROR" || entry["error_code"] == nil || entry["request_id"] != w.Header().Get("X-Request-ID") {
			t.Fatalf("uncorrelated failure: %v", entry)
		}
		if strings.Contains(fmt.Sprint(entry), "private-password") || strings.Contains(fmt.Sprint(entry), key) {
			t.Fatal("credentials leaked")
		}
	}
}

func TestOperationalFailuresAndValidationHaveDifferentStatus(t *testing.T) {
	a, logs := diagnosticServer(t)
	w := request(a, "POST", "/api/links", `{"url":"invalid"}`, true, nil)
	requireStatus(t, w, 400)
	if strings.Contains(logs.String(), `"level":"ERROR"`) {
		t.Fatal("validation logged as server fault")
	}
	if err := a.Store.Close(); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/collections", "/dav/bookmarks.xbel"} {
		logs.Reset()
		w := httptest.NewRecorder()
		handler := a.collections
		if strings.HasPrefix(path, "/dav/") {
			handler = a.dav
		}
		// Exercise storage failure after authentication has already succeeded.
		a.observer.HTTP(w, httptest.NewRequest("GET", path, nil), path, handler)
		requireStatus(t, w, 500)
		if !strings.Contains(logs.String(), `"msg":"request_failed"`) {
			t.Fatal("storage failure missing")
		}
	}
}

func TestCaptureQueueCorrelationAndOfflineFailure(t *testing.T) {
	a, logs := diagnosticServer(t)
	id, err := a.Store.Create(context.Background(), store.Link{URL: "http://127.0.0.1/private?token=private-secret"})
	if err != nil {
		t.Fatal(err)
	}
	w := request(a, "POST", fmt.Sprintf("/api/links/%d/capture", id), "", true, nil)
	requireStatus(t, w, 202)
	var entry map[string]any
	if err := json.NewDecoder(logs).Decode(&entry); err != nil {
		t.Fatal(err)
	}
	if entry["msg"] != "capture_queued" || entry["link_id"] != float64(id) || entry["request_id"] != w.Header().Get("X-Request-ID") {
		t.Fatalf("queue correlation: %v", entry)
	}
	logs.Reset()
	w = request(a, "POST", fmt.Sprintf("/api/links/%d/preserve", id), "", true, nil)
	requireStatus(t, w, 400)
	if !strings.Contains(logs.String(), `"error_code":"destination_blocked"`) || strings.Contains(logs.String(), "private-secret") {
		t.Fatalf("offline diagnostic: %s", logs.String())
	}
}

var _ http.Handler = (*Server)(nil)

type interruptedImport struct{}

func (interruptedImport) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }

func TestImportInputFailuresAreNotServerIncidents(t *testing.T) {
	a, logs := diagnosticServer(t)
	cookie := fixtureOwnerCookie(a)
	for _, path := range []string{"/api/import", "/api/import/html"} {
		logs.Reset()
		r := httptest.NewRequest("POST", path, interruptedImport{})
		r.AddCookie(cookie)
		w := httptest.NewRecorder()
		a.ServeHTTP(w, r)
		requireStatus(t, w, 400)
		if strings.Contains(logs.String(), `"level":"ERROR"`) {
			t.Fatal("input interruption counted as server failure")
		}
	}
	logs.Reset()
	w := request(a, "POST", "/api/import/html", "<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><DT><A HREF=\"https://example.test\">"+strings.Repeat("x", 129<<10)+"</A></DL>", true, nil)
	requireStatus(t, w, 400)
	if strings.Contains(logs.String(), `"level":"ERROR"`) {
		t.Fatal("tokenizer bound counted as server failure")
	}
}

func TestExportLimitMarksPartialResponseAsFailed(t *testing.T) {
	a, logs := diagnosticServer(t)
	var parent *int64
	for i := 0; i < 102; i++ {
		id, err := a.Store.AddCollection(context.Background(), store.Collection{Name: "folder", ParentID: parent})
		if err != nil {
			t.Fatal(err)
		}
		parent = &id
	}
	w := request(a, "GET", "/api/export/html", "", true, nil)
	requireStatus(t, w, 200) // Headers and part of the file have already been written.
	for _, want := range []string{`"error_code":"hierarchy_limit"`, `"outcome":"failed"`} {
		if !strings.Contains(logs.String(), want) {
			t.Fatalf("partial export unreported: %s", logs.String())
		}
	}
}
