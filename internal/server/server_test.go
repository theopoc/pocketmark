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

func passwordLogin(t *testing.T, a *Server) *httptest.ResponseRecorder {
	t.Helper()
	salt := randomSecret()
	if err := a.Store.SaveAccount(context.Background(), store.Account{Username: "me", Salt: salt, Hash: passwordHash("test-only-password", salt)}); err != nil {
		t.Fatal(err)
	}
	if err := a.Store.ResetMFA(context.Background()); err != nil {
		t.Fatal(err)
	}
	w := request(a, "POST", "/api/login", `{"username":"me","password":"test-only-password"}`, false, nil)
	if w.Code != 200 {
		return w
	}
	_, _, _, result, _ := enrollForTest(t, a, pendingCookie(t, w), testToken)
	return result
}

// Tests of session management create an additional persisted session directly;
// the MFA integration tests exercise the real two-step login separately.
func additionalTestSession(t *testing.T, a *Server) *http.Cookie {
	t.Helper()
	account, err := a.Store.Account(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	value := "v3." + randomSecret()
	if err = a.Store.CreateSession(context.Background(), account.Salt, a.sessionHash(value), time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	return &http.Cookie{Name: "pocketmark", Value: value}
}

func fixtureOwnerCookie(a *Server) *http.Cookie {
	// Most route tests need an owner, not a recovery bearer. Construct a
	// confirmed session in the disposable database; authentication flows
	// themselves are exercised separately using real MFA challenges.
	ctx := context.Background()
	account, err := a.Store.Account(ctx)
	if err != nil {
		salt := randomSecret()
		account = store.Account{Username: "fixture", Salt: salt, Hash: passwordHash("fixture-password", salt)}
		if err = a.Store.SaveAccount(ctx, account); err != nil {
			panic(err)
		}
	}
	value := "v3." + strings.Repeat("a", 64)
	hash := a.sessionHash(value)
	state, err := a.Store.MFA(ctx)
	if err != nil {
		panic(err)
	}
	if len(state.Secret) == 0 {
		secret, e := a.encryptMFA("JBSWY3DPEHPK3PXP")
		if e != nil {
			panic(e)
		}
		if e = a.Store.ActivateMFA(ctx, account.Salt, state.Generation, 0, secret, nil, "", hash, time.Now().Add(time.Hour), "fixture", false); e != nil {
			panic(e)
		}
	}
	if !a.Store.SessionValid(ctx, hash) {
		if err = a.Store.CreateSession(ctx, account.Salt, hash, time.Now().Add(time.Hour)); err != nil {
			panic(err)
		}
	}
	return &http.Cookie{Name: "pocketmark", Value: value}
}

func request(a *Server, method, path, body string, bearer bool, headers map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://pocketmark.test"+path, strings.NewReader(body))
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	if bearer {
		r.AddCookie(fixtureOwnerCookie(a))
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
	requireStatus(t, request(a, "POST", "/api/login", `{"username":"me","password":"wrong"}`, false, nil), 401)
	w := passwordLogin(t, a)
	requireStatus(t, w, 200)
	var cookie *http.Cookie
	for _, c := range w.Result().Cookies() {
		if c.Name == "pocketmark" {
			cookie = c
		}
	}
	if cookie == nil {
		t.Fatal("session cookie missing")
	}
	if cookie.Name != "pocketmark" || !cookie.HttpOnly || !cookie.Secure || cookie.SameSite != http.SameSiteStrictMode || cookie.Path != "/" || cookie.MaxAge <= 0 {
		t.Fatalf("unsafe session cookie: %+v", cookie)
	}
	if strings.Contains(cookie.Value, testToken) {
		t.Fatal("session cookie exposed access token")
	}
	requireStatus(t, request(a, "GET", "/api/session", "", false, map[string]string{"Cookie": cookie.String()}), 200)
	requireStatus(t, request(a, "GET", "/api/session", "", false, map[string]string{"Cookie": "pocketmark=" + cookie.Value + "tampered"}), 401)
	expiry := strconv.FormatInt(time.Now().Add(-time.Hour).Unix(), 10)
	requireStatus(t, request(a, "GET", "/api/session", "", false, map[string]string{"Cookie": "pocketmark=" + expiry + "." + a.sessionHash(expiry)}), 401)
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
		requireStatus(t, request(a, "POST", "/api/login", `{"username":"me","password":"wrong"}`, false, nil), 401)
	}
	w := passwordLogin(t, a)
	requireStatus(t, w, 429)
	if w.Header().Get("Retry-After") == "" {
		t.Fatal("missing retry guidance")
	}
	for key, window := range a.loginAttempts {
		window.at = time.Now().Add(-2 * time.Minute)
		a.loginAttempts[key] = window
	}
	requireStatus(t, passwordLogin(t, a), 200)
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
	finishTestCapture(t, a.Store, link.ID, "", nil)
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
	finishTestCapture(t, a.Store, id, "", raw)
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

func finishTestCapture(t *testing.T, s *store.Store, id int64, content string, archive []byte) {
	t.Helper()
	link, err := s.Next(context.Background())
	if err != nil || link.ID != id {
		t.Fatalf("claim capture %d: %+v (%v)", id, link, err)
	}
	if err = s.Finish(context.Background(), link, "", "", content, archive, nil); err != nil {
		t.Fatal(err)
	}
}
