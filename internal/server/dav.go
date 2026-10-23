package server

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"pocketmark/internal/store"
	"strings"
)

func (a *Server) registerDAV(mux *http.ServeMux) {
	for _, method := range []string{"GET", "PUT", "PROPFIND", "OPTIONS", "MKCOL", "DELETE", "POST", "MOVE"} {
		mux.HandleFunc(method+" /dav/", a.dav)
	}
}
func (a *Server) davAuthenticated(r *http.Request) bool {
	if _, p, ok := r.BasicAuth(); ok {
		return secretEqual(p, a.token) || a.validAPIKey(r, p)
	}
	if auth := r.Header.Get("Authorization"); auth != "" && !strings.HasPrefix(auth, "Bearer ") {
		return false
	}
	return a.authenticated(r)
}
func davPrincipal(r *http.Request) string {
	value := r.Header.Get("Authorization")
	if value == "" {
		if c, e := r.Cookie("pocketmark"); e == nil {
			value = c.Value
		}
	}
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
func davError(w http.ResponseWriter, e error) {
	switch {
	case errors.Is(e, store.ErrSyncConflict):
		fail(w, 412, e.Error())
	case errors.Is(e, store.ErrDAVLocked):
		fail(w, 423, e.Error())
	case errors.Is(e, sql.ErrNoRows):
		fail(w, 404, "DAV resource not found")
	default:
		fail(w, 400, e.Error())
	}
}
func (a *Server) dav(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("DAV", "1")
	w.Header().Set("Allow", "OPTIONS, GET, HEAD, PROPFIND, PUT, DELETE, MOVE, MKCOL")
	path := r.URL.Path
	if path != "/dav/" && path != "/dav/bookmarks.xbel" && path != "/dav/bookmarks.xbel.temp" && path != "/dav/bookmarks.xbel.lock" {
		http.NotFound(w, r)
		return
	}
	if r.Method == "OPTIONS" {
		w.WriteHeader(204)
		return
	}
	if r.Method == "MKCOL" {
		w.WriteHeader(405)
		return
	}
	principal := davPrincipal(r)
	if path == "/dav/bookmarks.xbel.lock" {
		a.davLock(w, r, principal)
		return
	}
	if r.Method == "DELETE" && path == "/dav/bookmarks.xbel.temp" {
		if e := a.Store.DeleteDAVTemp(r.Context(), principal); e != nil {
			davError(w, e)
			return
		}
		w.WriteHeader(204)
		return
	}
	if r.Method == "PUT" || r.Method == "MOVE" {
		a.davWrite(w, r, principal)
		return
	}
	if r.Method != "GET" && r.Method != "HEAD" && r.Method != "PROPFIND" {
		w.WriteHeader(405)
		return
	}
	if path == "/dav/" && r.Method != "PROPFIND" {
		w.WriteHeader(405)
		return
	}
	if path == "/dav/" && r.Header.Get("Depth") == "0" {
		davProperties(w, r, store.DAVFile{})
		return
	}
	f, e := a.Store.TemporaryFile(".xbel-*")
	if e != nil {
		davError(w, e)
		return
	}
	defer os.Remove(f.Name())
	defer f.Close()
	var meta store.DAVFile
	if path == "/dav/bookmarks.xbel.temp" {
		meta, e = a.Store.WriteDAVTemp(r.Context(), principal, f)
	} else {
		meta, e = a.Store.WriteDAVSnapshot(r.Context(), f)
	}
	if e != nil {
		davError(w, e)
		return
	}
	if path == "/dav/bookmarks.xbel" && r.Method == "GET" {
		if e = a.Store.ConfirmDAVRead(r.Context(), principal, meta.Revision); e != nil {
			davError(w, e)
			return
		}
	}
	w.Header().Set("ETag", meta.ETag)
	w.Header().Set("Last-Modified", meta.Modified.UTC().Format(http.TimeFormat))
	if r.Method == "PROPFIND" {
		davProperties(w, r, meta)
		return
	}
	if r.Header.Get("If-None-Match") == meta.ETag {
		w.WriteHeader(304)
		return
	}
	w.Header().Set("Content-Type", "application/xbel+xml")
	w.Header().Set("Content-Disposition", `attachment; filename="bookmarks.xbel"`)
	if _, e = f.Seek(0, io.SeekStart); e != nil {
		davError(w, e)
		return
	}
	http.ServeContent(w, r, "bookmarks.xbel", meta.Modified, f)
}
func davProperties(w http.ResponseWriter, r *http.Request, meta store.DAVFile) {
	w.Header().Set("Content-Type", "application/xml; charset=utf-8")
	w.WriteHeader(207)
	fmt.Fprint(w, `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">`)
	if r.URL.Path == "/dav/" {
		fmt.Fprint(w, `<d:response><d:href>/dav/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`)
	}
	if r.URL.Path != "/dav/" || r.Header.Get("Depth") != "0" {
		path := r.URL.Path
		if path == "/dav/" {
			path = "/dav/bookmarks.xbel"
		}
		fmt.Fprintf(w, `<d:response><d:href>%s</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>%d</d:getcontentlength><d:getetag>%s</d:getetag><d:getlastmodified>%s</d:getlastmodified><d:getcontenttype>application/xbel+xml</d:getcontenttype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`, path, meta.Size, strings.ReplaceAll(meta.ETag, `"`, "&quot;"), meta.Modified.UTC().Format(http.TimeFormat))
	}
	fmt.Fprint(w, `</d:multistatus>`)
}
func (a *Server) davLock(w http.ResponseWriter, r *http.Request, owner string) {
	switch r.Method {
	case "GET", "HEAD":
		modified, e := a.Store.DAVLockTime(r.Context())
		if e != nil {
			davError(w, e)
			return
		}
		w.Header().Set("Last-Modified", modified.UTC().Format(http.TimeFormat))
		w.Header().Set("Content-Type", "text/plain")
		http.ServeContent(w, r, "bookmarks.xbel.lock", modified, strings.NewReader("Pocketmark synchronization lock\n"))
	case "PUT":
		r.Body = http.MaxBytesReader(w, r.Body, 4096)
		if _, e := io.Copy(io.Discard, r.Body); e != nil {
			fail(w, 413, "lock body too large")
			return
		}
		modified, e := a.Store.DAVLock(r.Context(), owner, true)
		if e != nil {
			davError(w, e)
			return
		}
		w.Header().Set("Last-Modified", modified.UTC().Format(http.TimeFormat))
		w.WriteHeader(201)
	case "DELETE":
		if _, e := a.Store.DAVLock(r.Context(), owner, false); e != nil {
			davError(w, e)
			return
		}
		w.WriteHeader(204)
	default:
		w.WriteHeader(405)
	}
}
func (a *Server) davWrite(w http.ResponseWriter, r *http.Request, owner string) {
	if r.URL.Path != "/dav/bookmarks.xbel" && r.URL.Path != "/dav/bookmarks.xbel.temp" {
		w.WriteHeader(405)
		return
	}
	select {
	case a.imports <- struct{}{}:
		defer func() { <-a.imports }()
	default:
		fail(w, 423, "another import or synchronization is running")
		return
	}
	if r.Method == "MOVE" {
		if r.URL.Path != "/dav/bookmarks.xbel.temp" {
			w.WriteHeader(405)
			return
		}
		target, e := url.Parse(r.Header.Get("Destination"))
		if e != nil || target.Path != "/dav/bookmarks.xbel" || target.User != nil || target.RawQuery != "" || target.Fragment != "" || (target.Host != "" && !strings.EqualFold(target.Host, r.Host)) || (target.Scheme != "" && target.Scheme != "http" && target.Scheme != "https") {
			fail(w, 400, "MOVE destination must be this server's bookmarks.xbel")
			return
		}
		if r.Header.Get("Overwrite") == "F" {
			w.WriteHeader(412)
			return
		}
	} else if r.Header.Get("If-None-Match") == "*" && r.URL.Path == "/dav/bookmarks.xbel" {
		w.WriteHeader(412)
		return
	}
	f, e := a.Store.TemporaryFile(".dav-upload-*")
	if e != nil {
		davError(w, e)
		return
	}
	defer os.Remove(f.Name())
	defer f.Close()
	tempETag := ""
	if r.Method == "MOVE" {
		meta, err := a.Store.WriteDAVTemp(r.Context(), owner, f)
		if err != nil {
			davError(w, err)
			return
		}
		tempETag = meta.ETag
	} else {
		r.Body = http.MaxBytesReader(w, r.Body, store.MaxDAVSize)
		if _, e = io.Copy(f, r.Body); e != nil {
			fail(w, 413, "XBEL exceeds 8 MiB or upload interrupted")
			return
		}
	}
	if _, e = f.Seek(0, io.SeekStart); e != nil {
		davError(w, e)
		return
	}
	if r.Method == "PUT" && r.URL.Path == "/dav/bookmarks.xbel.temp" {
		e = a.Store.StageDAV(r.Context(), owner, f)
	} else {
		e = a.Store.ApplyDAV(r.Context(), owner, f, r.Header.Get("If-Match"), tempETag)
	}
	if e != nil {
		davError(w, e)
		return
	}
	w.WriteHeader(204)
}
