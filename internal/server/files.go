package server

import (
	"bufio"
	"bytes"
	"io"
	"mime"
	"net/http"
	"os"
	"strconv"
	"strings"

	"pocketmark/internal/capture"
	"pocketmark/internal/store"
)

func (a *Server) registerFiles(mux *http.ServeMux) { mux.HandleFunc("POST /api/files", a.createFile) }
func (a *Server) createFile(w http.ResponseWriter, r *http.Request) {
	select {
	case a.imports <- struct{}{}:
		defer func() { <-a.imports }()
	default:
		fail(w, 409, "another upload or import is in progress")
		return
	}
	name := r.URL.Query().Get("name")
	if name == "" || len(name) > 240 || strings.ContainsAny(name, "/\\\r\n\x00") {
		fail(w, 400, "choose a file name of 1–240 bytes without path separators")
		return
	}
	var collection *int64
	if raw := r.URL.Query().Get("collection"); raw != "" && raw != "0" {
		id, e := strconv.ParseInt(raw, 10, 64)
		if e != nil || id <= 0 {
			fail(w, 400, "invalid collection")
			return
		}
		collection = &id
	}
	r.Body = http.MaxBytesReader(w, r.Body, store.MaxAssetSize)
	reader := bufio.NewReaderSize(r.Body, 512)
	prefix, e := reader.Peek(512)
	if e != nil && e != io.EOF {
		fail(w, 400, "cannot read file")
		return
	}
	media := http.DetectContentType(prefix)
	if bytes.HasPrefix(prefix, []byte("%PDF-")) {
		media = "application/pdf"
	}
	declared, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if declared == "text/html" && (media == "text/plain; charset=utf-8" || strings.HasPrefix(media, "text/html")) {
		media = "text/html"
	}
	if strings.HasPrefix(media, "text/html") {
		media = "text/html"
	}
	kind := ""
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
	// Spool the request before opening a database transaction, keeping a slow
	// upload from occupying the single SQLite connection needed by other readers.
	f, e := a.temporaryDataFile(r.Context(), ".file-upload-*")
	if e != nil {
		handleError(w, e)
		return
	}
	defer os.Remove(f.Name())
	defer f.Close()
	if _, e = io.Copy(f, reader); e != nil {
		fail(w, 400, "file exceeds 20 MiB or upload was interrupted")
		return
	}
	l := store.Link{URL: "pocketmark-file:" + randomSecret(), Title: name, CollectionID: collection}
	if kind == "html" {
		_, _ = f.Seek(0, io.SeekStart)
		parsed, parseErr := capture.ExtractDocument(f)
		if parseErr == nil {
			l.Content = parsed.Content
			l.Description = parsed.Description
		} else {
			w.Header().Set("X-Pocketmark-Warning", "File saved without reader indexing; HTML extraction limits were exceeded")
		}
	}
	if _, e = f.Seek(0, io.SeekStart); e != nil {
		handleError(w, e)
		return
	}
	id, asset, e := a.Store.CreateFile(r.Context(), l, store.Asset{Name: name, MediaType: media, Kind: kind}, f)
	if e != nil {
		handleError(w, e)
		return
	}
	link, e := a.Store.Get(r.Context(), id)
	if e != nil {
		handleError(w, e)
		return
	}
	respond(w, 201, map[string]any{"link": link, "asset": asset})
}
