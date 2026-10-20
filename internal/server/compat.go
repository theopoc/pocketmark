package server

// This adapter implements the private-library HTTP shapes used by legacy client's
// extension and mobile client. It does not implement collaboration or NextAuth.
import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"mime"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"pocketmark/internal/store"
)

type compatMap = map[string]any

func compatRespond(w http.ResponseWriter, status int, value any) {
	respond(w, status, compatMap{"response": value})
}
func compatError(w http.ResponseWriter, e error) {
	status := 400
	if errors.Is(e, sql.ErrNoRows) {
		status = 404
	}
	compatRespond(w, status, e.Error())
}
func compatDecode(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 100*1024)
	d := json.NewDecoder(r.Body)
	if e := d.Decode(v); e != nil {
		compatRespond(w, 400, "invalid JSON")
		return false
	}
	var tail any
	if d.Decode(&tail) != io.EOF {
		compatRespond(w, 400, "expected a single JSON document")
		return false
	}
	return true
}
func (a *Server) registerCompat(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/config", func(w http.ResponseWriter, r *http.Request) {
		compatRespond(w, 200, compatMap{"INSTANCE_VERSION": "2.14.1-pocketmark-compat", "POCKETMARK_COMPAT": true, "DISABLE_REGISTRATION": true, "EMAIL_PROVIDER": false, "AI_ENABLED": false, "STRIPE_ENABLED": false, "USER_CONTENT_DOMAIN": nil, "MAX_FILE_BUFFER": 8, "RSS_POLLING_INTERVAL_MINUTES": nil})
	})
	mux.HandleFunc("GET /api/v1/logins", func(w http.ResponseWriter, r *http.Request) {
		respond(w, 200, compatMap{"buttonAuths": []any{}, "credentialsEnabled": true})
	})
	mux.HandleFunc("POST /api/v1/session", a.compatSession)
	mux.HandleFunc("GET /api/v1/users/me", a.compatUser)
	mux.HandleFunc("GET /api/v1/users/{id}", func(w http.ResponseWriter, r *http.Request) {
		if id(r) != 1 {
			compatRespond(w, 404, "user not found")
			return
		}
		a.compatUser(w, r)
	})
	mux.HandleFunc("GET /api/v1/auth/session", func(w http.ResponseWriter, r *http.Request) {
		respond(w, 200, compatMap{"user": compatMap{"id": 1, "name": "Pocketmark", "username": "owner"}})
	})
	mux.HandleFunc("GET /api/v1/collections", a.compatCollections)
	mux.HandleFunc("GET /api/v1/collections/{id}", a.compatGetCollection)
	mux.HandleFunc("POST /api/v1/collections", a.compatSaveCollection)
	mux.HandleFunc("PUT /api/v1/collections/{id}", a.compatSaveCollection)
	mux.HandleFunc("DELETE /api/v1/collections/{id}", func(w http.ResponseWriter, r *http.Request) {
		if e := a.Store.DeleteCollection(r.Context(), id(r)); e != nil {
			compatError(w, e)
			return
		}
		compatRespond(w, 200, compatMap{"id": id(r)})
	})
	mux.HandleFunc("GET /api/v1/links", a.compatSearch)
	mux.HandleFunc("GET /api/v1/search", a.compatSearch)
	mux.HandleFunc("POST /api/v1/links", a.compatSaveLink)
	mux.HandleFunc("PUT /api/v1/links/{id}", a.compatSaveLink)
	mux.HandleFunc("GET /api/v1/links/{id}", a.compatGetLink)
	mux.HandleFunc("DELETE /api/v1/links/{id}", func(w http.ResponseWriter, r *http.Request) {
		l, e := a.Store.Get(r.Context(), id(r))
		if e != nil {
			compatError(w, e)
			return
		}
		v := a.compatLink(r, l)
		if e = a.Store.Delete(r.Context(), id(r)); e != nil {
			compatError(w, e)
			return
		}
		compatRespond(w, 200, v)
	})
	mux.HandleFunc("PUT /api/v1/links/{id}/archive", func(w http.ResponseWriter, r *http.Request) {
		if e := a.Store.Queue(r.Context(), id(r)); e != nil {
			compatError(w, e)
			return
		}
		compatRespond(w, 200, compatMap{"id": id(r)})
	})
	mux.HandleFunc("GET /api/v1/tags", a.compatTags)
	mux.HandleFunc("GET /api/v1/tags/{id}", a.compatGetTag)
	mux.HandleFunc("POST /api/v1/tags", a.compatSaveTag)
	mux.HandleFunc("PUT /api/v1/tags/{id}", a.compatSaveTag)
	mux.HandleFunc("DELETE /api/v1/tags/{id}", a.compatDeleteTag)
	mux.HandleFunc("GET /api/v2/dashboard", a.compatDashboard)
	mux.HandleFunc("GET /api/v1/dashboard", a.compatDashboard)
	mux.HandleFunc("GET /api/v1/links/{id}/highlights", a.compatHighlights)
	mux.HandleFunc("POST /api/v1/highlights", a.compatSaveHighlight)
	mux.HandleFunc("DELETE /api/v1/highlights/{id}", a.compatDeleteHighlight)
	mux.HandleFunc("GET /api/v1/archives/{id}", a.compatArchive)
	mux.HandleFunc("POST /api/v1/archives/{id}", a.compatUploadArchive)
	mux.HandleFunc("GET /api/v1/", func(w http.ResponseWriter, r *http.Request) {
		compatRespond(w, 501, "This legacy client API operation is not supported by Pocketmark")
	})
}
func (a *Server) compatSession(w http.ResponseWriter, r *http.Request) {
	if !a.allowLogin() {
		w.Header().Set("Retry-After", "60")
		compatRespond(w, 429, "too many login attempts")
		return
	}
	var b struct {
		Username    string `json:"username"`
		Password    string `json:"password"`
		SessionName string `json:"sessionName"`
	}
	if !compatDecode(w, r, &b) {
		return
	}
	if !a.verifyPassword(r, b.Username, b.Password) {
		compatRespond(w, 401, "invalid credentials")
		return
	}
	if b.SessionName == "" {
		b.SessionName = "Compatibility client"
	}
	if len(b.SessionName) > 120 {
		compatRespond(w, 400, "session name too long")
		return
	}
	token := randomSecret()
	sum := sha256.Sum256([]byte(token))
	now := time.Now().UTC().Format(time.RFC3339Nano)
	res, e := a.Store.DB.ExecContext(r.Context(), "INSERT INTO api_tokens(name,hash,created_at) SELECT ?,?,? WHERE (SELECT COUNT(*) FROM api_tokens)<32", b.SessionName, hex.EncodeToString(sum[:]), now)
	if e != nil {
		compatError(w, e)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		compatRespond(w, 409, "revoke an unused API key before creating another client session")
		return
	}
	compatRespond(w, 200, compatMap{"token": token})
}
func (a *Server) compatUser(w http.ResponseWriter, r *http.Request) {
	var username, hash string
	_ = a.Store.DB.QueryRowContext(r.Context(), "SELECT username,hash FROM account WHERE id=1").Scan(&username, &hash)
	if username == "" {
		username = "owner"
	}
	sections := []compatMap{{"id": 1, "type": "RECENT_LINKS", "order": 0, "enabled": true}, {"id": 2, "type": "PINNED_LINKS", "order": 1, "enabled": true}}
	var count, collections int
	_ = a.Store.DB.QueryRowContext(r.Context(), "SELECT count(*),(SELECT count(*) FROM collections) FROM links").Scan(&count, &collections)
	compatRespond(w, 200, compatMap{"id": 1, "name": "Pocketmark", "username": username, "email": nil, "image": nil, "theme": "system", "hasPassword": hash != "", "hasOAuthAccount": false, "dashboardSections": sections, "parentSubscription": compatMap{"active": false, "user": compatMap{"email": nil}}, "subscription": nil, "_count": compatMap{"links": count, "collections": collections}, "pinnedLinks": []any{}})
}
func (a *Server) compatCollection(r *http.Request, c store.Collection) compatMap {
	var parent any
	if c.ParentID != nil {
		var name string
		if a.Store.DB.QueryRowContext(r.Context(), "SELECT name FROM collections WHERE id=?", *c.ParentID).Scan(&name) == nil {
			parent = compatMap{"id": *c.ParentID, "name": name}
		}
	}
	var count int
	var createdAt, description string
	if c.ID == 0 {
		_ = a.Store.DB.QueryRowContext(r.Context(), "SELECT count(*),(SELECT created_at FROM library_metadata WHERE id=1) FROM links WHERE collection_id IS NULL").Scan(&count, &createdAt)
	} else {
		_ = a.Store.DB.QueryRowContext(r.Context(), "SELECT (SELECT count(*) FROM links WHERE collection_id=c.id),created_at,description FROM collections c WHERE c.id=?", c.ID).Scan(&count, &createdAt, &description)
	}
	return compatMap{"id": c.ID, "name": c.Name, "description": description, "color": "#10b981", "createdAt": createdAt, "parentId": c.ParentID, "parent": parent, "ownerId": 1, "owner": compatMap{"id": 1, "name": "Pocketmark"}, "members": []any{}, "isPublic": false, "_count": compatMap{"links": count}}
}
func (a *Server) compatCollections(w http.ResponseWriter, r *http.Request) {
	cs, e := a.Store.Collections(r.Context())
	if e != nil {
		compatError(w, e)
		return
	}
	out := []compatMap{a.compatCollection(r, store.Collection{ID: 0, Name: "Inbox"})}
	for _, c := range cs {
		out = append(out, a.compatCollection(r, c))
	}
	compatRespond(w, 200, out)
}
func (a *Server) compatGetCollection(w http.ResponseWriter, r *http.Request) {
	if id(r) == 0 {
		compatRespond(w, 200, a.compatCollection(r, store.Collection{Name: "Inbox"}))
		return
	}
	var c store.Collection
	e := a.Store.DB.QueryRowContext(r.Context(), "SELECT id,name,parent_id FROM collections WHERE id=?", id(r)).Scan(&c.ID, &c.Name, &c.ParentID)
	if e != nil {
		compatError(w, e)
		return
	}
	compatRespond(w, 200, a.compatCollection(r, c))
}
func (a *Server) compatSaveCollection(w http.ResponseWriter, r *http.Request) {
	var c store.Collection
	if !compatDecode(w, r, &c) {
		return
	}
	if c.ParentID != nil && *c.ParentID == 0 {
		c.ParentID = nil
	}
	var e error
	if r.Method == "POST" {
		c.ID, e = a.Store.AddCollection(r.Context(), c)
	} else {
		c.ID = id(r)
		e = a.Store.UpdateCollection(r.Context(), c.ID, c)
	}
	if e != nil {
		compatError(w, e)
		return
	}
	compatRespond(w, 200, a.compatCollection(r, c))
}
func (a *Server) compatTagID(r *http.Request, name string) int64 {
	_, _ = a.Store.DB.ExecContext(r.Context(), "INSERT OR IGNORE INTO compat_tags(name) VALUES(?)", name)
	var id int64
	_ = a.Store.DB.QueryRowContext(r.Context(), "SELECT id FROM compat_tags WHERE name=?", name).Scan(&id)
	return id
}
func (a *Server) compatLink(r *http.Request, l store.Link) compatMap {
	tags := []compatMap{}
	for _, tag := range l.Tags {
		tags = append(tags, compatMap{"id": a.compatTagID(r, tag), "name": tag, "ownerId": 1})
	}
	pins := []compatMap{}
	if l.Favorite {
		pins = append(pins, compatMap{"id": 1})
	}
	c := store.Collection{Name: "Inbox"}
	if l.CollectionID != nil {
		_ = a.Store.DB.QueryRowContext(r.Context(), "SELECT id,name,parent_id FROM collections WHERE id=?", *l.CollectionID).Scan(&c.ID, &c.Name, &c.ParentID)
	}
	var monolith, readability, image, pdf, preview any
	if l.ArchiveAvailable {
		monolith = "page.html"
	}
	if l.Status == "ready" && !store.IsFileURL(l.URL) {
		readability = "reader.html"
	}
	if store.IsFileURL(l.URL) {
		var nonempty bool
		if a.Store.DB.QueryRowContext(r.Context(), "SELECT content<>'' FROM links WHERE id=?", l.ID).Scan(&nonempty) == nil && nonempty {
			readability = "reader.html"
		}
	}
	var assetName, media, kind string
	rows, e := a.Store.DB.QueryContext(r.Context(), "SELECT name,media_type,kind FROM assets WHERE link_id=? ORDER BY id DESC LIMIT 100", l.ID)
	if e == nil {
		for rows.Next() {
			if rows.Scan(&assetName, &media, &kind) != nil {
				break
			}
			if kind == "preview" {
				if preview == nil {
					preview = assetName
				}
				continue
			}
			switch {
			case media == "text/html":
				if monolith == nil {
					monolith = assetName
				}
			case media == "application/pdf":
				if pdf == nil {
					pdf = assetName
				}
			case media == "image/png" || media == "image/jpeg":
				if image == nil {
					image = assetName
				}
			}
		}
		rows.Close()
	}
	var lastPreserved any
	if l.Status != "pending" && l.Status != "processing" {
		lastPreserved = l.UpdatedAt
		if preview == nil {
			preview = "unavailable"
		}
	}
	var linkURL any = l.URL
	linkType := "url"
	if store.IsFileURL(l.URL) {
		linkURL = nil
		linkType = "file"
		if pdf != nil {
			linkType = "pdf"
		} else if image != nil {
			linkType = "image"
		} else if monolith != nil {
			linkType = "monolith"
		}
	}
	return compatMap{"id": l.ID, "url": linkURL, "name": l.Title, "description": l.Description, "notes": l.Notes, "type": linkType, "collectionId": c.ID, "collection": a.compatCollection(r, c), "tags": tags, "pinnedBy": pins, "read": l.Read, "createdAt": l.CreatedAt, "updatedAt": l.UpdatedAt, "lastPreserved": lastPreserved, "image": image, "pdf": pdf, "monolith": monolith, "readable": readability, "preview": preview, "textContent": l.Content, "isPreserved": l.Status == "ready", "preservationStatus": l.Status}
}
func (a *Server) compatGetLink(w http.ResponseWriter, r *http.Request) {
	l, e := a.Store.Get(r.Context(), id(r))
	if e != nil {
		compatError(w, e)
		return
	}
	compatRespond(w, 200, a.compatLink(r, l))
}
func (a *Server) compatSaveLink(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Type        string  `json:"type"`
		URL         *string `json:"url"`
		Name        *string `json:"name"`
		Description *string `json:"description"`
		Notes       *string `json:"notes"`
		Collection  *struct {
			ID   *int64 `json:"id"`
			Name string `json:"name"`
		} `json:"collection"`
		CollectionID *int64 `json:"collectionId"`
		Tags         *[]struct {
			Name string `json:"name"`
		} `json:"tags"`
		PinnedBy *[]struct {
			ID int64 `json:"id"`
		} `json:"pinnedBy"`
		Read *bool `json:"read"`
	}
	if !compatDecode(w, r, &b) {
		return
	}
	var l store.Link
	var e error
	if r.Method == "PUT" {
		l, e = a.Store.Get(r.Context(), id(r))
		if e != nil {
			compatError(w, e)
			return
		}
	}
	if b.URL != nil {
		l.URL = *b.URL
	}
	if r.Method == "POST" && (b.URL == nil || *b.URL == "") && (b.Type == "pdf" || b.Type == "image" || b.Type == "monolith") {
		l.URL = "pocketmark-file:" + randomSecret()
	}

	if b.Name != nil {
		l.Title = *b.Name
	}
	if b.Description != nil {
		l.Description = *b.Description
	}
	if b.Notes != nil {
		l.Notes = *b.Notes
	}
	if b.Read != nil {
		l.Read = *b.Read
	}
	if b.PinnedBy != nil {
		l.Favorite = false
		for _, pin := range *b.PinnedBy {
			if pin.ID == 1 {
				l.Favorite = true
			}
		}
	}
	if b.Tags != nil {
		l.Tags = []string{}
		for _, t := range *b.Tags {
			l.Tags = append(l.Tags, t.Name)
		}
	}
	if b.CollectionID != nil {
		l.CollectionID = b.CollectionID
	}
	if b.Collection != nil {
		l.CollectionID = b.Collection.ID
		if b.Collection.ID == nil && b.Collection.Name != "" {
			cs, e := a.Store.Collections(r.Context())
			if e != nil {
				compatError(w, e)
				return
			}
			for _, c := range cs {
				if c.ParentID == nil && c.Name == b.Collection.Name {
					v := c.ID
					l.CollectionID = &v
					break
				}
			}
			if l.CollectionID == nil {
				v, e := a.Store.AddCollection(r.Context(), store.Collection{Name: b.Collection.Name})
				if e != nil {
					compatError(w, e)
					return
				}
				l.CollectionID = &v
			}
		}
	}
	if r.Method == "POST" {
		l.ID, e = a.Store.Create(r.Context(), l)
	} else {
		e = a.Store.Update(r.Context(), l.ID, l)
	}
	if e != nil {
		compatError(w, e)
		return
	}
	l, e = a.Store.Get(r.Context(), l.ID)
	if e != nil {
		compatError(w, e)
		return
	}
	v := a.compatLink(r, l)
	if store.IsFileURL(l.URL) && b.Type != "" && r.Method == "POST" {
		v["type"] = b.Type
	}
	compatRespond(w, 200, v)
}
func (a *Server) compatSearch(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	cursor, _ := strconv.Atoi(q.Get("cursor"))
	if cursor < 0 || cursor > 10000000 || cursor%40 != 0 {
		compatRespond(w, 400, "invalid pagination cursor")
		return
	}
	query := q.Get("searchQueryString")
	if query == "" {
		query = q.Get("q")
	}
	f := store.Filter{Query: query, Collection: q.Get("collectionId"), Favorite: q.Get("pinnedOnly") == "true", Page: cursor/40 + 1, Sort: map[string]string{"0": "newest", "1": "oldest", "2": "title", "3": "title_desc"}[q.Get("sort")]}
	if tagID := q.Get("tagId"); tagID != "" {
		if e := a.Store.DB.QueryRowContext(r.Context(), "SELECT name FROM compat_tags WHERE id=?", tagID).Scan(&f.Tag); e != nil {
			compatError(w, e)
			return
		}
	}
	var page store.Page
	var e error
	if strings.HasPrefix(query, "url:") {
		var lid int64
		e = a.Store.DB.QueryRowContext(r.Context(), "SELECT id FROM links WHERE url=?", strings.TrimPrefix(query, "url:")).Scan(&lid)
		page = store.Page{Links: []store.Link{}, PageSize: 40}
		if e == nil {
			var l store.Link
			l, e = a.Store.Get(r.Context(), lid)
			if e == nil {
				page.Links = append(page.Links, l)
				page.Total = 1
			}
		} else if errors.Is(e, sql.ErrNoRows) {
			e = nil
		}
	} else {
		page, e = a.Store.List(r.Context(), f)
	}
	if e != nil {
		compatError(w, e)
		return
	}
	links := []compatMap{}
	for _, l := range page.Links {
		links = append(links, a.compatLink(r, l))
	}
	var next any
	if cursor+40 < page.Total {
		next = cursor + 40
	}
	if r.URL.Path == "/api/v1/links" {
		compatRespond(w, 200, links)
		return
	}
	respond(w, 200, compatMap{"data": compatMap{"links": links, "nextCursor": next}, "success": true, "statusCode": 200})
}
func (a *Server) compatTags(w http.ResponseWriter, r *http.Request) {
	_, e := a.Store.DB.ExecContext(r.Context(), "INSERT OR IGNORE INTO compat_tags(name) SELECT DISTINCT value FROM links,json_each(links.tags)")
	if e != nil {
		compatError(w, e)
		return
	}
	offset, _ := strconv.Atoi(r.URL.Query().Get("cursor"))
	if offset < 0 || offset > 10000000 {
		compatRespond(w, 400, "invalid cursor")
		return
	}
	search := r.URL.Query().Get("search")
	if len(search) > 80 {
		compatRespond(w, 400, "tag query too long")
		return
	}
	rows, e := a.Store.DB.QueryContext(r.Context(), "SELECT t.id,t.name,t.created_at,(SELECT count(*) FROM links l,json_each(l.tags) WHERE value=t.name) FROM compat_tags t WHERE instr(lower(t.name),lower(?))>0 ORDER BY t.name COLLATE NOCASE,t.id LIMIT 41 OFFSET ?", search, offset)
	if e != nil {
		compatError(w, e)
		return
	}
	defer rows.Close()
	tags := []compatMap{}
	for rows.Next() {
		var id, count int64
		var name, createdAt string
		if e = rows.Scan(&id, &name, &createdAt, &count); e != nil {
			compatError(w, e)
			return
		}
		tags = append(tags, compatMap{"id": id, "name": name, "createdAt": createdAt, "ownerId": 1, "_count": compatMap{"links": count}})
	}
	var next any
	if len(tags) > 40 {
		tags = tags[:40]
		next = offset + 40
	}
	respond(w, 200, compatMap{"data": compatMap{"tags": tags, "nextCursor": next}, "success": true, "statusCode": 200})
}
func (a *Server) compatGetTag(w http.ResponseWriter, r *http.Request) {
	tag, e := a.compatTag(r, id(r))
	if e != nil {
		compatError(w, e)
		return
	}
	compatRespond(w, 200, tag)
}
func (a *Server) compatTag(r *http.Request, tid int64) (compatMap, error) {
	var name, createdAt string
	var count int64
	e := a.Store.DB.QueryRowContext(r.Context(), "SELECT name,created_at,(SELECT count(*) FROM links l,json_each(l.tags) WHERE value=t.name) FROM compat_tags t WHERE id=?", tid).Scan(&name, &createdAt, &count)
	return compatMap{"id": tid, "name": name, "createdAt": createdAt, "ownerId": 1, "_count": compatMap{"links": count}}, e
}
func (a *Server) compatSaveTag(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Name string `json:"name"`
		Tags *[]struct {
			Label string `json:"label"`
		} `json:"tags"`
	}
	if !compatDecode(w, r, &b) {
		return
	}
	if r.Method == "POST" && b.Tags != nil {
		if len(*b.Tags) == 0 || len(*b.Tags) > 100 {
			compatRespond(w, 400, "expected between 1 and 100 tags")
			return
		}
		for i := range *b.Tags {
			option := &(*b.Tags)[i]
			option.Label = strings.TrimSpace(option.Label)
			if option.Label == "" || len(option.Label) > 80 {
				compatRespond(w, 400, "invalid tag")
				return
			}
		}
		tags := make([]compatMap, 0, len(*b.Tags))
		for _, option := range *b.Tags {
			tid := a.compatTagID(r, option.Label)
			tag, e := a.compatTag(r, tid)
			if e != nil {
				compatError(w, e)
				return
			}
			tags = append(tags, tag)
		}
		compatRespond(w, 200, tags)
		return
	}
	b.Name = strings.TrimSpace(b.Name)
	if b.Name == "" || len(b.Name) > 80 {
		compatRespond(w, 400, "invalid tag")
		return
	}
	tid := id(r)
	if r.Method == "POST" {
		tid = a.compatTagID(r, b.Name)
	} else {
		tx, e := a.Store.DB.BeginTx(r.Context(), nil)
		if e != nil {
			compatError(w, e)
			return
		}
		defer tx.Rollback()
		var old string
		if e = tx.QueryRowContext(r.Context(), "SELECT name FROM compat_tags WHERE id=?", tid).Scan(&old); e != nil {
			compatError(w, e)
			return
		}
		_, e = tx.ExecContext(r.Context(), "UPDATE compat_tags SET name=? WHERE id=?", b.Name, tid)
		if e == nil {
			_, e = tx.ExecContext(r.Context(), `UPDATE links SET tags=(SELECT json_group_array(CASE WHEN value=? THEN ? ELSE value END) FROM json_each(links.tags)) WHERE EXISTS(SELECT 1 FROM json_each(links.tags) WHERE value=?)`, old, b.Name, old)
		}
		if e == nil {
			e = tx.Commit()
		}
		if e != nil {
			compatError(w, e)
			return
		}
	}
	tag, e := a.compatTag(r, tid)
	if e != nil {
		compatError(w, e)
		return
	}
	compatRespond(w, 200, tag)
}
func (a *Server) compatDeleteTag(w http.ResponseWriter, r *http.Request) {
	tx, e := a.Store.DB.BeginTx(r.Context(), nil)
	if e != nil {
		compatError(w, e)
		return
	}
	defer tx.Rollback()
	var name string
	if e = tx.QueryRowContext(r.Context(), "SELECT name FROM compat_tags WHERE id=?", id(r)).Scan(&name); e != nil {
		compatError(w, e)
		return
	}
	_, e = tx.ExecContext(r.Context(), `UPDATE links SET tags=(SELECT json_group_array(value) FROM json_each(links.tags) WHERE value<>?) WHERE EXISTS(SELECT 1 FROM json_each(links.tags) WHERE value=?)`, name, name)
	if e == nil {
		_, e = tx.ExecContext(r.Context(), "DELETE FROM compat_tags WHERE id=?", id(r))
	}
	if e == nil {
		e = tx.Commit()
	}
	if e != nil {
		compatError(w, e)
		return
	}
	compatRespond(w, 200, compatMap{"id": id(r)})
}
func (a *Server) compatDashboard(w http.ResponseWriter, r *http.Request) {
	p, e := a.Store.List(r.Context(), store.Filter{})
	if e != nil {
		compatError(w, e)
		return
	}
	out := []compatMap{}
	seen := map[int64]bool{}
	for i, l := range p.Links {
		if i >= 16 {
			break
		}
		out = append(out, a.compatLink(r, l))
		seen[l.ID] = true
	}
	pins, e := a.Store.List(r.Context(), store.Filter{Favorite: true})
	if e != nil {
		compatError(w, e)
		return
	}
	for i, l := range pins.Links {
		if i >= 16 {
			break
		}
		if !seen[l.ID] {
			out = append(out, a.compatLink(r, l))
		}
	}
	var tags int
	_ = a.Store.DB.QueryRowContext(r.Context(), "SELECT count(DISTINCT value) FROM links,json_each(links.tags)").Scan(&tags)
	if strings.Contains(r.URL.Path, "/v1/") {
		compatRespond(w, 200, out)
		return
	}
	respond(w, 200, compatMap{"data": compatMap{"links": out, "collectionLinks": compatMap{}, "numberOfPinnedLinks": pins.Total, "numberOfTags": tags}, "success": true, "statusCode": 200})
}
func (a *Server) compatArchive(w http.ResponseWriter, r *http.Request) {
	format := r.URL.Query().Get("format")
	preview := r.URL.Query().Get("preview") == "true"
	if format == "" {
		format = "4"
	}
	if preview && format != "0" && format != "1" {
		compatRespond(w, 400, "previews require an image format")
		return
	}
	if format != "3" {
		media := map[string]string{"0": "image/png", "1": "image/jpeg", "2": "application/pdf", "4": "text/html"}[format]
		if media == "" {
			compatRespond(w, 400, "invalid preservation format")
			return
		}
		var assetID int64
		query := "SELECT id FROM assets WHERE link_id=? AND media_type=? AND kind<>'preview' ORDER BY id DESC LIMIT 1"
		args := []any{id(r), media}
		if preview {
			// The mobile picker can retain PNG bytes while requesting JPEG.
			// Serve the original supported preview without a resident image decoder.
			query = "SELECT id FROM assets WHERE link_id=? AND kind='preview' AND media_type IN ('image/png','image/jpeg') ORDER BY id DESC LIMIT 1"
			args = []any{id(r)}
		}
		e := a.Store.DB.QueryRowContext(r.Context(), query, args...).Scan(&assetID)
		if e == nil {
			asset, e := a.Store.Asset(r.Context(), assetID)
			if e != nil {
				compatError(w, e)
				return
			}
			w.Header().Set("Content-Type", asset.MediaType)
			w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": asset.Name}))
			w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
			w.Header().Set("Content-Length", strconv.FormatInt(asset.Size, 10))
			if e = a.Store.WriteAsset(r.Context(), assetID, w); e != nil {
				return
			}
			return
		}
		if format == "4" {
			a.archive(w, r)
			return
		}
		compatRespond(w, 404, "requested preservation format is unavailable")
		return
	}
	l, e := a.Store.Get(r.Context(), id(r))
	if e != nil {
		compatError(w, e)
		return
	}
	if l.Content == "" {
		compatRespond(w, 404, "readable text unavailable")
		return
	}
	respond(w, 200, compatMap{"title": l.Title, "content": "<pre>" + html.EscapeString(l.Content) + "</pre>", "textContent": l.Content, "excerpt": l.Description, "length": len(l.Content), "byline": nil, "siteName": nil})
}

func (a *Server) compatUploadArchive(w http.ResponseWriter, r *http.Request) {
	select {
	case a.imports <- struct{}{}:
		defer func() { <-a.imports }()
	default:
		compatRespond(w, 409, "another upload or import is in progress")
		return
	}
	if _, e := a.Store.Get(r.Context(), id(r)); e != nil {
		compatError(w, e)
		return
	}
	format := r.URL.Query().Get("format")
	preview := r.URL.Query().Get("preview") == "true"
	if preview && format != "0" && format != "1" {
		compatRespond(w, 400, "previews require an image format")
		return
	}
	expected := map[string]string{"0": "image/png", "1": "image/jpeg", "2": "application/pdf", "4": "text/html"}[format]
	if expected == "" {
		compatRespond(w, 400, "invalid upload format")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, store.MaxAssetSize+64*1024)
	mr, e := r.MultipartReader()
	if e != nil {
		compatRespond(w, 400, "expected multipart file upload")
		return
	}
	for count := 0; count < 8; count++ {
		part, e := mr.NextPart()
		if e != nil {
			compatRespond(w, 400, "missing file")
			return
		}
		if part.FormName() != "file" {
			part.Close()
			continue
		}
		reader := bufio.NewReaderSize(part, 512)
		prefix, e := reader.Peek(512)
		if e != nil && e != io.EOF {
			compatRespond(w, 400, "invalid upload")
			return
		}
		media := http.DetectContentType(prefix)
		if bytes.HasPrefix(prefix, []byte("%PDF-")) {
			media = "application/pdf"
		}
		if strings.HasPrefix(media, "text/html") {
			media = "text/html"
		}
		if media != expected && !(preview && (media == "image/png" || media == "image/jpeg")) {
			compatRespond(w, 415, "file does not match requested format")
			return
		}
		name := filepath.Base(part.FileName())
		if name == "." || name == "" {
			name = fmt.Sprintf("preserved-%s", format)
		}
		kind := map[string]string{"0": "image", "1": "image", "2": "pdf", "4": "html"}[format]
		if preview {
			kind = "preview"
		}
		asset, e := a.Store.SaveAsset(r.Context(), store.Asset{LinkID: id(r), Name: name, MediaType: media, Kind: kind}, reader)
		if e != nil {
			compatError(w, e)
			return
		}
		if _, e = a.Store.DB.ExecContext(r.Context(), "UPDATE links SET updated_at=? WHERE id=?", time.Now().UTC().Format(time.RFC3339Nano), id(r)); e != nil {
			compatError(w, e)
			return
		}
		compatRespond(w, 200, asset)
		return
	}
	compatRespond(w, 400, "too many multipart fields")
}

func utf16Offset(text string, offset int) (int, bool) {
	if offset < 0 {
		return 0, false
	}
	units, runes := 0, 0
	for _, r := range text {
		if units == offset {
			return runes, true
		}
		units += utf16.RuneLen(r)
		runes++
	}
	return runes, units == offset
}
func compatHighlight(a store.Annotation, content string) compatMap {
	runes := []rune(content)
	start, end := a.Start, a.End
	if start < 0 || end > len(runes) || start > end {
		start, end = 0, 0
	}
	color := a.Color
	if color == "pink" {
		color = "red"
	}
	return compatMap{"id": a.ID, "linkId": a.LinkID, "userId": 1, "text": a.Quote, "comment": a.Note, "color": color, "startOffset": len(utf16.Encode(runes[:start])), "endOffset": len(utf16.Encode(runes[:end])), "createdAt": a.CreatedAt, "stale": a.Stale}
}
func (a *Server) compatHighlights(w http.ResponseWriter, r *http.Request) {
	l, e := a.Store.Get(r.Context(), id(r))
	if e != nil {
		compatError(w, e)
		return
	}
	annotations, e := a.Store.Annotations(r.Context(), id(r))
	if e != nil {
		compatError(w, e)
		return
	}
	out := []compatMap{}
	for _, ann := range annotations {
		out = append(out, compatHighlight(ann, l.Content))
	}
	compatRespond(w, 200, out)
}
func (a *Server) compatSaveHighlight(w http.ResponseWriter, r *http.Request) {
	var b struct {
		LinkID  int64  `json:"linkId"`
		Text    string `json:"text"`
		Comment string `json:"comment"`
		Color   string `json:"color"`
		Start   int    `json:"startOffset"`
		End     int    `json:"endOffset"`
	}
	if !compatDecode(w, r, &b) {
		return
	}
	l, e := a.Store.Get(r.Context(), b.LinkID)
	if e != nil {
		compatError(w, e)
		return
	}
	start, ok := utf16Offset(l.Content, b.Start)
	end, okEnd := utf16Offset(l.Content, b.End)
	if !ok || !okEnd {
		compatRespond(w, 400, "invalid highlight offsets")
		return
	}
	// The official client trims selected text; trim the anchored range equally.
	chars := []rune(l.Content)
	if start < 0 || end > len(chars) || end <= start {
		compatRespond(w, 400, "invalid highlight range")
		return
	}
	selection := string(chars[start:end])
	trimmed := strings.TrimSpace(selection)
	if trimmed != b.Text {
		compatRespond(w, 400, "highlight no longer matches captured text")
		return
	}
	start += utf8.RuneCountInString(selection) - utf8.RuneCountInString(strings.TrimLeft(selection, " \t\r\n"))
	end = start + utf8.RuneCountInString(trimmed)
	if b.Color == "red" {
		b.Color = "pink"
	}
	ann := store.Annotation{LinkID: b.LinkID, Quote: b.Text, Start: start, End: end, Note: b.Comment, Color: b.Color}
	var existing int64
	_ = a.Store.DB.QueryRowContext(r.Context(), "SELECT id FROM annotations WHERE link_id=? AND start_offset=? AND end_offset=? AND quote=? LIMIT 1", b.LinkID, start, end, b.Text).Scan(&existing)
	ann.ID, e = a.Store.SaveAnnotation(r.Context(), b.LinkID, existing, ann)
	if e != nil {
		compatError(w, e)
		return
	}
	compatRespond(w, 200, compatHighlight(ann, l.Content))
}
func (a *Server) compatDeleteHighlight(w http.ResponseWriter, r *http.Request) {
	var linkID int64
	if e := a.Store.DB.QueryRowContext(r.Context(), "SELECT link_id FROM annotations WHERE id=?", id(r)).Scan(&linkID); e != nil {
		compatError(w, e)
		return
	}
	if e := a.Store.DeleteAnnotation(r.Context(), linkID, id(r)); e != nil {
		compatError(w, e)
		return
	}
	compatRespond(w, 200, id(r))
}
