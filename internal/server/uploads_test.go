package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pocketmark/internal/store"
)

func documentUploadPath(t *testing.T, a *Server, standalone bool) string {
	t.Helper()
	if standalone {
		return "/api/files?name=document"
	}
	id, err := a.Store.Create(context.Background(), store.Link{URL: "https://example.com/upload"})
	if err != nil {
		t.Fatal(err)
	}
	return fmt.Sprintf("/api/links/%d/assets?name=document", id)
}

func postDocument(a *Server, path, media string, body io.Reader) *httptest.ResponseRecorder {
	r := httptest.NewRequest("POST", "http://pocketmark.test"+path, body)
	r.Header.Set("Authorization", "Bearer "+testToken)
	r.Header.Set("Content-Type", media)
	w := httptest.NewRecorder()
	a.ServeHTTP(w, r)
	return w
}

func uploadedAsset(t *testing.T, w *httptest.ResponseRecorder, standalone bool) store.Asset {
	t.Helper()
	var asset store.Asset
	var err error
	if standalone {
		var saved struct{ Asset store.Asset }
		err = json.Unmarshal(w.Body.Bytes(), &saved)
		asset = saved.Asset
	} else {
		err = json.Unmarshal(w.Body.Bytes(), &asset)
	}
	if err != nil {
		t.Fatal(err)
	}
	return asset
}

func requireNoStagedUploads(t *testing.T, a *Server) {
	t.Helper()
	f, err := a.Store.TemporaryFile(".inspect-*")
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Dir(f.Name())
	f.Close()
	os.Remove(f.Name())
	paths, err := filepath.Glob(filepath.Join(dir, ".*upload-*"))
	if err != nil || len(paths) != 0 {
		t.Fatalf("staged uploads remain: %v (%v)", paths, err)
	}
}

func TestDocumentUploadFormatsAndOriginalBytes(t *testing.T) {
	for _, standalone := range []bool{false, true} {
		for _, tc := range []struct{ name, body, declared, media, kind string }{
			{"pdf", "%PDF-1.7\nbody", "application/octet-stream", "application/pdf", "pdf"},
			{"png", "\x89PNG\r\n\x1a\nbody", "text/html", "image/png", "image"},
			{"jpeg", "\xff\xd8\xffbody", "application/octet-stream", "image/jpeg", "image"},
			{"gif", "GIF89abody", "application/octet-stream", "image/gif", "image"},
			{"webp", "RIFF\x00\x00\x00\x00WEBPVP8 body", "application/octet-stream", "image/webp", "image"},
			{"html", "<!doctype html><html><body>Saved text</body></html>", "application/octet-stream", "text/html", "html"},
			{"singlefile", "<!--" + strings.Repeat("x", 600) + "--><html><body>Saved text</body></html>", "text/html; charset=utf-8", "text/html", "html"},
		} {
			t.Run(fmt.Sprintf("standalone=%t/%s", standalone, tc.name), func(t *testing.T) {
				a := newTestServer(t, "", false)
				path := documentUploadPath(t, a, standalone)
				w := postDocument(a, path, tc.declared, strings.NewReader(tc.body))
				requireStatus(t, w, 201)
				asset := uploadedAsset(t, w, standalone)
				if asset.MediaType != tc.media || asset.Kind != tc.kind || asset.Size != int64(len(tc.body)) {
					t.Fatalf("unexpected asset: %+v", asset)
				}
				w = request(a, "GET", fmt.Sprintf("/api/assets/%d", asset.ID), "", true, nil)
				requireStatus(t, w, 200)
				if w.Body.String() != tc.body || !strings.HasPrefix(w.Header().Get("Content-Disposition"), "attachment") {
					t.Fatal("original bytes or download protection changed")
				}
				requireNoStagedUploads(t, a)
			})
		}
	}
}

type uploadPadding struct{}

func (uploadPadding) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = 'x'
	}
	return len(p), nil
}

type failedUpload struct{}

func (failedUpload) Read([]byte) (int, error) { return 0, errors.New("upload interrupted") }

func sizedPDF(size int64) io.Reader {
	const prefix = "%PDF-1.7\n"
	return io.MultiReader(strings.NewReader(prefix), io.LimitReader(uploadPadding{}, size-int64(len(prefix))))
}

func TestDocumentUploadLimitsRollbackAndCleanup(t *testing.T) {
	for _, standalone := range []bool{false, true} {
		for _, tc := range []struct {
			name, media string
			body        func() io.Reader
			status      int
		}{
			{"empty", "text/html", func() io.Reader { return strings.NewReader("") }, 400},
			{"unsupported", "application/octet-stream", func() io.Reader { return strings.NewReader("MZ executable") }, 415},
			{"forged-html", "text/html", func() io.Reader { return strings.NewReader("MZ\x00executable") }, 415},
			{"interrupted", "application/pdf", func() io.Reader {
				return io.MultiReader(sizedPDF(1024), failedUpload{})
			}, 400},
			{"too-large", "application/pdf", func() io.Reader { return sizedPDF(store.MaxAssetSize + 1) }, 400},
			{"exact-limit", "application/pdf", func() io.Reader { return sizedPDF(store.MaxAssetSize) }, 201},
		} {
			t.Run(fmt.Sprintf("standalone=%t/%s", standalone, tc.name), func(t *testing.T) {
				a := newTestServer(t, "", false)
				path := documentUploadPath(t, a, standalone)
				w := postDocument(a, path, tc.media, tc.body())
				requireStatus(t, w, tc.status)
				wantAssets, wantLinks := 0, 1
				if standalone {
					wantLinks = 0
				}
				if tc.status == 201 {
					wantAssets, wantLinks = 1, 1
					if asset := uploadedAsset(t, w, standalone); asset.Size != store.MaxAssetSize {
						t.Fatalf("wrong size at exact limit: %+v", asset)
					}
				}
				stats, err := a.Store.Stats(context.Background())
				if err != nil || stats.Links != wantLinks {
					t.Fatalf("bookmark count: %+v (%v)", stats, err)
				}
				page, err := a.Store.List(context.Background(), store.Filter{})
				if err != nil {
					t.Fatal(err)
				}
				count := 0
				for _, link := range page.Links {
					assets, err := a.Store.Assets(context.Background(), link.ID)
					if err != nil {
						t.Fatal(err)
					}
					count += len(assets)
				}
				if count != wantAssets {
					t.Fatalf("asset count: got %d, want %d", count, wantAssets)
				}
				requireNoStagedUploads(t, a)
			})
		}
	}
}

func TestDocumentUploadIndexingFailureKeepsOriginal(t *testing.T) {
	body := "<!--" + strings.Repeat("x", (2<<20)+1) + "--><p>Text</p>"
	for _, standalone := range []bool{false, true} {
		t.Run(fmt.Sprint(standalone), func(t *testing.T) {
			a := newTestServer(t, "", false)
			path := documentUploadPath(t, a, standalone)
			w := postDocument(a, path, "text/html", strings.NewReader(body))
			requireStatus(t, w, 201)
			if w.Header().Get("X-Pocketmark-Warning") == "" {
				t.Fatal("missing indexing warning")
			}
			asset := uploadedAsset(t, w, standalone)
			w = request(a, "GET", fmt.Sprintf("/api/assets/%d", asset.ID), "", true, nil)
			requireStatus(t, w, 200)
			if w.Body.String() != body {
				t.Fatal("indexing failure changed original bytes")
			}
			requireNoStagedUploads(t, a)
		})
	}
}

type pausedUpload struct{ started, resume chan struct{} }

func (p pausedUpload) Read([]byte) (int, error) {
	close(p.started)
	<-p.resume
	return 0, io.EOF
}

func TestDocumentUploadsKeepDatabaseAvailableAndSlotsSeparate(t *testing.T) {
	for _, standalone := range []bool{false, true} {
		t.Run(fmt.Sprint(standalone), func(t *testing.T) {
			a := newTestServer(t, "", false)
			path := documentUploadPath(t, a, standalone)
			otherPath := documentUploadPath(t, a, !standalone)
			paused := pausedUpload{make(chan struct{}), make(chan struct{})}
			done := make(chan *httptest.ResponseRecorder, 1)
			// Always release the request before newTestServer closes its database.
			t.Cleanup(func() {
				close(paused.resume)
				select {
				case w := <-done:
					requireStatus(t, w, 201)
				case <-time.After(5 * time.Second):
					t.Error("upload did not finish")
				}
				requireNoStagedUploads(t, a)
			})
			go func() {
				done <- postDocument(a, path, "application/pdf", io.MultiReader(sizedPDF(1024), paused))
			}()
			select {
			case <-paused.started:
			case <-time.After(5 * time.Second):
				t.Fatal("upload did not start")
			}
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			if err := a.Store.Ping(ctx); err != nil {
				t.Fatalf("slow upload retained sole SQLite connection: %v", err)
			}
			requireStatus(t, postDocument(a, path, "application/pdf", sizedPDF(32)), 409)
			requireStatus(t, postDocument(a, otherPath, "application/pdf", sizedPDF(32)), 201)
		})
	}
}
