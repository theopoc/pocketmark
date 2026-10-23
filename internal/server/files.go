package server

import (
	"io"
	"net/http"
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
	upload, ok := a.stageUpload(w, r, "file")
	if !ok {
		return
	}
	defer upload.cleanup()
	l := store.Link{URL: "pocketmark-file:" + randomSecret(), Title: name, CollectionID: collection}
	if upload.kind == "html" {
		parsed, parseErr := capture.ExtractDocument(upload.file)
		if parseErr == nil {
			l.Content = parsed.Content
			l.Description = parsed.Description
		} else {
			w.Header().Set("X-Pocketmark-Warning", "File saved without reader indexing; HTML extraction limits were exceeded")
		}
	}
	if _, e := upload.file.Seek(0, io.SeekStart); e != nil {
		handleError(w, e)
		return
	}
	id, asset, e := a.Store.CreateFile(r.Context(), l, store.Asset{Name: name, MediaType: upload.mediaType, Kind: upload.kind}, upload.file)
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
