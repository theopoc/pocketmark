package server

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"pocketmark/internal/store"
)

func securityServer(t *testing.T) (*Server, *sql.DB) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "security.db")
	s, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	db, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	a := New(s, testToken, "", false)
	a.rateLimit = newRequestLimiter(100000, 100000)
	return a, db
}
func staleConfirmation(t *testing.T, db *sql.DB) {
	t.Helper()
	if _, err := db.Exec("UPDATE sessions SET confirmed_at=0"); err != nil {
		t.Fatal(err)
	}
}
func createProfileKey(t *testing.T, a *Server, profile string) string {
	t.Helper()
	w := request(a, "POST", "/api/tokens", fmt.Sprintf(`{"name":"matrix","profile":%q}`, profile), true, nil)
	requireStatus(t, w, 201)
	var key apiToken
	if err := json.Unmarshal(w.Body.Bytes(), &key); err != nil {
		t.Fatal(err)
	}
	return key.Token
}

func TestSensitiveRoutesRequireRecentPassword(t *testing.T) {
	a, db := securityServer(t)
	login := passwordLogin(t, a)
	cookie := login.Result().Cookies()[0].String()
	headers := map[string]string{"Cookie": cookie}
	staleConfirmation(t, db)
	for route, policy := range apiAccess {
		if !policy.confirm {
			continue
		}
		method, path, _ := strings.Cut(route, " ")
		path = strings.ReplaceAll(path, "{id}", "1")
		w := request(a, method, path, `{}`, false, headers)
		requireStatus(t, w, 403)
		if !strings.Contains(w.Body.String(), `"code":"reauth_required"`) {
			t.Fatalf("%s did not request reauthentication: %s", route, w.Body.String())
		}
	}
	requireStatus(t, request(a, "POST", "/api/reauth", `{"password":"wrong"}`, false, headers), 403)
	requireStatus(t, request(a, "POST", "/api/tokens", `{"name":"blocked"}`, false, headers), 403)
	requireStatus(t, request(a, "POST", "/api/reauth", `{"password":"test-only-password"}`, false, map[string]string{"Cookie": cookie, "Origin": "https://evil.test"}), 403)
	requireStatus(t, request(a, "POST", "/api/reauth", `{"password":"test-only-password"}`, false, headers), 200)
	requireStatus(t, request(a, "POST", "/api/tokens", `{"name":"confirmed"}`, false, headers), 201)
	requireStatus(t, request(a, "GET", "/api/backup", "", false, headers), 200)
	// Confirmation is bound to one session, not to the owner globally.
	other := additionalTestSession(t, a)
	if _, err := db.Exec("UPDATE sessions SET confirmed_at=0 WHERE hash=?", a.sessionHash(other.Value)); err != nil {
		t.Fatal(err)
	}
	requireStatus(t, request(a, "POST", "/api/tokens", `{"name":"other"}`, false, map[string]string{"Cookie": other.String()}), 403)
	// The former server secret is no longer an administrative credential.
	requireStatus(t, request(a, "PUT", "/api/account", `{"username":"recovered","password":"new-recovery-password"}`, false, map[string]string{"Authorization": "Bearer " + testToken}), 401)
	requireStatus(t, request(a, "GET", "/api/session", "", false, headers), 200)
}

func TestAccountChangePreservesAbsoluteSessionExpiryAndIdlePolicy(t *testing.T) {
	a, db := securityServer(t)
	old := passwordLogin(t, a).Result().Cookies()[0]
	var expiry int64
	if err := db.QueryRow("UPDATE sessions SET expires_at=unixepoch()+3600,idle_minutes=15 WHERE hash=? RETURNING expires_at", a.sessionHash(old.Value)).Scan(&expiry); err != nil {
		t.Fatal(err)
	}
	w := request(a, "PUT", "/api/account", `{"username":"me","password":"test-only-password"}`, false, map[string]string{"Cookie": old.String()})
	requireStatus(t, w, 200)
	next := w.Result().Cookies()[0]
	var storedExpiry int64
	var idleMinutes int
	if err := db.QueryRow("SELECT expires_at,idle_minutes FROM sessions WHERE hash=?", a.sessionHash(next.Value)).Scan(&storedExpiry, &idleMinutes); err != nil {
		t.Fatal(err)
	}
	if storedExpiry != expiry || idleMinutes != 15 || next.Expires.Unix() != expiry || next.MaxAge > 3600 {
		t.Fatalf("session policy changed: expiry=%d want=%d idle=%d cookie=%+v", storedExpiry, expiry, idleMinutes, next)
	}
	requireStatus(t, request(a, "GET", "/api/session", "", false, map[string]string{"Cookie": old.String()}), 401)
	requireStatus(t, request(a, "GET", "/api/session", "", false, map[string]string{"Cookie": next.String()}), 200)
}

func TestReauthenticationLimits(t *testing.T) {
	a, db := securityServer(t)
	cookie := passwordLogin(t, a).Result().Cookies()[0].String()
	staleConfirmation(t, db)
	headers := map[string]string{"Cookie": cookie}
	a.passwordMu.Lock()
	requireStatus(t, request(a, "POST", "/api/reauth", `{"password":"test-only-password"}`, false, headers), 429)
	a.passwordMu.Unlock()
	for i := 0; i < 8; i++ {
		requireStatus(t, request(a, "POST", "/api/reauth", `{"password":"wrong"}`, false, headers), 403)
	}
	w := request(a, "POST", "/api/reauth", `{"password":"test-only-password"}`, false, headers)
	requireStatus(t, w, 429)
	if w.Header().Get("Retry-After") == "" {
		t.Fatal("missing retry guidance")
	}
}

func TestAllRegisteredEndpointsRejectAnonymousAccess(t *testing.T) {
	a, _ := securityServer(t)
	for route := range nativeAPIRoutes(t) {
		method, path, _ := strings.Cut(route, " ")
		method = strings.ToUpper(method)
		if publicAuthPath(path) || path == "/healthz" || path == "/livez" {
			continue
		}
		if _, ok := apiAccess[method+" "+path]; !ok {
			t.Errorf("route has no explicit authorization policy: %s", route)
		}
		path = strings.NewReplacer("{id}", "1", "{assetId}", "1", "{annotationId}", "1").Replace(path)
		requireStatus(t, request(a, method, path, `{}`, false, nil), 401)
		if method == "GET" {
			requireStatus(t, request(a, "HEAD", path, "", false, nil), 401)
		}
	}
	for _, path := range []string{"/dav/", "/dav/bookmarks.xbel", "/dav/bookmarks.xbel.temp", "/dav/bookmarks.xbel.lock"} {
		for _, method := range []string{"GET", "HEAD", "PUT", "DELETE", "MOVE", "PROPFIND", "OPTIONS", "MKCOL", "POST"} {
			requireStatus(t, request(a, method, path, "", false, nil), 401)
		}
	}
	cookie := passwordLogin(t, a).Result().Cookies()[0].String()
	for _, path := range []string{"/api/links/1", "/api/backup", "/api/tokens"} {
		requireStatus(t, request(a, "GET", path, "", false, map[string]string{"Cookie": cookie, "Authorization": "Basic invalid"}), 401)
	}
}

func TestEveryRouteEnforcesKeyProfile(t *testing.T) {
	// Replace handlers with a sentinel so this matrix tests the real middleware
	// for every route without allocating archives or mutating library fixtures.
	a, _ := securityServer(t)
	keys := map[string]string{}
	for _, profile := range []string{"read", "capture", "sync", "full"} {
		keys[profile] = createProfileKey(t, a, profile)
	}
	mux := http.NewServeMux()
	for route := range apiAccess {
		mux.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })
	}
	a.mux = mux
	for route, policy := range apiAccess {
		method, path, _ := strings.Cut(route, " ")
		path = strings.NewReplacer("{id}", "1", "{assetId}", "1", "{annotationId}", "1").Replace(path)
		for profile, key := range keys {
			want := 403
			if !policy.owner && containsProfile(policy.profiles, profile) {
				want = 204
			}
			requireStatus(t, request(a, method, path, `{}`, false, map[string]string{"Authorization": "Bearer " + key}), want)
		}
	}
	mux.HandleFunc("POST /api/future-dangerous", func(w http.ResponseWriter, r *http.Request) { t.Fatal("unclassified route reached") })
	requireStatus(t, request(a, "POST", "/api/future-dangerous", `{}`, false, map[string]string{"Authorization": "Bearer " + keys["full"]}), 403)
}

func TestKeyProfilesRealOperationsAndRotation(t *testing.T) {
	a, db := securityServer(t)
	keys := map[string]string{}
	for _, profile := range []string{"read", "capture", "sync", "full"} {
		keys[profile] = createProfileKey(t, a, profile)
	}
	headers := func(profile string) map[string]string {
		return map[string]string{"Authorization": "Bearer " + keys[profile]}
	}
	requireStatus(t, request(a, "POST", "/api/links", `{"url":"https://example.test","title":"kept"}`, false, headers("capture")), 201)
	requireStatus(t, request(a, "PUT", "/api/links/1", `{"url":"https://example.test","title":"edited"}`, false, headers("capture")), 200)
	for _, profile := range []string{"read", "capture", "sync"} {
		requireStatus(t, request(a, "DELETE", "/api/links/1", "", false, headers(profile)), 403)
	}
	requireStatus(t, request(a, "GET", "/api/links/1", "", false, headers("read")), 200)
	requireStatus(t, request(a, "POST", "/api/import", `{}`, false, headers("capture")), 403)
	requireStatus(t, request(a, "GET", "/api/export", "", false, headers("capture")), 403)
	for profile, key := range keys {
		want := 403
		if profile == "sync" || profile == "full" {
			want = 200
		}
		for _, authorization := range []string{"Bearer " + key, "Basic " + base64.StdEncoding.EncodeToString([]byte("sync:"+key))} {
			requireStatus(t, request(a, "GET", "/dav/bookmarks.xbel", "", false, map[string]string{"Authorization": authorization}), want)
		}
	}
	w := request(a, "POST", "/api/tokens/2/rotate", "", true, nil)
	requireStatus(t, w, 200)
	var rotated map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &rotated); err != nil {
		t.Fatal(err)
	}
	requireStatus(t, request(a, "GET", "/api/session", "", false, headers("capture")), 401)
	keys["capture"] = rotated["token"]
	requireStatus(t, request(a, "GET", "/api/session", "", false, headers("capture")), 200)
	requireStatus(t, request(a, "DELETE", "/api/links/1", "", false, headers("capture")), 403)
	if _, err := db.Exec("UPDATE api_tokens SET expires_at=unixepoch()"); err != nil {
		t.Fatal(err)
	}
	requireStatus(t, request(a, "GET", "/api/session", "", false, headers("capture")), 401)
}

func TestSessionManagementHTTP(t *testing.T) {
	a, db := securityServer(t)
	first := passwordLogin(t, a).Result().Cookies()[0]
	second := additionalTestSession(t, a)
	headers := map[string]string{"Cookie": first.String()}
	w := request(a, "GET", "/api/sessions", "", false, headers)
	requireStatus(t, w, 200)
	if strings.Contains(w.Body.String(), first.Value) || strings.Contains(w.Body.String(), "hash") {
		t.Fatal("session secret exposed")
	}
	var sessions []store.Session
	if err := json.Unmarshal(w.Body.Bytes(), &sessions); err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 2 {
		t.Fatalf("expected two browser sessions, got %d", len(sessions))
	}
	requireStatus(t, request(a, "PATCH", "/api/sessions/current", `{"idleTimeoutMinutes":15}`, false, headers), 200)
	requireStatus(t, request(a, "PATCH", "/api/sessions/current", `{"idleTimeoutMinutes":1}`, false, headers), 400)
	requireStatus(t, request(a, "DELETE", "/api/sessions/others", "", false, headers), 200)
	requireStatus(t, request(a, "GET", "/api/session", "", false, map[string]string{"Cookie": second.String()}), 401)
	requireStatus(t, request(a, "GET", "/api/session", "", false, headers), 200)
	if _, err := db.Exec("UPDATE sessions SET last_used_at=unixepoch()-900"); err != nil {
		t.Fatal(err)
	}
	requireStatus(t, request(a, "GET", "/api/session", "", false, headers), 401)
}

func TestHeadCannotBypassBackupConfirmation(t *testing.T) {
	a, db := securityServer(t)
	cookie := passwordLogin(t, a).Result().Cookies()[0]
	staleConfirmation(t, db)
	r := httptest.NewRequest("HEAD", "http://pocketmark.test/api/backup", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	a.ServeHTTP(w, r)
	requireStatus(t, w, 403)
}

func TestKeyCreationDefaultsAndValidation(t *testing.T) {
	a, _ := securityServer(t)
	for _, body := range []string{`{"name":"invalid","profile":"admin"}`, `{"name":"invalid","expiresAt":-1}`, `{"name":"invalid","expiresAt":1}`, `{"name":"invalid","profile":false}`} {
		requireStatus(t, request(a, "POST", "/api/tokens", body, true, nil), 400)
	}
	w := request(a, "POST", "/api/tokens", `{"name":"default"}`, true, nil)
	requireStatus(t, w, 201)
	var key apiToken
	if err := json.Unmarshal(w.Body.Bytes(), &key); err != nil {
		t.Fatal(err)
	}
	if key.Profile != "read" || key.ExpiresAt != 0 {
		t.Fatal("unexpected default policy")
	}
	requireStatus(t, request(a, "POST", "/api/links", `{"url":"https://example.test"}`, false, map[string]string{"Authorization": "Bearer " + key.Token}), 403)
}

func TestIndividualSessionRevocation(t *testing.T) {
	a, _ := securityServer(t)
	cookie := passwordLogin(t, a).Result().Cookies()[0]
	other := additionalTestSession(t, a)
	h := map[string]string{"Cookie": cookie.String()}
	w := request(a, "GET", "/api/sessions", "", false, h)
	var sessions []store.Session
	if err := json.Unmarshal(w.Body.Bytes(), &sessions); err != nil {
		t.Fatal(err)
	}
	requireStatus(t, request(a, "DELETE", fmt.Sprintf("/api/sessions/%d", sessions[0].ID), "", false, h), 200)
	requireStatus(t, request(a, "GET", "/api/session", "", false, map[string]string{"Cookie": other.String()}), 401)
	requireStatus(t, request(a, "GET", "/api/session", "", false, h), 200)
	requireStatus(t, request(a, "DELETE", fmt.Sprintf("/api/sessions/%d", sessions[0].ID), "", false, h), 404)
}
