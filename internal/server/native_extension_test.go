package server

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"testing"

	"pocketmark/internal/store"
)

func TestRemovedCompatibilityDoesNotAffectNativeLibraryOrDAV(t *testing.T) {
	a := newTestServer(t, "", false)
	id, err := a.Store.Create(context.Background(), store.Link{URL: "https://example.com/kept", Title: "Kept", Tags: []string{"legacy"}, Notes: "Personal note", Favorite: true})
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/v1/config", "/api/v1/logins", "/api/v1/session", "/api/v1/links", "/api/v1/collections", "/api/v2/dashboard"} {
		requireStatus(t, request(a, "GET", path, "", true, nil), 404)
	}
	requireStatus(t, request(a, "POST", "/api/v1/session", `{}`, true, nil), 405)
	requireStatus(t, request(a, "GET", "/api/v1/config", "", false, nil), 401)
	requireStatus(t, request(a, "POST", "/api/links", `{"url":"https://example.com/kept"}`, true, nil), 400)
	w := request(a, "GET", "/api/links?url=https%3A%2F%2Fexample.com%2Fkept", "", true, map[string]string{"Origin": "chrome-extension://pocketmark"})
	requireStatus(t, w, 200)
	if w.Header().Get("Access-Control-Allow-Origin") != "chrome-extension://pocketmark" {
		t.Fatal("native extension CORS missing")
	}
	var page store.Page
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil || len(page.Links) != 1 || page.Links[0].ID != id || page.Links[0].Notes != "Personal note" || !page.Links[0].Favorite {
		t.Fatal(w.Body.String(), err)
	}
	requireStatus(t, request(a, "GET", fmt.Sprintf("/api/links/%d", id), "", true, nil), 200)
	requireStatus(t, request(a, "GET", "/dav/bookmarks.xbel", "", true, nil), 200)
	requireStatus(t, request(a, "POST", "/api/login", `{}`, false, map[string]string{"Origin": "chrome-extension://pocketmark"}), 403)
}

func TestNativeLibraryRetainsLegacyDataAcrossRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.db")
	s, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	// Retain the legacy tables and their triggers; removing an HTTP adapter must
	// not require rewriting or discarding the owner's existing library.
	a := New(s, testToken, "", false)
	cid, err := s.AddCollection(context.Background(), store.Collection{Name: "Legacy folder"})
	if err != nil {
		t.Fatal(err)
	}
	lid, err := s.Create(context.Background(), store.Link{URL: "https://example.com/legacy", Title: "Legacy title", CollectionID: &cid, Tags: []string{"legacy-tag"}, Notes: "Keep notes", Favorite: true, Read: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.DB.Exec("UPDATE links SET archive=?,content='Legacy captured text',status='ready' WHERE id=?", []byte("legacy archive"), lid); err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	a = New(s, testToken, "", false)
	l, err := s.Get(context.Background(), lid)
	if err != nil || l.Title != "Legacy title" || l.Notes != "Keep notes" || !l.Favorite || !l.Read || l.CollectionID == nil || *l.CollectionID != cid || len(l.Tags) != 1 || l.Tags[0] != "legacy-tag" || !l.ArchiveAvailable {
		t.Fatalf("legacy data changed: %+v (%v)", l, err)
	}
	w := request(a, "GET", fmt.Sprintf("/api/links/%d/archive", lid), "", true, nil)
	requireStatus(t, w, 200)
	if w.Body.String() != "legacy archive" {
		t.Fatal("legacy archive changed")
	}
	requireStatus(t, request(a, "GET", "/dav/bookmarks.xbel", "", true, nil), 200)
	requireStatus(t, request(a, "GET", "/api/v1/links", "", true, nil), 404)
}
