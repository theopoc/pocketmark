package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"path/filepath"
	"pocketmark/internal/store"
	"strings"
	"testing"
)

func TestDAVKeysOnlyWithoutLoginThrottleOrTmpfs(t *testing.T) {
	a := newTestServer(t, "", false)
	requireStatus(t, request(a, "PUT", "/api/account", `{"username":"me","password":"correct horse battery"}`, true, nil), 200)
	basic := func(password string) map[string]string {
		return map[string]string{"Authorization": "Basic " + base64.StdEncoding.EncodeToString([]byte("me:"+password))}
	}
	for i := 0; i < 12; i++ {
		requireStatus(t, request(a, "OPTIONS", "/dav/", "", false, basic("correct horse battery")), 401)
	}
	if a.loginCount != 0 {
		t.Fatal("DAV used browser login throttle")
	}
	requireStatus(t, request(a, "POST", "/api/login", `{"username":"me","password":"correct horse battery"}`, false, nil), 200)
	w := request(a, "POST", "/api/tokens", `{"name":"DAV"}`, true, nil)
	requireStatus(t, w, 201)
	var key apiToken
	if e := json.Unmarshal(w.Body.Bytes(), &key); e != nil {
		t.Fatal(e)
	}
	for i := 0; i < 12; i++ {
		requireStatus(t, request(a, "OPTIONS", "/dav/", "", false, basic(key.Token)), 204)
	}
	// The export must stage beside the database, even when the global temp
	// directory is unavailable (or a small RAM-backed mount in Docker).
	t.Setenv("TMPDIR", filepath.Join(t.TempDir(), "missing"))
	requireStatus(t, request(a, "GET", "/dav/bookmarks.xbel", "", false, basic(key.Token)), 200)
}

func TestFloccusDAVLockTempMoveExactBytesAndInvalidation(t *testing.T) {
	a := newTestServer(t, "", false)
	ctx := context.Background()
	id, e := a.Store.Create(ctx, store.Link{URL: "https://old.example", Title: "Original", Description: "keep description", Notes: "private", Favorite: true})
	if e != nil {
		t.Fatal(e)
	}
	h := map[string]string{"Origin": "chrome-extension://floccus", "Sec-Fetch-Site": "cross-site", "Authorization": "Basic " + base64.StdEncoding.EncodeToString([]byte("arbitrary:"+testToken))}
	requireStatus(t, request(a, "OPTIONS", "/dav/", "", false, map[string]string{"Origin": h["Origin"], "Access-Control-Request-Method": "PROPFIND"}), 204)
	requireStatus(t, request(a, "PROPFIND", "/dav/", "", false, h), 207)
	requireStatus(t, request(a, "PROPFIND", "/dav/", "", false, map[string]string{"Origin": h["Origin"]}), 403)
	login := request(a, "POST", "/api/login", `{"token":"`+testToken+`"}`, false, nil)
	requireStatus(t, login, 200)
	requireStatus(t, request(a, "PROPFIND", "/dav/", "", false, map[string]string{"Origin": h["Origin"], "Authorization": "Basic invalid-base64", "Cookie": login.Result().Cookies()[0].String()}), 401)
	w := request(a, "GET", "/dav/bookmarks.xbel", "", false, h)
	requireStatus(t, w, 200)
	if !strings.Contains(w.Body.String(), `id="1"`) || strings.Contains(w.Body.String(), `id="b-`) {
		t.Fatalf("nonnumeric IDs %s", w.Body.String())
	}
	requireStatus(t, request(a, "GET", "/dav/bookmarks.xbel.lock", "", false, h), 404)
	requireStatus(t, request(a, "PUT", "/dav/bookmarks.xbel.lock", "lock", false, h), 201)
	requireStatus(t, request(a, "GET", "/dav/bookmarks.xbel", "", false, h), 200)
	w = request(a, "GET", "/dav/bookmarks.xbel.lock", "", false, h)
	requireStatus(t, w, 200)
	if w.Header().Get("Last-Modified") == "" {
		t.Fatal("missing lock timestamp")
	}
	other := request(a, "POST", "/api/tokens", `{"name":"otherDAV"}`, true, nil)
	requireStatus(t, other, 201)
	var key apiToken
	json.Unmarshal(other.Body.Bytes(), &key)
	otherH := map[string]string{"Authorization": "Basic " + base64.StdEncoding.EncodeToString([]byte("other:"+key.Token))}
	requireStatus(t, request(a, "PUT", "/dav/bookmarks.xbel.lock", "lock", false, otherH), 423)
	requireStatus(t, request(a, "DELETE", "/dav/bookmarks.xbel.lock", "", false, otherH), 423)
	body := "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<xbel version=\"1.0\">\n<!--- highestId :3: for Floccus bookmark sync browser extension -->\n<bookmark id=\"3\" href=\"https://three.example\"><title>Trois été</title></bookmark>\n<folder id=\"2\"><title>Folder</title><bookmark id=\"1\" href=\"https://new.example\"><title>New</title></bookmark></folder>\n</xbel>"
	requireStatus(t, request(a, "PUT", "/dav/bookmarks.xbel.temp", body, false, h), 204)
	w = request(a, "PROPFIND", "/dav/bookmarks.xbel.temp", "", false, h)
	requireStatus(t, w, 207)
	if !strings.Contains(w.Body.String(), fmt.Sprintf("<d:getcontentlength>%d</d:getcontentlength>", len(body))) {
		t.Fatal("temp size mismatch")
	}
	h["Destination"] = "http://attacker.test/dav/bookmarks.xbel"
	requireStatus(t, request(a, "MOVE", "/dav/bookmarks.xbel.temp", "", false, h), 400)
	h["Destination"] = "http://pocketmark.test/dav/bookmarks.xbel"
	h["Overwrite"] = "T"
	requireStatus(t, request(a, "MOVE", "/dav/bookmarks.xbel.temp", "", false, h), 204)
	w = request(a, "GET", "/dav/bookmarks.xbel", "", false, h)
	requireStatus(t, w, 200)
	if w.Body.String() != body {
		t.Fatal("server reformatted Floccus upload")
	}
	w = request(a, "PROPFIND", "/dav/bookmarks.xbel", "", false, h)
	requireStatus(t, w, 207)
	if !strings.Contains(w.Body.String(), fmt.Sprintf("<d:getcontentlength>%d</d:getcontentlength>", len(body))) {
		t.Fatal("final size mismatch")
	}
	l, e := a.Store.Get(ctx, id)
	if e != nil || l.URL != "https://new.example" || l.Description != "keep description" || l.Notes != "private" || !l.Favorite {
		t.Fatalf("metadata lost %+v %v", l, e)
	}
	requireStatus(t, request(a, "DELETE", "/dav/bookmarks.xbel.lock", "", false, h), 204)
	l.Title = "Native edit"
	if e = a.Store.Update(ctx, id, l); e != nil {
		t.Fatal(e)
	}
	w = request(a, "GET", "/dav/bookmarks.xbel", "", false, h)
	requireStatus(t, w, 200)
	if w.Body.String() == body || !strings.Contains(w.Body.String(), "Native edit") {
		t.Fatal("raw snapshot was not invalidated")
	}
	if strings.Index(w.Body.String(), `id="3"`) > strings.Index(w.Body.String(), `id="2"`) {
		t.Fatal("native edit lost sibling ordering")
	}
	requireStatus(t, request(a, "PUT", "/dav/bookmarks.xbel.lock", "lock", false, h), 201)
	requireStatus(t, request(a, "GET", "/dav/bookmarks.xbel", "", false, h), 200)
	requireStatus(t, request(a, "PUT", "/dav/bookmarks.xbel.temp", w.Body.String(), false, h), 204)
	l.Title = "Concurrent native edit"
	if e = a.Store.Update(ctx, id, l); e != nil {
		t.Fatal(e)
	}
	requireStatus(t, request(a, "MOVE", "/dav/bookmarks.xbel.temp", "", false, h), 412)
	l, e = a.Store.Get(ctx, id)
	if e != nil || l.Title != "Concurrent native edit" {
		t.Fatal("concurrent native edit overwritten")
	}
	requireStatus(t, request(a, "DELETE", "/dav/bookmarks.xbel.lock", "", false, h), 204)
}
