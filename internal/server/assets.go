package server

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"pocketmark/internal/capture"
	"pocketmark/internal/store"
)

func (a *Server) registerAssets(mux *http.ServeMux) {
	if err := a.Store.InitAssets(context.Background()); err != nil {
		panic(fmt.Sprintf("initialize attachments: %v", err))
	}
	// One expensive archive/upload/backup at a time. Downloads stream one 64 KiB
	// SQLite chunk at a time and share the existing server request limit.
	gate := make(chan struct{}, 1)
	limited := func(fn http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			select {
			case gate <- struct{}{}:
				defer func() { <-gate }()
				fn(w, r)
			default:
				fail(w, 409, "another archive, upload or backup is in progress")
			}
		}
	}
	mux.HandleFunc("GET /api/links/{id}/assets", a.listAssets)
	mux.HandleFunc("POST /api/links/{id}/assets", limited(a.uploadAsset))
	mux.HandleFunc("GET /api/assets/{assetId}", a.downloadAsset)
	mux.HandleFunc("DELETE /api/assets/{assetId}", a.deleteAsset)
	mux.HandleFunc("POST /api/links/{id}/preserve", limited(a.preserveOffline))
	mux.HandleFunc("GET /api/links/{id}/reader", limited(a.richReader))
	mux.HandleFunc("GET /api/backup", limited(a.backup))
}
func assetID(r *http.Request) int64 {
	n, _ := strconv.ParseInt(r.PathValue("assetId"), 10, 64)
	return n
}
func (a *Server) listAssets(w http.ResponseWriter, r *http.Request) {
	out, e := a.Store.Assets(r.Context(), id(r))
	if e != nil {
		handleError(w, e)
		return
	}
	respond(w, 200, out)
}
func (a *Server) uploadAsset(w http.ResponseWriter, r *http.Request) {
	link, e := a.Store.Get(r.Context(), id(r))
	if e != nil {
		handleError(w, e)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, store.MaxAssetSize)
	reader := bufio.NewReaderSize(r.Body, 512)
	prefix, e := reader.Peek(512)
	if e != nil && e != io.EOF {
		fail(w, 400, "cannot read attachment")
		return
	}
	media := http.DetectContentType(prefix)
	if bytes.HasPrefix(prefix, []byte("%PDF-")) {
		media = "application/pdf"
	}
	declared, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	// Some SingleFile files start with long comments; the caller may identify
	// these as HTML. They remain untrusted downloadable bytes, never inline.
	if declared == "text/html" && (media == "text/plain; charset=utf-8" || strings.HasPrefix(media, "text/html")) {
		media = "text/html"
	}
	if strings.HasPrefix(media, "text/html") {
		media = "text/html"
	}
	kind := "upload"
	switch media {
	case "application/pdf":
		kind = "pdf"
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		kind = "image"
	case "text/html":
		kind = "html"
	default:
		fail(w, 415, "upload a PDF, PNG, JPEG, GIF, WebP or HTML/SingleFile document")
		return
	}
	name := r.URL.Query().Get("name")
	if name == "" {
		switch kind {
		case "pdf":
			name = "document.pdf"
		case "html":
			name = "page.html"
		default:
			name = "image"
		}
	}
	f, e := a.temporaryDataFile(r.Context(), ".upload-*")
	if e != nil {
		handleError(w, e)
		return
	}
	defer os.Remove(f.Name())
	defer f.Close()
	if _, e = io.Copy(f, reader); e != nil {
		fail(w, 400, "attachment exceeds 20 MiB or upload was interrupted")
		return
	}
	if _, e = f.Seek(0, io.SeekStart); e != nil {
		handleError(w, e)
		return
	}
	asset, e := a.Store.SaveAsset(r.Context(), store.Asset{LinkID: id(r), Name: name, MediaType: media, Kind: kind}, f)
	if e != nil {
		fail(w, 400, e.Error())
		return
	}
	if kind == "html" {
		f.Seek(0, io.SeekStart)
		parsed, parseErr := capture.ExtractDocument(f)
		if parseErr == nil {
			_, parseErr = a.Store.DB.ExecContext(r.Context(), `UPDATE links SET content=?,title=CASE WHEN title=url AND ?<>'' THEN ? ELSE title END, description=CASE WHEN description='' THEN ? ELSE description END,status='ready',error='',updated_at=? WHERE id=? AND url=?`, parsed.Content, parsed.Title, parsed.Title, parsed.Description, time.Now().UTC().Format(time.RFC3339Nano), id(r), link.URL)
		}
		if parseErr != nil {
			w.Header().Set("X-Pocketmark-Warning", "Archive saved, but reader indexing failed; oversized HTML tokens may exceed the 2 MiB limit")
		}
	}
	respond(w, 201, asset)
}
func (a *Server) downloadAsset(w http.ResponseWriter, r *http.Request) {
	asset, e := a.Store.Asset(r.Context(), assetID(r))
	if e != nil {
		handleError(w, e)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": asset.Name}))
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	w.Header().Set("Content-Length", strconv.FormatInt(asset.Size, 10))
	if e = a.Store.WriteAsset(r.Context(), asset.ID, w); e != nil {
		log.Printf("download attachment: %v", e)
	}
}
func (a *Server) deleteAsset(w http.ResponseWriter, r *http.Request) {
	if e := a.Store.DeleteAsset(r.Context(), assetID(r)); e != nil {
		handleError(w, e)
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}

func (a *Server) temporaryDataFile(ctx context.Context, pattern string) (*os.File, error) {
	var seq int
	var name, path string
	e := a.Store.DB.QueryRowContext(ctx, "PRAGMA database_list").Scan(&seq, &name, &path)
	if e != nil {
		return nil, e
	}
	if path == "" {
		return nil, errors.New("file-backed database required")
	}
	return os.CreateTemp(filepath.Dir(path), pattern)
}
func (a *Server) preserveOffline(w http.ResponseWriter, r *http.Request) {
	link, e := a.Store.Get(r.Context(), id(r))
	if e != nil {
		handleError(w, e)
		return
	}
	f, e := a.temporaryDataFile(r.Context(), ".offline-*.html")
	if e != nil {
		handleError(w, e)
		return
	}
	defer os.Remove(f.Name())
	defer f.Close()
	report, e := capture.Offline(r.Context(), link.URL, f)
	if e != nil {
		fail(w, 400, e.Error())
		return
	}
	if _, e = f.Seek(0, io.SeekStart); e != nil {
		handleError(w, e)
		return
	}
	asset, e := a.Store.SaveAsset(r.Context(), store.Asset{LinkID: link.ID, Name: "offline-page.html", MediaType: "text/html", Kind: "offline"}, f)
	if e != nil {
		handleError(w, e)
		return
	}
	respond(w, 201, map[string]any{"asset": asset, "embedded": report.Embedded, "omitted": report.Omitted})
}
func (a *Server) richReader(w http.ResponseWriter, r *http.Request) {
	link, e := a.Store.Get(r.Context(), id(r))
	if e != nil {
		handleError(w, e)
		return
	}
	var src io.Reader
	raw := r.URL.Query().Get("asset")
	if raw == "" {
		var latest int64
		if a.Store.DB.QueryRowContext(r.Context(), `SELECT id FROM assets WHERE link_id=? AND media_type='text/html' AND kind='html' ORDER BY id DESC LIMIT 1`, link.ID).Scan(&latest) == nil {
			raw = strconv.FormatInt(latest, 10)
		}
	}
	if raw != "" {
		assetID, _ := strconv.ParseInt(raw, 10, 64)
		asset, e := a.Store.Asset(r.Context(), assetID)
		if e != nil || asset.LinkID != link.ID || asset.MediaType != "text/html" {
			fail(w, 404, "HTML attachment not found")
			return
		}
		if asset.Size > 2<<20 {
			fail(w, 413, "rich reader accepts HTML up to 2 MiB; download the larger archive")
			return
		}
		var body bytes.Buffer
		if e = a.Store.WriteAsset(r.Context(), asset.ID, &body); e != nil {
			handleError(w, e)
			return
		}
		src = &body
	} else {
		var body []byte
		e = a.Store.DB.QueryRowContext(r.Context(), "SELECT archive FROM links WHERE id=?", link.ID).Scan(&body)
		if e != nil {
			handleError(w, e)
			return
		}
		if len(body) == 0 {
			fail(w, 404, "capture or upload an HTML page first")
			return
		}
		src = bytes.NewReader(body)
	}
	var output bytes.Buffer
	if e = capture.Reader(src, &output, link.URL); e != nil {
		fail(w, 400, e.Error())
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", "sandbox allow-popups; default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'")
	w.Header().Set("X-Frame-Options", "SAMEORIGIN")
	w.Write(output.Bytes())
}

// VACUUM INTO creates a transactionally consistent snapshot including WAL
// changes. ZIP Store avoids a large compressor and keeps the backup streamable.
func (a *Server) backup(w http.ResponseWriter, r *http.Request) {
	if !a.requireOwner(w, r) {
		return
	}
	f, e := a.temporaryDataFile(r.Context(), ".backup-*.db")
	if e != nil {
		handleError(w, e)
		return
	}
	path := f.Name()
	f.Close()
	os.Remove(path)
	defer os.Remove(path)
	if _, e = a.Store.DB.ExecContext(r.Context(), "VACUUM INTO ?", path); e != nil {
		handleError(w, e)
		return
	}
	if e = os.Chmod(path, 0600); e != nil {
		handleError(w, e)
		return
	}
	f, e = os.Open(path)
	if e != nil {
		handleError(w, e)
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="pocketmark-backup.zip"`)
	z := zip.NewWriter(w)
	entry, e := z.CreateHeader(&zip.FileHeader{Name: "pocketmark.db", Method: zip.Store})
	if e != nil {
		log.Printf("backup ZIP: %v", e)
		return
	}
	if _, e = io.Copy(entry, f); e != nil {
		log.Printf("backup stream: %v", e)
		return
	}
	entry, e = z.CreateHeader(&zip.FileHeader{Name: "RESTORE.txt", Method: zip.Store})
	if e == nil {
		_, e = io.WriteString(entry, "Stop Pocketmark. Extract pocketmark.db into an EMPTY data directory (never leave old -wal/-shm files). Set file permissions to 0600 and owner to the service user. Reuse the existing access-token file or POCKETMARK_TOKEN environment value to retain login sessions and token signing. Start Pocketmark. The database includes bookmarks, collections, annotations, all captured HTML and uploaded attachments. Keep this sensitive backup private.\n")
	}
	if e != nil {
		log.Printf("backup instructions: %v", e)
		return
	}
	if e = z.Close(); e != nil {
		log.Printf("finish backup: %v", e)
	}
}
