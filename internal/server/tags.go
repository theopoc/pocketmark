package server

import (
	"net/http"
	"strconv"
	"strings"
)

// browseTags keeps the sidebar's existing top-tags contract while providing
// a bounded, searchable directory of every tag used in the library.
func (a *Server) browseTags(w http.ResponseWriter, r *http.Request) {
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	page := 1
	if raw := r.URL.Query().Get("page"); raw != "" {
		var err error
		page, err = strconv.Atoi(raw)
		if err != nil || page < 1 || page > 1000000 {
			fail(w, 400, "invalid page")
			return
		}
	}
	if len(query) > 512 {
		fail(w, 400, "tag search is too long")
		return
	}
	jump := strings.ToUpper(r.URL.Query().Get("jump"))
	if jump != "" && (len(jump) != 1 || !(jump >= "A" && jump <= "Z" || jump == "#")) {
		fail(w, 400, "invalid tag letter")
		return
	}
	result, err := a.Store.BrowseTags(r.Context(), query, page, jump)
	if err != nil {
		handleError(w, err)
		return
	}
	respond(w, 200, result)
}
