package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"pocketmark/internal/store"
	"pocketmark/internal/webui"
)

type Server struct {
	Store      *store.Store
	token      string
	secure     bool
	origin     string
	mux        *http.ServeMux
	requests   chan struct{}
	imports    chan struct{}
	loginMu    sync.Mutex
	loginAt    time.Time
	loginCount int
	passwordMu sync.Mutex
}

func New(s *store.Store, token, origin string, secure bool) *Server {
	a := &Server{Store: s, token: token, origin: strings.TrimSuffix(origin, "/"), secure: secure, mux: http.NewServeMux(), requests: make(chan struct{}, 8), imports: make(chan struct{}, 1)}
	a.registerAccount(a.mux)
	a.registerLibrary(a.mux)
	a.registerDAV(a.mux)
	a.registerAssets(a.mux)
	a.registerFiles(a.mux)
	a.mux.HandleFunc("POST /api/login", a.login)
	a.mux.HandleFunc("POST /api/logout", func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, &http.Cookie{Name: "pocketmark", Value: "", Path: "/", HttpOnly: true, Secure: a.secure, SameSite: http.SameSiteStrictMode, MaxAge: -1})
		respond(w, 200, map[string]bool{"ok": true})
	})
	a.mux.HandleFunc("GET /api/session", func(w http.ResponseWriter, r *http.Request) { respond(w, 200, map[string]bool{"authenticated": true}) })
	a.mux.HandleFunc("GET /api/stats", a.stats)
	a.mux.HandleFunc("GET /api/tags", a.tags)
	a.mux.HandleFunc("GET /api/tags/browse", a.browseTags)
	a.mux.HandleFunc("GET /api/collections", a.collections)
	a.mux.HandleFunc("POST /api/collections", a.createCollection)
	a.mux.HandleFunc("DELETE /api/collections/{id}", a.deleteCollection)
	a.mux.HandleFunc("GET /api/links", a.links)
	a.mux.HandleFunc("POST /api/links", a.createLink)
	a.mux.HandleFunc("GET /api/links/{id}", a.getLink)
	a.mux.HandleFunc("PUT /api/links/{id}", a.updateLink)
	a.mux.HandleFunc("DELETE /api/links/{id}", a.deleteLink)
	a.mux.HandleFunc("POST /api/links/{id}/capture", a.captureLink)
	a.mux.HandleFunc("GET /api/links/{id}/archive", a.archive)
	a.mux.HandleFunc("POST /api/import", a.importData)
	a.mux.HandleFunc("GET /api/export", a.exportData)
	a.mux.HandleFunc("GET /api/", func(w http.ResponseWriter, r *http.Request) { fail(w, 404, "endpoint not found") })
	a.mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		if e := s.Ping(r.Context()); e != nil {
			fail(w, 503, "database unavailable")
			return
		}
		respond(w, 200, map[string]string{"status": "ok"})
	})
	assets, _ := fs.Sub(webui.Files, "static")
	a.mux.Handle("GET /", http.FileServer(http.FS(assets)))
	return a
}
func (a *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
	extension := extensionOrigin(r.Header.Get("Origin"))
	isDAV := strings.HasPrefix(r.URL.Path, "/dav/")
	if extension && (strings.HasPrefix(r.URL.Path, "/api/") || isDAV) {
		w.Header().Set("Access-Control-Allow-Origin", r.Header.Get("Origin"))
		w.Header().Set("Vary", "Origin")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		if isDAV {
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Depth, Destination, Overwrite, If-Match, If-None-Match")
			w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, PUT, DELETE, OPTIONS, PROPFIND, MOVE, MKCOL")
			w.Header().Set("Access-Control-Expose-Headers", "ETag, Last-Modified, Content-Length")
		}
		if r.Method == "OPTIONS" {
			w.WriteHeader(204)
			return
		}
	}
	if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/dav/") {
		w.Header().Set("Cache-Control", "no-store")
	}
	select {
	case a.requests <- struct{}{}:
		defer func() { <-a.requests }()
	default:
		fail(w, 503, "server busy; try again shortly")
		return
	}
	if r.Method != "GET" && r.Method != "HEAD" && !(extension && (strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") || (isDAV && strings.HasPrefix(r.Header.Get("Authorization"), "Basic ")))) {
		// An exact Origin check protects both login and cookie-authenticated mutations.
		if o := r.Header.Get("Origin"); o != "" {
			expected := a.origin
			if expected == "" {
				scheme := "http"
				if r.TLS != nil {
					scheme = "https"
				}
				expected = scheme + "://" + r.Host
			}
			if o != expected {
				fail(w, 403, "origin rejected")
				return
			}
		}
		if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
			fail(w, 403, "cross-site request rejected")
			return
		}
	}
	publicAPI := r.URL.Path == "/api/login" || r.URL.Path == "/api/setup"
	if strings.HasPrefix(r.URL.Path, "/api/") && !publicAPI && !a.authenticated(r) {
		fail(w, 401, "sign in required")
		return
	}
	if strings.HasPrefix(r.URL.Path, "/dav/") && !a.davAuthenticated(r) {
		w.Header().Set("WWW-Authenticate", `Basic realm="Pocketmark", charset="UTF-8"`)
		fail(w, 401, "sign in required")
		return
	}
	a.mux.ServeHTTP(w, r)
}
func (a *Server) authenticated(r *http.Request) bool {
	if auth := r.Header.Get("Authorization"); strings.HasPrefix(auth, "Bearer ") {
		key := strings.TrimPrefix(auth, "Bearer ")
		return secretEqual(key, a.token) || a.validAPIKey(r, key)
	}
	c, e := r.Cookie("pocketmark")
	if e != nil {
		return false
	}
	parts := strings.Split(c.Value, ".")
	if len(parts) != 2 {
		return false
	}
	expiry, e := strconv.ParseInt(parts[0], 10, 64)
	if e != nil || time.Now().Unix() > expiry {
		return false
	}
	return hmac.Equal([]byte(parts[1]), []byte(a.sign(parts[0])))
}
func secretEqual(x, y string) bool {
	a := sha256.Sum256([]byte(x))
	b := sha256.Sum256([]byte(y))
	return subtle.ConstantTimeCompare(a[:], b[:]) == 1
}
func (a *Server) sign(value string) string {
	h := hmac.New(sha256.New, []byte(a.token))
	h.Write([]byte(value))
	account, _ := a.Store.Account(context.Background())
	h.Write([]byte(account.Salt))
	return hex.EncodeToString(h.Sum(nil))
}
func (a *Server) login(w http.ResponseWriter, r *http.Request) {
	if !a.allowLogin() {
		w.Header().Set("Retry-After", "60")
		fail(w, 429, "too many login attempts; retry in a minute")
		return
	}
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !decode(w, r, &body, 4096) {
		return
	}
	if !a.verifyPassword(r, body.Username, body.Password) {
		fail(w, 401, "invalid credentials")
		return
	}
	a.issueSession(w)
	respond(w, 200, map[string]bool{"authenticated": true})
}
func (a *Server) allowLogin() bool {
	a.loginMu.Lock()
	if time.Since(a.loginAt) > time.Minute {
		a.loginAt = time.Now()
		a.loginCount = 0
	}
	a.loginCount++
	limited := a.loginCount > 10
	a.loginMu.Unlock()
	return !limited
}
func decode(w http.ResponseWriter, r *http.Request, target any, max int64) bool {
	if ct := r.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		fail(w, 415, "Content-Type must be application/json")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, max)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if e := d.Decode(target); e != nil {
		fail(w, 400, "invalid JSON or request too large")
		return false
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		fail(w, 400, "expected a single JSON document")
		return false
	}
	return true
}
func respond(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if e := json.NewEncoder(w).Encode(v); e != nil {
		log.Printf("write response: %v", e)
	}
}
func fail(w http.ResponseWriter, status int, message string) {
	respond(w, status, map[string]string{"error": message})
}
func handleError(w http.ResponseWriter, e error) {
	if errors.Is(e, sql.ErrNoRows) {
		fail(w, 404, "not found or currently processing")
		return
	}
	log.Printf("request: %v", e)
	fail(w, 400, "request could not be saved; check field limits, collection, or duplicate URL")
}
func id(r *http.Request) int64 { v, _ := strconv.ParseInt(r.PathValue("id"), 10, 64); return v }
func (a *Server) collections(w http.ResponseWriter, r *http.Request) {
	v, e := a.Store.Collections(r.Context())
	if e != nil {
		handleError(w, e)
		return
	}
	respond(w, 200, v)
}
func (a *Server) createCollection(w http.ResponseWriter, r *http.Request) {
	var c store.Collection
	if !decode(w, r, &c, 64*1024) {
		return
	}
	v, e := a.Store.AddCollection(r.Context(), c)
	if e != nil {
		handleError(w, e)
		return
	}
	c.ID = v
	respond(w, 201, c)
}
func (a *Server) deleteCollection(w http.ResponseWriter, r *http.Request) {
	if e := a.Store.DeleteCollection(r.Context(), id(r)); e != nil {
		handleError(w, e)
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}
func (a *Server) links(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if raw := q.Get("url"); raw != "" {
		if len(raw) > 4096 {
			fail(w, 400, "URL too long")
			return
		}
		link, err := a.Store.FindURL(r.Context(), raw)
		p := store.Page{Links: []store.Link{}, Page: 1, PageSize: 40}
		if err == nil {
			p.Links = append(p.Links, link)
			p.Total = 1
		} else if !errors.Is(err, sql.ErrNoRows) {
			handleError(w, err)
			return
		}
		respond(w, 200, p)
		return
	}
	if len(q.Get("q")) > 512 {
		fail(w, 400, "search query too long")
		return
	}
	page, _ := strconv.Atoi(q.Get("page"))
	if page > 1000000 {
		fail(w, 400, "page out of range")
		return
	}
	v, e := a.Store.List(r.Context(), store.Filter{Query: q.Get("q"), Collection: q.Get("collection"), Tag: q.Get("tag"), Favorite: q.Get("favorite") == "1", Unread: q.Get("unread") == "1", Page: page, Sort: q.Get("sort"), Fuzzy: q.Get("fuzzy") == "1"})
	if e != nil {
		handleError(w, e)
		return
	}
	respond(w, 200, v)
}
func (a *Server) createLink(w http.ResponseWriter, r *http.Request) {
	var l store.Link
	if !decode(w, r, &l, 100*1024) {
		return
	}
	v, e := a.Store.Create(r.Context(), l)
	if e != nil {
		handleError(w, e)
		return
	}
	link, e := a.Store.Get(r.Context(), v)
	if e != nil {
		handleError(w, e)
		return
	}
	respond(w, 201, link)
}
func (a *Server) getLink(w http.ResponseWriter, r *http.Request) {
	l, e := a.Store.Get(r.Context(), id(r))
	if e != nil {
		handleError(w, e)
		return
	}
	respond(w, 200, l)
}
func (a *Server) updateLink(w http.ResponseWriter, r *http.Request) {
	var l store.Link
	if !decode(w, r, &l, 100*1024) {
		return
	}
	if e := a.Store.Update(r.Context(), id(r), l); e != nil {
		handleError(w, e)
		return
	}
	a.getLink(w, r)
}
func (a *Server) deleteLink(w http.ResponseWriter, r *http.Request) {
	if e := a.Store.Delete(r.Context(), id(r)); e != nil {
		handleError(w, e)
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}
func (a *Server) captureLink(w http.ResponseWriter, r *http.Request) {
	if e := a.Store.Queue(r.Context(), id(r)); e != nil {
		handleError(w, e)
		return
	}
	respond(w, 202, map[string]bool{"ok": true})
}
func (a *Server) stats(w http.ResponseWriter, r *http.Request) {
	stats, err := a.Store.Stats(r.Context())
	if err != nil {
		handleError(w, err)
		return
	}
	respond(w, 200, stats)
}
func (a *Server) tags(w http.ResponseWriter, r *http.Request) {
	tags, err := a.Store.Tags(r.Context())
	if err != nil {
		handleError(w, err)
		return
	}
	respond(w, 200, tags)
}
func (a *Server) archive(w http.ResponseWriter, r *http.Request) {
	raw, e := a.Store.Archive(r.Context(), id(r))
	if e != nil {
		handleError(w, e)
		return
	}
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `attachment; filename="page.html"`)
	w.Write(raw)
}
func (a *Server) importData(w http.ResponseWriter, r *http.Request) {
	select {
	case a.imports <- struct{}{}:
		defer func() { <-a.imports }()
	default:
		fail(w, 409, "another import is in progress")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8*1024*1024)
	v, e := a.Store.Import(r.Context(), r.Body)
	if e != nil {
		fail(w, 400, e.Error())
		return
	}
	respond(w, 200, v)
}
func (a *Server) exportData(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Disposition", `attachment; filename="pocketmark-export.json"`)
	if e := a.Store.Export(r.Context(), w); e != nil {
		log.Printf("export: %v", e)
	}
}

func ValidateOrigin(raw string) error {
	if raw == "" {
		return nil
	}
	u, e := url.Parse(raw)
	if e != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return errors.New("POCKETMARK_ORIGIN must be an http(s) origin without a path")
	}
	return nil
}
