package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"pocketmark/internal/store"
)

const testToken = "test-only-token-with-enough-entropy"

func newTestServer(t *testing.T, origin string, secure bool) *Server {
	t.Helper()
	s, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Error(err)
		}
	})
	return New(s, testToken, origin, secure)
}

func request(a *Server, method, path, body string, bearer bool, headers map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://pocketmark.test"+path, strings.NewReader(body))
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	if bearer {
		r.Header.Set("Authorization", "Bearer "+testToken)
	}
	for key, value := range headers {
		r.Header.Set(key, value)
	}
	w := httptest.NewRecorder()
	a.ServeHTTP(w, r)
	return w
}

func requireStatus(t *testing.T, w *httptest.ResponseRecorder, status int) {
	t.Helper()
	if w.Code != status {
		t.Fatalf("status %d, want %d: %s", w.Code, status, w.Body.String())
	}
}

func TestAuthenticationCookieAndBearer(t *testing.T) {
	a := newTestServer(t, "", true)
	for _, path := range []string{"/api/session", "/api/links", "/api/export", "/api/stats", "/api/collections", "/api/tags"} {
		requireStatus(t, request(a, "GET", path, "", false, nil), 401)
		requireStatus(t, request(a, "GET", path, "", true, nil), 200)
	}
	requireStatus(t, request(a, "POST", "/api/login", `{"token":"wrong"}`, false, nil), 401)
	w := request(a, "POST", "/api/login", `{"token":"`+testToken+`"}`, false, nil)
	requireStatus(t, w, 200)
	cookies := w.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("cookies: %v", cookies)
	}
	cookie := cookies[0]
	if cookie.Name != "pocketmark" || !cookie.HttpOnly || !cookie.Secure || cookie.SameSite != http.SameSiteStrictMode || cookie.Path != "/" || cookie.MaxAge <= 0 {
		t.Fatalf("unsafe session cookie: %+v", cookie)
	}
	if strings.Contains(cookie.Value, testToken) {
		t.Fatal("session cookie exposed access token")
	}
	requireStatus(t, request(a, "GET", "/api/session", "", false, map[string]string{"Cookie": cookie.String()}), 200)
	requireStatus(t, request(a, "GET", "/api/session", "", false, map[string]string{"Cookie": "pocketmark=" + cookie.Value + "tampered"}), 401)
	expiry := strconv.FormatInt(time.Now().Add(-time.Hour).Unix(), 10)
	requireStatus(t, request(a, "GET", "/api/session", "", false, map[string]string{"Cookie": "pocketmark=" + expiry + "." + a.sign(expiry)}), 401)
	requireStatus(t, request(a, "GET", "/api/session", "", false, map[string]string{"Authorization": "Bearer wrong", "Cookie": cookie.String()}), 401)
	w = request(a, "POST", "/api/logout", "", false, map[string]string{"Cookie": cookie.String()})
	requireStatus(t, w, 200)
	if got := w.Result().Cookies(); len(got) != 1 || got[0].MaxAge != -1 {
		t.Fatalf("logout did not expire cookie: %v", got)
	}
}

func TestLoginRateLimitAndReset(t *testing.T) {
	a := newTestServer(t, "", false)
	for i := 0; i < 10; i++ {
		requireStatus(t, request(a, "POST", "/api/login", `{"token":"wrong"}`, false, nil), 401)
	}
	w := request(a, "POST", "/api/login", `{"token":"`+testToken+`"}`, false, nil)
	requireStatus(t, w, 429)
	if w.Header().Get("Retry-After") == "" {
		t.Fatal("missing retry guidance")
	}
	a.loginAt = time.Now().Add(-2 * time.Minute)
	requireStatus(t, request(a, "POST", "/api/login", `{"token":"`+testToken+`"}`, false, nil), 200)
}

func TestOriginAndFetchSiteProtection(t *testing.T) {
	for _, tc := range []struct {
		origin, sent string
		status       int
	}{
		{"", "http://pocketmark.test", 201},
		{"", "https://attacker.test", 403},
		{"https://bookmarks.example", "https://bookmarks.example", 201},
		{"https://bookmarks.example/", "https://bookmarks.example", 201},
		{"https://bookmarks.example", "http://bookmarks.example", 403},
		{"https://bookmarks.example", "https://bookmarks.example.attacker.test", 403},
		{"https://bookmarks.example", "http://pocketmark.test", 403},
	} {
		a := newTestServer(t, tc.origin, true)
		requireStatus(t, request(a, "POST", "/api/collections", `{"name":"Reading"}`, true, map[string]string{"Origin": tc.sent}), tc.status)
	}
	a := newTestServer(t, "", false)
	requireStatus(t, request(a, "POST", "/api/collections", `{"name":"Reading"}`, true, map[string]string{"Sec-Fetch-Site": "cross-site"}), 403)
	requireStatus(t, request(a, "POST", "/api/login", `{"token":"`+testToken+`"}`, false, map[string]string{"Origin": "https://attacker.test"}), 403)
	requireStatus(t, request(a, "POST", "/api/collections", `{"name":"Reading"}`, true, map[string]string{"Origin": "https://attacker.test", "X-Forwarded-Host": "attacker.test", "X-Forwarded-Proto": "https"}), 403)
}

func TestSecurityHeadersAndHealth(t *testing.T) {
	a := newTestServer(t, "", false)
	for _, path := range []string{"/healthz", "/api/links"} {
		w := request(a, "GET", path, "", false, nil)
		if path == "/healthz" {
			requireStatus(t, w, 200)
		} else {
			requireStatus(t, w, 401)
		}
		for key, want := range map[string]string{"X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY"} {
			if got := w.Header().Get(key); got != want {
				t.Errorf("%s=%q want %q", key, got, want)
			}
		}
		if !strings.Contains(w.Header().Get("Content-Security-Policy"), "frame-ancestors 'none'") {
			t.Fatal("missing CSP frame restriction")
		}
		if path == "/api/links" && w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("API response permits caching")
		}
	}
}

func TestCRUDSearchAndGetCannotMutate(t *testing.T) {
	a := newTestServer(t, "", false)
	w := request(a, "POST", "/api/collections", `{"name":"Engineering"}`, true, nil)
	requireStatus(t, w, 201)
	var collection store.Collection
	if err := json.Unmarshal(w.Body.Bytes(), &collection); err != nil {
		t.Fatal(err)
	}
	body := fmt.Sprintf(`{"url":"https://example.com/rust","title":"Rust memory guide","collectionId":%d,"tags":["systems"],"favorite":true}`, collection.ID)
	w = request(a, "POST", "/api/links", body, true, nil)
	requireStatus(t, w, 201)
	var link store.Link
	if err := json.Unmarshal(w.Body.Bytes(), &link); err != nil {
		t.Fatal(err)
	}
	path := fmt.Sprintf("/api/links/%d", link.ID)
	for _, query := range []string{"q=memory", "tag=systems", "favorite=1", "unread=1", "collection=" + strconv.FormatInt(collection.ID, 10)} {
		w = request(a, "GET", "/api/links?"+query, "", true, nil)
		requireStatus(t, w, 200)
		var page store.Page
		if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil {
			t.Fatal(err)
		}
		if page.Total != 1 || len(page.Links) != 1 || page.Links[0].ID != link.ID {
			t.Fatalf("filter %s returned %+v", query, page)
		}
	}
	if _, err := a.Store.DB.Exec("UPDATE links SET status='ready' WHERE id=?", link.ID); err != nil {
		t.Fatal(err)
	}
	for _, mutationPath := range []string{path + "/capture", "/api/logout", "/api/import"} {
		w = request(a, "GET", mutationPath, "", true, nil)
		if w.Code < 400 {
			t.Fatalf("GET accepted mutation path %s: %d", mutationPath, w.Code)
		}
	}
	got, err := a.Store.Get(context.Background(), link.ID)
	if err != nil || got.Status != "ready" {
		t.Fatalf("GET mutated capture state: %+v %v", got, err)
	}
	requireStatus(t, request(a, "POST", path+"/capture", "", true, nil), 202)
	got, err = a.Store.Get(context.Background(), link.ID)
	if err != nil || got.Status != "pending" {
		t.Fatalf("POST did not queue capture: %+v %v", got, err)
	}
	body = `{"url":"https://example.com/rust","title":"Updated title","tags":["go"],"read":true}`
	requireStatus(t, request(a, "PUT", path, body, true, nil), 200)
	w = request(a, "GET", "/api/links?unread=1", "", true, nil)
	var page store.Page
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil || page.Total != 0 {
		t.Fatalf("read filter: %s (%v)", w.Body.String(), err)
	}
	requireStatus(t, request(a, "DELETE", path, "", true, nil), 200)
	requireStatus(t, request(a, "GET", path, "", true, nil), 404)
	requireStatus(t, request(a, "DELETE", "/api/collections/"+strconv.FormatInt(collection.ID, 10), "", true, nil), 200)
}

func TestImportExportRoundTrip(t *testing.T) {
	a := newTestServer(t, "", false)
	upstream := `{"collections":[{"id":7,"name":"Reference","links":[{"url":"https://example.com/guide","name":"A guide","type":"url","tags":[{"name":"docs"}]}]}],"pinnedLinks":[{"url":"https://example.com/guide"}]}`
	w := request(a, "POST", "/api/import", upstream, true, nil)
	requireStatus(t, w, 200)
	var imported store.ImportResult
	if err := json.Unmarshal(w.Body.Bytes(), &imported); err != nil || imported.Imported != 1 {
		t.Fatalf("import response: %s %v", w.Body.String(), err)
	}
	w = request(a, "GET", "/api/export", "", true, nil)
	requireStatus(t, w, 200)
	if !json.Valid(w.Body.Bytes()) || !strings.Contains(w.Header().Get("Content-Disposition"), "attachment") {
		t.Fatal("export is not a JSON download")
	}
	b := newTestServer(t, "", false)
	requireStatus(t, request(b, "POST", "/api/import", w.Body.String(), true, nil), 200)
	page, err := b.Store.List(context.Background(), store.Filter{Tag: "docs", Favorite: true})
	if err != nil || page.Total != 1 || page.Links[0].Title != "A guide" || page.Links[0].CollectionID == nil {
		t.Fatalf("roundtrip: %+v %v", page, err)
	}
}

func TestArchiveAlwaysDownloadsSandboxed(t *testing.T) {
	a := newTestServer(t, "", false)
	id, err := a.Store.Create(context.Background(), store.Link{URL: "https://example.com"})
	if err != nil {
		t.Fatal(err)
	}
	raw := []byte(`<html><script>alert(document.cookie)</script></html>`)
	if _, err := a.Store.DB.Exec("UPDATE links SET archive=? WHERE id=?", raw, id); err != nil {
		t.Fatal(err)
	}
	path := fmt.Sprintf("/api/links/%d/archive", id)
	requireStatus(t, request(a, "GET", path, "", false, nil), 401)
	w := request(a, "GET", path, "", true, nil)
	requireStatus(t, w, 200)
	if !bytes.Equal(w.Body.Bytes(), raw) {
		t.Fatal("archive changed")
	}
	if w.Header().Get("Content-Type") != "application/octet-stream" || !strings.HasPrefix(w.Header().Get("Content-Disposition"), "attachment;") || w.Header().Get("Content-Security-Policy") != "sandbox; default-src 'none'" || w.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("unsafe archive headers: %v", w.Header())
	}
}

func TestRejectsOversizedAndAmbiguousJSON(t *testing.T) {
	a := newTestServer(t, "", false)
	for _, body := range []string{
		`{"url":"https://example.com","notes":"` + strings.Repeat("a", 101*1024) + `"}`,
		`{"url":"https://example.com"} {"url":"https://another.example"}`,
		`{"url":"https://example.com","unknown":true}`,
	} {
		requireStatus(t, request(a, "POST", "/api/links", body, true, nil), 400)
	}
	requireStatus(t, request(a, "POST", "/api/login", `{"token":"`+strings.Repeat("a", 4096)+`"}`, false, nil), 400)
	requireStatus(t, request(a, "POST", "/api/import", `{"links":[],"padding":"`+strings.Repeat("a", 8*1024*1024)+`"}`, true, nil), 400)
	requireStatus(t, request(a, "POST", "/api/links", `{"url":"https://example.com"}`, true, map[string]string{"Content-Type": "text/plain"}), 415)
	page, err := a.Store.List(context.Background(), store.Filter{})
	if err != nil || page.Total != 0 {
		t.Fatalf("rejected request changed database: %+v %v", page, err)
	}
}

func TestValidateOrigin(t *testing.T) {
	for _, origin := range []string{"", "http://localhost:8080", "https://bookmarks.example", "https://bookmarks.example/"} {
		if err := ValidateOrigin(origin); err != nil {
			t.Errorf("rejected origin %q: %v", origin, err)
		}
	}
	for _, origin := range []string{"https://bookmarks.example/path", "https://user:pass@bookmarks.example", "https://bookmarks.example?query=1", "https://bookmarks.example#fragment", "javascript:alert(1)", "bookmarks.example"} {
		if err := ValidateOrigin(origin); err == nil {
			t.Errorf("accepted bad origin %q", origin)
		}
	}
}
