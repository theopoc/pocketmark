package server

import (
	"net/http"
	"pocketmark/internal/capture"
	"pocketmark/internal/store"
)

func (a *Server) siteIcon(w http.ResponseWriter, r *http.Request) {
	select {
	case a.iconRequests <- struct{}{}:
		defer func() { <-a.iconRequests }()
	default:
		fail(w, http.StatusServiceUnavailable, "icon fetch busy")
		return
	}
	link, err := a.Store.Get(r.Context(), id(r))
	if err != nil {
		handleError(w, err)
		return
	}
	if store.IsFileURL(link.URL) {
		http.NotFound(w, r)
		return
	}
	var archive []byte
	if link.ArchiveAvailable {
		archive, _ = a.Store.Archive(r.Context(), link.ID)
	}
	data, kind := capture.SiteIcon(r.Context(), link.URL, archive)
	if len(data) == 0 {
		http.NotFound(w, r)
		return
	}
	// A URL change must not populate a response for an earlier bookmark URL.
	current, err := a.Store.Get(r.Context(), link.ID)
	if err != nil || current.URL != link.URL {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "private, max-age=3600")
	w.Header().Add("Vary", "Cookie")
	w.Header().Add("Vary", "Authorization")
	w.Header().Set("Content-Type", kind)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write(data)
}
