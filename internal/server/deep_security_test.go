package server

import (
	"context"
	"io"
	"net/http/httptest"
	"net/url"
	"strings"

	"pocketmark/internal/store"
	"testing"
	"time"

	"github.com/pquerna/otp/totp"
)

func TestSecurityAuthorizationAndInjection(t *testing.T) {
	a := newTestServer(t, "https://bookmarks.example", true)
	requireStatus(t, request(a, "POST", "/api/setup", setupRequest, false, nil), 201)
	key := namedAPIKey(t, a)
	for _, path := range []string{"/api/account", "/api/tokens", "/api/backup"} {
		requireStatus(t, request(a, "GET", path, "", false, map[string]string{"Authorization": "Bearer " + key}), 403)
	}
	for _, path := range []string{"/api/account", "/api/tokens", "/api/backup", "/api/links", "/api/export", "/api/assets/1/view", "/api/links/1/reader", "/metrics", "/api/session"} {
		requireStatus(t, request(a, "GET", path, "", false, nil), 401)
	}
	for _, path := range []string{"/api%2faccount", "/api/%61ccount", "/api/account%00", "/api/account;ignored"} {
		w := request(a, "GET", path, "", false, nil)
		if w.Code >= 200 && w.Code < 300 {
			t.Fatal("auth bypass", path, w.Code)
		}
	}
	for _, auth := range []string{"Bearer ", "Bearer invalid", "Basic abc", testToken} {
		w := request(a, "GET", "/api/account", "", false, map[string]string{"Authorization": auth})
		if w.Code == 200 {
			t.Fatal("auth scheme accepted", auth)
		}
	}
	for _, origin := range []string{"null", "https://bookmarks.example.attacker.test", "https://bookmarks.example:443", "http://bookmarks.example"} {
		requireStatus(t, request(a, "POST", "/api/collections", `{"name":"blocked"}`, true, map[string]string{"Origin": origin}), 403)
	}
	for _, ct := range []string{"text/plain", "application/x-www-form-urlencoded", "multipart/form-data"} {
		requireStatus(t, request(a, "POST", "/api/login", setupCredentials, false, map[string]string{"Content-Type": ct}), 415)
	}
	for _, q := range []string{`' OR 1=1 --`, `";DROP TABLE links;--`, `NEAR(x,y)`, `* OR *`, `<img src=x onerror=alert(1)>`} {
		w := request(a, "GET", "/api/links?q="+url.QueryEscape(q), "", true, nil)
		if w.Code != 200 && w.Code != 400 {
			t.Fatalf("search %q status %d", q, w.Code)
		}
	}
	requireStatus(t, request(a, "POST", "/api/collections", `{"name":"still-intact"}`, true, nil), 201)
}

type importBlockingReader struct {
	first   bool
	reached chan struct{}
	release chan struct{}
}

func (r *importBlockingReader) Read(p []byte) (int, error) {
	if !r.first {
		r.first = true
		return copy(p, "<DL><DT><A HREF=\"https://example.test/slow\">"), nil
	}
	select {
	case <-r.reached:
	default:
		close(r.reached)
	}
	<-r.release
	return 0, io.EOF
}
func TestSlowHTMLImportLeavesDatabaseAvailable(t *testing.T) {
	a := newTestServer(t, "", false)
	key := createProfileKey(t, a, "full")
	reader := &importBlockingReader{reached: make(chan struct{}), release: make(chan struct{})}
	done := make(chan struct{})
	defer func() { close(reader.release); <-done }()
	go func() {
		defer close(done)
		r := httptest.NewRequest("POST", "http://pocketmark.test/api/import/html", reader)
		r.Header.Set("Authorization", "Bearer "+key)
		a.ServeHTTP(httptest.NewRecorder(), r)
	}()
	select {
	case <-reader.reached:
	case <-time.After(time.Second):
		t.Fatal("reader never reached")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	r := httptest.NewRequest("GET", "/api/stats", nil).WithContext(ctx)
	r.Header.Set("Authorization", "Bearer "+testToken)
	w := httptest.NewRecorder()
	a.ServeHTTP(w, r)
	requireStatus(t, w, 200)
	health := request(a, "GET", "/healthz", "", false, nil)
	requireStatus(t, health, 200)
	requireStatus(t, request(a, "GET", "/livez", "", false, nil), 200)
}

func TestBackupRestoreExcludesSessions(t *testing.T) {
	a := newTestServer(t, "", false)
	w := request(a, "POST", "/api/setup", setupRequest, false, nil)
	requireStatus(t, w, 201)
	cookie, secret, _, _ := enrollForTest(t, a, pendingCookie(t, w), "")
	headers := map[string]string{"Cookie": cookie}
	key := namedAPIKey(t, a)
	requireStatus(t, request(a, "POST", "/api/links", `{"url":"https://example.test/restore","notes":"Keep across restore"}`, true, nil), 201)
	snapshot, err := a.Store.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	path := snapshot.Name()
	snapshot.Close()
	requireStatus(t, request(a, "GET", "/api/account", "", false, headers), 200)
	requireStatus(t, request(a, "POST", "/api/logout", "", false, headers), 200)
	requireStatus(t, request(a, "GET", "/api/account", "", false, headers), 401)
	restored, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	old := New(restored, testToken, "", false)
	restoredResponse := request(old, "GET", "/api/account", "", false, headers)
	requireStatus(t, restoredResponse, 401)
	login := request(old, "POST", "/api/login", setupCredentials, false, nil)
	requireStatus(t, login, 200)
	code, err := totp.GenerateCode(secret, time.Now().Add(30*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	verified := request(old, "POST", "/api/mfa/verify", `{"code":"`+code+`"}`, false, map[string]string{"Cookie": pendingCookie(t, login)})
	requireStatus(t, verified, 200)
	fresh := map[string]string{"Cookie": responseCookie(t, verified, "pocketmark")}
	if err := restored.Close(); err != nil {
		t.Fatal(err)
	}
	restarted, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	server := New(restarted, testToken, "", false)
	requireStatus(t, request(server, "GET", "/api/account", "", false, headers), 401)
	requireStatus(t, request(server, "GET", "/api/account", "", false, fresh), 200)
	links := request(server, "GET", "/api/links", "", false, map[string]string{"Authorization": "Bearer " + key})
	requireStatus(t, links, 200)
	if !strings.Contains(links.Body.String(), "Keep across restore") {
		t.Fatal("backup lost library data")
	}
}
