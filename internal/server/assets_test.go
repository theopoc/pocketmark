package server

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"pocketmark/internal/store"
)

func TestAssetsUploadReaderDownloadBackupAndDelete(t *testing.T) {
	a := newTestServer(t, "", false)
	linkID, err := a.Store.Create(context.Background(), store.Link{URL: "https://example.com/rendered"})
	if err != nil {
		t.Fatal(err)
	}
	path := "/api/links/" + strconv.FormatInt(linkID, 10)
	html := `<!doctype html><html><head><title>Rendered app</title></head><body><h1>Dynamic headings</h1><p>Searchable rendered content</p><script>evil()</script></body></html>`
	w := request(a, "POST", path+"/assets?name=rendered.html", html, true, map[string]string{"Content-Type": "text/html"})
	requireStatus(t, w, 201)
	var asset store.Asset
	if err = json.Unmarshal(w.Body.Bytes(), &asset); err != nil {
		t.Fatal(err)
	}
	link, err := a.Store.Get(context.Background(), linkID)
	if err != nil || !strings.Contains(link.Content, "Searchable rendered content") || link.Title != "Rendered app" || link.Status != "ready" {
		t.Fatalf("not indexed %+v %v", link, err)
	}
	w = request(a, "GET", path+"/reader", "", true, nil)
	requireStatus(t, w, 200)
	if !strings.Contains(w.Body.String(), "<h1>Dynamic headings</h1>") || strings.Contains(w.Body.String(), "evil()") {
		t.Fatal("unsafe or missing rich content")
	}
	if !strings.Contains(w.Header().Get("Content-Security-Policy"), "sandbox") {
		t.Fatal("reader not sandboxed")
	}
	assetPath := "/api/assets/" + strconv.FormatInt(asset.ID, 10)
	w = request(a, "GET", assetPath, "", true, nil)
	requireStatus(t, w, 200)
	if w.Body.String() != html || !strings.HasPrefix(w.Header().Get("Content-Disposition"), "attachment") {
		t.Fatal("download changed or was inline")
	}
	requireStatus(t, request(a, "GET", assetPath, "", false, nil), 401)
	requireStatus(t, request(a, "POST", path+"/assets?name=bad.exe", "MZ bad executable", true, map[string]string{"Content-Type": "application/octet-stream"}), 415)
	w = request(a, "GET", "/api/backup", "", true, nil)
	requireStatus(t, w, 200)
	z, err := zip.NewReader(bytes.NewReader(w.Body.Bytes()), int64(w.Body.Len()))
	if err != nil {
		t.Fatal(err)
	}
	var dbBody []byte
	for _, entry := range z.File {
		if entry.Name == "pocketmark.db" {
			f, e := entry.Open()
			if e != nil {
				t.Fatal(e)
			}
			dbBody, e = io.ReadAll(f)
			f.Close()
			if e != nil {
				t.Fatal(e)
			}
		}
	}
	if len(dbBody) == 0 {
		t.Fatal("backup database missing")
	}
	copyPath := filepath.Join(t.TempDir(), "restore.db")
	if err = os.WriteFile(copyPath, dbBody, 0600); err != nil {
		t.Fatal(err)
	}
	restored, err := store.Open(copyPath)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	var body bytes.Buffer
	if err = restored.WriteAsset(context.Background(), asset.ID, &body); err != nil || body.String() != html {
		t.Fatalf("backup lost attachment %v", err)
	}
	requireStatus(t, request(a, "DELETE", assetPath, "", true, nil), 200)
	requireStatus(t, request(a, "GET", assetPath, "", true, nil), 404)
}
