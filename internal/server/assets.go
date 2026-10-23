package server

import (
	"archive/zip"
	"bytes"
	"errors"
	"io"
	"mime"
	"net/http"
	"os"
	"strconv"

	"pocketmark/internal/capture"
	"pocketmark/internal/observability"
	"pocketmark/internal/store"
)

func (a *Server) registerAssets(mux *http.ServeMux) {
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
	upload, ok := a.stageUpload(w, r, "attachment")
	if !ok {
		return
	}
	defer upload.cleanup()
	name := r.URL.Query().Get("name")
	if name == "" {
		switch upload.kind {
		case "pdf":
			name = "document.pdf"
		case "html":
			name = "page.html"
		default:
			name = "image"
		}
	}
	asset, e := a.Store.SaveAsset(r.Context(), store.Asset{LinkID: id(r), Name: name, MediaType: upload.mediaType, Kind: upload.kind}, upload.file)
	if e != nil {
		fail(w, 400, e.Error())
		return
	}
	if upload.kind == "html" {
		upload.file.Seek(0, io.SeekStart)
		parsed, parseErr := capture.ExtractDocument(upload.file)
		if parseErr == nil {
			parseErr = a.Store.IndexDocument(r.Context(), id(r), link.URL, parsed.Title, parsed.Description, parsed.Content)
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
		observability.Error(r.Context(), "attachment_download_failed", e)
	}
}
func (a *Server) deleteAsset(w http.ResponseWriter, r *http.Request) {
	if e := a.Store.DeleteAsset(r.Context(), assetID(r)); e != nil {
		handleError(w, e)
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}

func (a *Server) preserveOffline(w http.ResponseWriter, r *http.Request) {
	link, e := a.Store.Get(r.Context(), id(r))
	if e != nil {
		handleError(w, e)
		return
	}
	f, e := a.Store.TemporaryFile(".offline-*.html")
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
	var assetID *int64
	if raw := r.URL.Query().Get("asset"); raw != "" {
		value, _ := strconv.ParseInt(raw, 10, 64)
		assetID = &value
	}
	body, e := a.Store.ReaderDocument(r.Context(), link.ID, assetID)
	if e != nil {
		switch {
		case errors.Is(e, store.ErrHTMLAssetNotFound), errors.Is(e, store.ErrNoReaderDocument):
			fail(w, 404, e.Error())
		case errors.Is(e, store.ErrReaderTooLarge):
			fail(w, 413, e.Error())
		default:
			handleError(w, e)
		}
		return
	}
	var output bytes.Buffer
	if e = capture.Reader(bytes.NewReader(body), &output, link.URL); e != nil {
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
	f, e := a.Store.Snapshot(r.Context())
	if e != nil {
		handleError(w, e)
		return
	}
	defer os.Remove(f.Name())
	defer f.Close()
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="pocketmark-backup.zip"`)
	z := zip.NewWriter(w)
	entry, e := z.CreateHeader(&zip.FileHeader{Name: "pocketmark.db", Method: zip.Store})
	if e != nil {
		observability.Error(r.Context(), "backup_zip_failed", e)
		return
	}
	if _, e = io.Copy(entry, f); e != nil {
		observability.Error(r.Context(), "backup_stream_failed", e)
		return
	}
	entry, e = z.CreateHeader(&zip.FileHeader{Name: "RESTORE.txt", Method: zip.Store})
	if e == nil {
		_, e = io.WriteString(entry, "Stop Pocketmark. Extract pocketmark.db into an EMPTY data directory (never leave old -wal/-shm files). Set file permissions to 0600 and owner to the service user. Reuse the existing access-token file or POCKETMARK_TOKEN environment value to retain login sessions and token signing. Start Pocketmark. The database includes bookmarks, collections, annotations, all captured HTML and uploaded attachments. Keep this sensitive backup private.\n")
	}
	if e != nil {
		observability.Error(r.Context(), "backup_instructions_failed", e)
		return
	}
	if e = z.Close(); e != nil {
		observability.Error(r.Context(), "backup_finish_failed", e)
	}
}
