package server

import (
	"crypto/sha256"
	"fmt"
	"net/http"
)

func (a *Server) thumbnail(w http.ResponseWriter, r *http.Request) {
	data, err := a.Store.Thumbnail(r.Context(), id(r))
	if err != nil {
		handleError(w, err)
		return
	}
	etag := fmt.Sprintf(`"%x"`, sha256.Sum256(data))
	w.Header().Set("Cache-Control", "private, no-cache")
	w.Header().Set("ETag", etag)
	w.Header().Set("Content-Type", http.DetectContentType(data))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Write(data)
}
