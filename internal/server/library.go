package server

import (
	"log"
	"net/http"
	"pocketmark/internal/store"
	"strconv"
)

func (a *Server) registerLibrary(mux *http.ServeMux) {
	mux.HandleFunc("PUT /api/collections/{id}", func(w http.ResponseWriter, r *http.Request) {
		var c store.Collection
		if !decode(w, r, &c, 64*1024) {
			return
		}
		if e := a.Store.UpdateCollection(r.Context(), id(r), c); e != nil {
			handleError(w, e)
			return
		}
		respond(w, 200, map[string]bool{"ok": true})
	})
	mux.HandleFunc("POST /api/links/bulk", func(w http.ResponseWriter, r *http.Request) {
		var b store.BulkChange
		if !decode(w, r, &b, 64*1024) {
			return
		}
		if e := a.Store.Bulk(r.Context(), b); e != nil {
			handleError(w, e)
			return
		}
		respond(w, 200, map[string]int{"updated": len(b.IDs)})
	})
	mux.HandleFunc("GET /api/links/{id}/annotations", func(w http.ResponseWriter, r *http.Request) {
		v, e := a.Store.Annotations(r.Context(), id(r))
		if e != nil {
			handleError(w, e)
			return
		}
		respond(w, 200, v)
	})
	save := func(w http.ResponseWriter, r *http.Request) {
		var annotation store.Annotation
		if !decode(w, r, &annotation, 32*1024) {
			return
		}
		aid, _ := strconv.ParseInt(r.PathValue("annotationId"), 10, 64)
		if r.Method == "PUT" && aid <= 0 {
			fail(w, 400, "invalid annotation id")
			return
		}
		v, e := a.Store.SaveAnnotation(r.Context(), id(r), aid, annotation)
		if e != nil {
			fail(w, 400, e.Error())
			return
		}
		respond(w, 200, map[string]int64{"id": v})
	}
	mux.HandleFunc("POST /api/links/{id}/annotations", save)
	mux.HandleFunc("PUT /api/links/{id}/annotations/{annotationId}", save)
	mux.HandleFunc("DELETE /api/links/{id}/annotations/{annotationId}", func(w http.ResponseWriter, r *http.Request) {
		aid, _ := strconv.ParseInt(r.PathValue("annotationId"), 10, 64)
		if e := a.Store.DeleteAnnotation(r.Context(), id(r), aid); e != nil {
			handleError(w, e)
			return
		}
		respond(w, 200, map[string]bool{"ok": true})
	})
	mux.HandleFunc("POST /api/import/html", func(w http.ResponseWriter, r *http.Request) {
		select {
		case a.imports <- struct{}{}:
			defer func() { <-a.imports }()
		default:
			fail(w, 409, "another import is in progress")
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 8*1024*1024)
		v, e := a.Store.ImportHTML(r.Context(), r.Body)
		if e != nil {
			fail(w, 400, e.Error())
			return
		}
		respond(w, 200, v)
	})
	mux.HandleFunc("GET /api/export/html", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
		w.Header().Set("Content-Disposition", `attachment; filename="pocketmark-bookmarks.html"`)
		if e := a.Store.ExportHTML(r.Context(), w); e != nil {
			log.Printf("HTML export: %v", e)
		}
	})
}
