package server

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"pocketmark/internal/store"
)

func TestAssetPreviewsPreserveLayoutAndRequireAuthentication(t *testing.T) {
	a := newTestServer(t, "", false)
	linkID, err := a.Store.Create(context.Background(), store.Link{URL: "https://example.com/preview"})
	if err != nil {
		t.Fatal(err)
	}
	png, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6XcAAAAASUVORK5CYII=")
	for _, file := range []struct{ name, media, body string }{
		{"page.html", "text/html", `<!doctype html><style>body{color:rgb(1,2,3)}</style><h1>Saved &amp; styled</h1><img src="data:image/png;base64,abc"><meta http-equiv="REFRESH" content="0;url=https://attacker.test"><base href="https://attacker.test"><a href="https://attacker.test" ping="https://attacker.test" target="_top">Leave</a><a href="#saved">Jump</a><script>parent.compromised=true</script>`},
		{"long.html", "text/html", "<!doctype html><p>Large saved capture</p>" + strings.Repeat("<!-- preserved -->", 140000)},
		{"image.png", "image/png", string(png)},
		{"file.pdf", "application/pdf", "%PDF-1.4\nsynthetic fixture\n%%EOF"},
	} {
		t.Run(file.name, func(t *testing.T) {
			w := request(a, "POST", "/api/links/"+strconv.FormatInt(linkID, 10)+"/assets?name="+file.name, file.body, true, map[string]string{"Content-Type": file.media})
			requireStatus(t, w, 201)
			var asset store.Asset
			if err := json.Unmarshal(w.Body.Bytes(), &asset); err != nil {
				t.Fatal(err)
			}
			path := "/api/assets/" + strconv.FormatInt(asset.ID, 10)
			requireStatus(t, request(a, "GET", path+"/view", "", false, nil), 401)
			requireStatus(t, request(a, "HEAD", path+"/view", "", false, nil), 401)
			w = request(a, "GET", path+"/view", "", true, nil)
			requireStatus(t, w, 200)
			if w.Header().Get("Content-Type") != file.media || !strings.HasPrefix(w.Header().Get("Content-Disposition"), "inline;") || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Content-Type-Options") != "nosniff" || w.Header().Get("X-Frame-Options") != "SAMEORIGIN" {
				t.Fatalf("incorrect preview headers: %v", w.Header())
			}
			policy := w.Header().Get("Content-Security-Policy")
			if !strings.Contains(policy, "default-src 'none'") || !strings.Contains(policy, "frame-ancestors 'self'") {
				t.Fatalf("unsafe preview policy: %s", policy)
			}
			if file.media == "text/html" {
				if !strings.Contains(policy, "; sandbox;") || strings.Contains(policy, "allow-scripts") || strings.Contains(policy, "allow-same-origin") {
					t.Fatalf("HTML must have an opaque, scriptless sandbox: %s", policy)
				}
				if file.name == "page.html" {
					body := w.Body.String()
					for _, want := range []string{"<style>body{color:rgb(1,2,3)}</style>", "Saved &amp; styled", `src="data:image/png;base64,abc"`, `href="#saved"`} {
						if !strings.Contains(body, want) {
							t.Errorf("lost saved appearance: %q", want)
						}
					}
					if strings.Contains(body, "attacker.test") || strings.Contains(body, "<base") {
						t.Fatal("preview allows navigation out of the saved page")
					}
				}
			} else if w.Body.String() != file.body {
				t.Fatal("preview changed original PDF/image bytes")
			}
			head := request(a, "HEAD", path+"/view", "", true, nil)
			requireStatus(t, head, 200)
			if head.Body.Len() != 0 || head.Header().Get("Content-Security-Policy") != policy {
				t.Fatal("HEAD must expose preview policy without rendering a body")
			}
			download := request(a, "GET", path, "", true, nil)
			if download.Body.String() != file.body || !strings.HasPrefix(download.Header().Get("Content-Disposition"), "attachment;") {
				t.Fatal("preview changed the saved download")
			}
			requireStatus(t, request(a, "DELETE", path, "", true, nil), 200)
			requireStatus(t, request(a, "GET", path+"/view", "", true, nil), 404)
		})
	}
}

func TestHTMLPreviewShellIsTheOnlyPageAllowedToFrameBlobs(t *testing.T) {
	a := newTestServer(t, "", false)
	w := request(a, "GET", "/asset-preview.html", "", false, nil)
	requireStatus(t, w, 200)
	policy := w.Header().Get("Content-Security-Policy")
	if !strings.Contains(policy, "frame-src blob:") || !strings.Contains(policy, "frame-ancestors 'self'") || !strings.Contains(policy, "default-src 'none'") || w.Header().Get("X-Frame-Options") != "SAMEORIGIN" {
		t.Fatalf("unsafe preview shell policy: %s", policy)
	}
	for _, path := range []string{"/", "/reader.js"} {
		w = request(a, "GET", path, "", false, nil)
		policy = w.Header().Get("Content-Security-Policy")
		if strings.Contains(policy, "blob:") || strings.Contains(policy, "unsafe-inline") || w.Header().Get("X-Frame-Options") != "DENY" {
			t.Fatalf("library policy weakened at %s: %s", path, policy)
		}
	}
}

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
