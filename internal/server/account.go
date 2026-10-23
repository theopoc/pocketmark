package server

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"pocketmark/internal/store"
)

func extensionOrigin(raw string) bool {
	u, e := url.Parse(raw)
	return e == nil && (u.Scheme == "chrome-extension" || u.Scheme == "moz-extension") && u.Host != "" && u.Path == "" && u.User == nil && u.RawQuery == "" && u.Fragment == ""
}

// Password derivation is CPU-bound and serialized; it needs no large RAM arena.
func passwordHash(password, salt string) string {
	key, err := pbkdf2.Key(sha256.New, password, []byte(salt), 600000, 32)
	if err != nil {
		return ""
	}
	return hex.EncodeToString(key)
}
func randomSecret() string {
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b)
}
func (a *Server) registerAccount(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/setup", a.setupStatus)
	mux.HandleFunc("POST /api/setup", a.setup)
	mux.HandleFunc("GET /api/account", a.account)
	mux.HandleFunc("PUT /api/account", a.setAccount)
	mux.HandleFunc("GET /api/tokens", a.tokens)
	mux.HandleFunc("POST /api/tokens", a.createToken)
	mux.HandleFunc("DELETE /api/tokens/{id}", a.deleteToken)
}
func (a *Server) owner(r *http.Request) bool {
	if auth := r.Header.Get("Authorization"); auth != "" {
		return secretEqual(strings.TrimPrefix(auth, "Bearer "), a.token)
	}
	return a.authenticated(r)
}
func (a *Server) requireOwner(w http.ResponseWriter, r *http.Request) bool {
	if !a.owner(r) {
		fail(w, 403, "account settings require the owner session or recovery token")
		return false
	}
	return true
}
func (a *Server) account(w http.ResponseWriter, r *http.Request) {
	if !a.requireOwner(w, r) {
		return
	}
	account, err := a.Store.Account(r.Context())
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		handleError(w, err)
		return
	}
	respond(w, 200, map[string]any{"username": account.Username, "passwordEnabled": account.Hash != ""})
}

func (a *Server) setupStatus(w http.ResponseWriter, r *http.Request) {
	state, err := a.Store.SetupStatus(r.Context())
	if err != nil {
		handleError(w, err)
		return
	}
	respond(w, 200, state)
}

func (a *Server) setup(w http.ResponseWriter, r *http.Request) {
	if !a.allowLogin() {
		w.Header().Set("Retry-After", "60")
		fail(w, 429, "too many login attempts; retry in a minute")
		return
	}
	var b struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !decode(w, r, &b, 4096) {
		return
	}
	b.Username = strings.TrimSpace(b.Username)
	if b.Username == "" || len(b.Username) > 120 || len(b.Password) < 12 || len(b.Password) > 1024 {
		fail(w, 400, "choose a username and a password of 12–1024 bytes")
		return
	}
	a.passwordMu.Lock()
	defer a.passwordMu.Unlock()
	salt := randomSecret()
	created, err := a.Store.CreateAccount(r.Context(), store.Account{Username: b.Username, Salt: salt, Hash: passwordHash(b.Password, salt)})
	if err != nil {
		handleError(w, err)
		return
	}
	if !created {
		fail(w, 409, "account creation is unavailable; sign in or ask the server administrator to configure your password")
		return
	}
	a.issueSession(w)
	respond(w, 201, map[string]bool{"authenticated": true})
}
func (a *Server) setAccount(w http.ResponseWriter, r *http.Request) {
	if !a.requireOwner(w, r) {
		return
	}
	var b struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !decode(w, r, &b, 8192) {
		return
	}
	b.Username = strings.TrimSpace(b.Username)
	if b.Username == "" || len(b.Username) > 120 || len(b.Password) < 12 || len(b.Password) > 1024 {
		fail(w, 400, "choose a username and a password of 12–1024 bytes")
		return
	}
	a.passwordMu.Lock()
	defer a.passwordMu.Unlock()
	salt := randomSecret()
	hash := passwordHash(b.Password, salt)
	if err := a.Store.SaveAccount(r.Context(), store.Account{Username: b.Username, Salt: salt, Hash: hash}); err != nil {
		handleError(w, err)
		return
	}
	a.issueSession(w)
	respond(w, 200, map[string]bool{"ok": true})
}
func (a *Server) verifyPassword(r *http.Request, username, password string) bool {
	if len(password) > 1024 || password == "" {
		return false
	}
	a.passwordMu.Lock()
	defer a.passwordMu.Unlock()
	account, err := a.Store.Account(r.Context())
	if err != nil || account.Hash == "" {
		return false
	}
	got := passwordHash(password, account.Salt)
	return secretEqual(username, account.Username) && secretEqual(got, account.Hash)
}
func (a *Server) validAPIKey(r *http.Request, key string) bool {
	if len(key) != 64 {
		return false
	}
	sum := sha256.Sum256([]byte(key))
	return a.Store.HasAPIKeyHash(r.Context(), hex.EncodeToString(sum[:]))
}

type apiToken struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	CreatedAt string `json:"createdAt"`
	Token     string `json:"token,omitempty"`
}

func (a *Server) tokens(w http.ResponseWriter, r *http.Request) {
	if !a.requireOwner(w, r) {
		return
	}
	keys, err := a.Store.APIKeys(r.Context())
	if err != nil {
		handleError(w, err)
		return
	}
	respond(w, 200, keys)
}
func (a *Server) createToken(w http.ResponseWriter, r *http.Request) {
	if !a.requireOwner(w, r) {
		return
	}
	var b struct {
		Name string `json:"name"`
	}
	if !decode(w, r, &b, 4096) {
		return
	}
	b.Name = strings.TrimSpace(b.Name)
	if b.Name == "" || len(b.Name) > 120 {
		fail(w, 400, "name must contain 1–120 bytes")
		return
	}
	token := randomSecret()
	sum := sha256.Sum256([]byte(token))
	key, err := a.Store.CreateAPIKey(r.Context(), b.Name, hex.EncodeToString(sum[:]))
	if errors.Is(err, store.ErrAPIKeyLimit) {
		fail(w, 409, err.Error())
		return
	}
	if err != nil {
		handleError(w, err)
		return
	}
	respond(w, 201, apiToken{ID: key.ID, Name: key.Name, CreatedAt: key.CreatedAt, Token: token})
}
func (a *Server) deleteToken(w http.ResponseWriter, r *http.Request) {
	if !a.requireOwner(w, r) {
		return
	}
	err := a.Store.DeleteAPIKey(r.Context(), id(r))
	if errors.Is(err, sql.ErrNoRows) {
		fail(w, 404, "key not found")
		return
	}
	if err != nil {
		handleError(w, err)
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}
func (a *Server) issueSession(w http.ResponseWriter) {
	expires := time.Now().Add(7 * 24 * time.Hour)
	value := strconv.FormatInt(expires.Unix(), 10)
	http.SetCookie(w, &http.Cookie{Name: "pocketmark", Value: value + "." + a.sign(value), Path: "/", HttpOnly: true, Secure: a.secure, SameSite: http.SameSiteStrictMode, Expires: expires, MaxAge: 7 * 24 * 60 * 60})
}
