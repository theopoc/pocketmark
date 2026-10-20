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
	const pageSize = 40
	const source = " FROM links,json_each(links.tags) WHERE instr(lower(value),lower(?)) > 0"
	const initial = "CASE WHEN upper(substr(value,1,1)) BETWEEN 'A' AND 'Z' THEN upper(substr(value,1,1)) ELSE '#' END"
	const order = "CASE WHEN letter = '#' THEN 1 ELSE 0 END,letter"
	groupsRows, err := a.Store.DB.QueryContext(r.Context(), "SELECT "+initial+" AS letter,COUNT(DISTINCT value)"+source+" GROUP BY letter ORDER BY "+order, query)
	if err != nil {
		handleError(w, err)
		return
	}
	type group struct {
		Letter string `json:"letter"`
		Count  int    `json:"count"`
	}
	groups := []group{}
	total := 0
	for groupsRows.Next() {
		var item group
		if err := groupsRows.Scan(&item.Letter, &item.Count); err != nil {
			groupsRows.Close()
			handleError(w, err)
			return
		}
		if item.Letter == jump {
			page = total/pageSize + 1
		}
		total += item.Count
		groups = append(groups, item)
	}
	err = groupsRows.Err()
	groupsRows.Close()
	if err != nil {
		handleError(w, err)
		return
	}
	rows, err := a.Store.DB.QueryContext(r.Context(), "SELECT value,COUNT(*),"+initial+" AS letter"+source+" GROUP BY value ORDER BY "+order+",value COLLATE NOCASE,value LIMIT ? OFFSET ?", query, pageSize, (page-1)*pageSize)
	if err != nil {
		handleError(w, err)
		return
	}
	defer rows.Close()
	type tag struct {
		Name   string `json:"name"`
		Count  int    `json:"count"`
		Letter string `json:"letter"`
	}
	tags := []tag{}
	for rows.Next() {
		var item tag
		if err := rows.Scan(&item.Name, &item.Count, &item.Letter); err != nil {
			handleError(w, err)
			return
		}
		tags = append(tags, item)
	}
	if err := rows.Err(); err != nil {
		handleError(w, err)
		return
	}
	respond(w, 200, map[string]any{"tags": tags, "groups": groups, "total": total, "page": page, "pageSize": pageSize})
}
