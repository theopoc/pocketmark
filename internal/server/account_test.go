package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func TestPasswordKeysAndRevocation(t *testing.T) {
	a := newTestServer(t, "", false)
	login := passwordLogin(t, a)
	oldCookie := login.Result().Cookies()[0].String()
	requireStatus(t, request(a, "PUT", "/api/account", `{"username":"me","password":"short"}`, true, nil), 400)
	w := request(a, "PUT", "/api/account", `{"username":"me","password":"correct horse battery"}`, true, nil)
	requireStatus(t, w, 200)
	requireStatus(t, request(a, "GET", "/api/session", "", false, map[string]string{"Cookie": oldCookie}), 401)
	requireStatus(t, request(a, "POST", "/api/login", `{"username":"me","password":"wrong"}`, false, nil), 401)
	requireStatus(t, request(a, "POST", "/api/login", `{"username":"me","password":"correct horse battery"}`, false, nil), 200)
	w = request(a, "POST", "/api/tokens", `{"name":"test extension"}`, true, nil)
	requireStatus(t, w, 201)
	var key apiToken
	json.Unmarshal(w.Body.Bytes(), &key)
	if len(key.Token) != 64 {
		t.Fatal("missing key")
	}
	h := map[string]string{"Authorization": "Bearer " + key.Token}
	requireStatus(t, request(a, "GET", "/api/links", "", false, h), 200)
	requireStatus(t, request(a, "GET", "/api/account", "", false, h), 403)
	requireStatus(t, request(a, "POST", "/api/tokens", `{"name":"escalate"}`, false, h), 403)
	requireStatus(t, request(a, "POST", "/api/login", `{"token":"`+key.Token+`"}`, false, nil), 400)
	w = request(a, "GET", "/api/tokens", "", true, nil)
	if strings.Contains(w.Body.String(), key.Token) {
		t.Fatal("listed raw key")
	}
	if a.Store.HasAPIKeyHash(context.Background(), key.Token) {
		t.Fatal("key stored in plaintext")
	}
	requireStatus(t, request(a, "DELETE", "/api/tokens/1", "", true, nil), 200)
	requireStatus(t, request(a, "GET", "/api/links", "", false, h), 401)
}
func TestExtensionBearerRequiredAndDAV(t *testing.T) {
	a := newTestServer(t, "", false)
	h := map[string]string{"Origin": "chrome-extension://abcdefghijklmnop", "Sec-Fetch-Site": "cross-site"}
	requireStatus(t, request(a, "OPTIONS", "/api/links", "", false, h), 204)
	requireStatus(t, request(a, "POST", "/api/links", `{"url":"https://example.org"}`, false, h), 403)
	requireStatus(t, request(a, "POST", "/api/links", `{"url":"https://example.org"}`, true, h), 201)
	requireStatus(t, request(a, "GET", "/dav/bookmarks.xbel", "", false, nil), 401)
	basic := map[string]string{"Authorization": "Basic " + base64.StdEncoding.EncodeToString([]byte("key:"+testToken))}
	w := request(a, "GET", "/dav/bookmarks.xbel", "", false, basic)
	requireStatus(t, w, 200)
	etag := w.Header().Get("ETag")
	if etag == "" || !strings.Contains(w.Body.String(), "https://example.org") {
		t.Fatal("invalid XBEL")
	}
	body := strings.ReplaceAll(w.Body.String(), "https://example.org", "https://example.net")
	basic["If-Match"] = `"stale"`
	requireStatus(t, request(a, "PUT", "/dav/bookmarks.xbel", body, false, basic), 412)
	basic["If-Match"] = etag
	requireStatus(t, request(a, "PUT", "/dav/bookmarks.xbel", body, false, basic), 204)
	delete(basic, "If-Match")
	w = request(a, "GET", "/dav/bookmarks.xbel", "", false, basic)
	if !strings.Contains(w.Body.String(), "https://example.net") {
		t.Fatal("sync lost update")
	}
	requireStatus(t, request(a, "PROPFIND", "/dav/", "", false, basic), 207)
	requireStatus(t, request(a, "GET", "/api/links?url=https%3A%2F%2Fexample.net", "", true, nil), 200)
}
