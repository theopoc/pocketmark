package server

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"io"
	"mime"
	"net/http"
	"os"
	"strconv"
	"time"

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
	mux.HandleFunc("GET /api/links/{id}/thumbnail", a.thumbnail)
	mux.HandleFunc("GET /api/links/{id}/assets", a.listAssets)
	mux.HandleFunc("POST /api/links/{id}/assets", limited(a.uploadAsset))
	mux.HandleFunc("GET /api/assets/{assetId}", a.downloadAsset)
	mux.HandleFunc("GET /api/assets/{assetId}/view", limited(a.viewAsset))
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

func (a *Server) viewAsset(w http.ResponseWriter, r *http.Request) {
	asset, err := a.Store.Asset(r.Context(), assetID(r))
	if err != nil {
		handleError(w, err)
		return
	}
	policy := "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"
	switch asset.MediaType {
	case "text/html":
		policy += "; sandbox; style-src 'unsafe-inline' data:; img-src data:; font-src data:"
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		policy += "; sandbox"
	case "application/pdf":
		// Chromium's native PDF viewer needs its same-origin plugin. HTML remains
		// separately sandboxed; nosniff prevents interpreting these bytes as HTML.
		policy += "; object-src 'self'"
	default:
		fail(w, 415, "this file type cannot be previewed")
		return
	}
	var preview *os.File
	if asset.MediaType == "text/html" && r.Method != http.MethodHead {
		// Disk staging releases SQLite between chunks and finishes preparation
		// before committing a success response. The shared work slot bounds RAM.
		source, err := a.Store.TemporaryFile(".preview-source-*")
		if err != nil {
			handleError(w, err)
			return
		}
		defer os.Remove(source.Name())
		defer source.Close()
		if err = a.Store.WriteAsset(r.Context(), asset.ID, source); err != nil {
			handleError(w, err)
			return
		}
		if _, err = source.Seek(0, io.SeekStart); err != nil {
			handleError(w, err)
			return
		}
		preview, err = a.Store.TemporaryFile(".preview-html-*")
		if err != nil {
			handleError(w, err)
			return
		}
		defer os.Remove(preview.Name())
		defer preview.Close()
		if err = capture.Preview(source, preview); err != nil {
			fail(w, 422, "could not prepare this HTML preview; download the original instead")
			return
		}
		if _, err = preview.Seek(0, io.SeekStart); err != nil {
			handleError(w, err)
			return
		}
	}
	w.Header().Set("Content-Type", asset.MediaType)
	disposition := "inline"
	if asset.MediaType == "text/html" {
		// Only the UI's nested blob viewer supplies the parent frame-src policy
		// that blocks self-navigation. A tokenizer cannot sanitize all HTML5
		// parsing contexts; direct HTML navigation must therefore download.
		disposition = "attachment"
	}
	w.Header().Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": asset.Name}))
	w.Header().Set("Content-Security-Policy", policy)
	w.Header().Set("X-Frame-Options", "SAMEORIGIN")
	if asset.MediaType != "text/html" {
		w.Header().Set("Content-Length", strconv.FormatInt(asset.Size, 10))
	}
	if r.Method == http.MethodHead {
		return
	}
	if preview != nil {
		_, err = io.Copy(w, preview)
	} else {
		err = a.Store.WriteAsset(r.Context(), asset.ID, w)
	}
	if err != nil {
		observability.Error(r.Context(), "attachment_preview_failed", err)
	}
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

// Snapshot copies a consistent WAL view with bounded caches. ZIP Store avoids
// a large compressor; backup deadlines allow large exports without permitting
// an indefinitely stalled download to occupy the archive slot.
func (a *Server) backup(w http.ResponseWriter, r *http.Request) {
	if !a.requireOwner(w, r) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()
	controller := http.NewResponseController(w)
	// The normal 60-second deadline includes snapshot preparation. The backup
	// has its own overall bound and refreshes a bounded deadline on each write.
	if e := controller.SetWriteDeadline(time.Time{}); e != nil && !errors.Is(e, http.ErrNotSupported) {
		handleError(w, e)
		return
	}
	f, e := a.Store.Snapshot(ctx)
	if e != nil {
		handleError(w, e)
		return
	}
	defer os.Remove(f.Name())
	defer f.Close()
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="pocketmark-backup.zip"`)
	z := zip.NewWriter(backupWriter{ctx: ctx, ResponseWriter: w, controller: controller})
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
		_, e = io.WriteString(entry, "Stop Pocketmark. Extract pocketmark.db into an EMPTY data directory (never leave old -wal/-shm files). Set file permissions to 0600 and owner to the service user. Preserve the server-secret file separately (older installations may use access-token or POCKETMARK_TOKEN): it protects the TOTP secret. Login sessions are excluded. Recovery codes and the current TOTP window in this ZIP are invalidated on restore; wait for up to two new authenticator codes, sign in and generate new recovery codes. Clock differences can add delay. If the authenticator is unavailable, run Pocketmark with -reset-mfa locally while stopped, then enroll again using your password. Older ZIPs and raw copies are not automatically detected: reset MFA or regenerate recovery codes and revoke restored sessions manually. Restoring this ZIP with a different server secret requires an MFA reset and new enrollment. Named API keys are independent: review them because a rollback can restore previously revoked keys. Start Pocketmark. The database includes bookmarks, collections, annotations, all captured HTML and uploaded attachments. Keep this sensitive backup private.\n")
	}
	if e != nil {
		observability.Error(r.Context(), "backup_instructions_failed", e)
		return
	}
	if e = z.Close(); e != nil {
		observability.Error(r.Context(), "backup_finish_failed", e)
	}
}

type backupWriter struct {
	http.ResponseWriter
	controller *http.ResponseController
	ctx        context.Context
}

func (w backupWriter) Write(p []byte) (int, error) {
	if err := w.ctx.Err(); err != nil {
		return 0, err
	}
	deadline := time.Now().Add(30 * time.Second)
	if end, ok := w.ctx.Deadline(); ok && end.Before(deadline) {
		deadline = end
	}
	if err := w.controller.SetWriteDeadline(deadline); err != nil && !errors.Is(err, http.ErrNotSupported) {
		return 0, err
	}
	return w.ResponseWriter.Write(p)
}
