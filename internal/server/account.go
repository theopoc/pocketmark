package server

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
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
	// Persist eligibility before creating account tables, so an upgrade never
	// makes an existing installation anonymously claimable.
	if _, err := a.Store.DB.Exec(`CREATE TABLE IF NOT EXISTS account_setup(id INTEGER PRIMARY KEY CHECK(id=1), allowed INTEGER NOT NULL);
 INSERT INTO account_setup(id,allowed) SELECT 1,
 NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('account','api_tokens'))
 AND NOT EXISTS(SELECT 1 FROM links) AND NOT EXISTS(SELECT 1 FROM collections)
 WHERE NOT EXISTS(SELECT 1 FROM account_setup);
 CREATE TABLE IF NOT EXISTS account(id INTEGER PRIMARY KEY CHECK(id=1),username TEXT NOT NULL,salt TEXT NOT NULL,hash TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS api_tokens(id INTEGER PRIMARY KEY,name TEXT NOT NULL,hash TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL);`); err != nil {
		panic(err)
	}
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
	var username, hash string
	_ = a.Store.DB.QueryRowContext(r.Context(), "SELECT username,hash FROM account WHERE id=1").Scan(&username, &hash)
	respond(w, 200, map[string]any{"username": username, "passwordEnabled": hash != ""})
}

func (a *Server) setupStatus(w http.ResponseWriter, r *http.Request) {
	var allowed, passwordEnabled bool
	err := a.Store.DB.QueryRowContext(r.Context(), `SELECT
 EXISTS(SELECT 1 FROM account_setup WHERE allowed=1) AND NOT EXISTS(SELECT 1 FROM account)
 AND NOT EXISTS(SELECT 1 FROM links) AND NOT EXISTS(SELECT 1 FROM collections) AND NOT EXISTS(SELECT 1 FROM api_tokens),
 EXISTS(SELECT 1 FROM account WHERE hash!='')`).Scan(&allowed, &passwordEnabled)
	if err != nil {
		handleError(w, err)
		return
	}
	respond(w, 200, map[string]bool{"setupRequired": allowed, "passwordEnabled": passwordEnabled})
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
	// One conditional write also protects against another server creating the
	// owner concurrently. Never overwrite an account, even a disabled legacy one.
	result, err := a.Store.DB.ExecContext(r.Context(), `INSERT INTO account(id,username,salt,hash)
 SELECT 1,?,?,? WHERE EXISTS(SELECT 1 FROM account_setup WHERE allowed=1)
 AND NOT EXISTS(SELECT 1 FROM account) AND NOT EXISTS(SELECT 1 FROM links)
 AND NOT EXISTS(SELECT 1 FROM collections) AND NOT EXISTS(SELECT 1 FROM api_tokens)`, b.Username, salt, passwordHash(b.Password, salt))
	if err != nil {
		handleError(w, err)
		return
	}
	n, err := result.RowsAffected()
	if err != nil {
		handleError(w, err)
		return
	}
	if n != 1 {
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
	if _, err := a.Store.DB.ExecContext(r.Context(), "INSERT INTO account(id,username,salt,hash) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username,salt=excluded.salt,hash=excluded.hash", b.Username, salt, hash); err != nil {
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
	var user, salt, hash string
	if a.Store.DB.QueryRowContext(r.Context(), "SELECT username,salt,hash FROM account WHERE id=1").Scan(&user, &salt, &hash) != nil || hash == "" {
		return false
	}
	got := passwordHash(password, salt)
	return secretEqual(username, user) && secretEqual(got, hash)
}
func (a *Server) validAPIKey(r *http.Request, key string) bool {
	if len(key) != 64 {
		return false
	}
	sum := sha256.Sum256([]byte(key))
	var one int
	return a.Store.DB.QueryRowContext(r.Context(), "SELECT 1 FROM api_tokens WHERE hash=?", hex.EncodeToString(sum[:])).Scan(&one) == nil
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
	rows, e := a.Store.DB.QueryContext(r.Context(), "SELECT id,name,created_at FROM api_tokens ORDER BY id")
	if e != nil {
		handleError(w, e)
		return
	}
	defer rows.Close()
	out := []apiToken{}
	for rows.Next() {
		var t apiToken
		if e = rows.Scan(&t.ID, &t.Name, &t.CreatedAt); e != nil {
			handleError(w, e)
			return
		}
		out = append(out, t)
	}
	if e = rows.Err(); e != nil {
		handleError(w, e)
		return
	}
	respond(w, 200, out)
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
	now := time.Now().UTC().Format(time.RFC3339Nano)
	res, e := a.Store.DB.ExecContext(r.Context(), "INSERT INTO api_tokens(name,hash,created_at) SELECT ?,?,? WHERE (SELECT COUNT(*) FROM api_tokens)<32", b.Name, hex.EncodeToString(sum[:]), now)
	if e != nil {
		handleError(w, e)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		fail(w, 409, "at most 32 API keys")
		return
	}
	id, _ := res.LastInsertId()
	respond(w, 201, apiToken{id, b.Name, now, token})
}
func (a *Server) deleteToken(w http.ResponseWriter, r *http.Request) {
	if !a.requireOwner(w, r) {
		return
	}
	res, e := a.Store.DB.ExecContext(r.Context(), "DELETE FROM api_tokens WHERE id=?", id(r))
	if e != nil {
		handleError(w, e)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		fail(w, 404, "key not found")
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}
func (a *Server) issueSession(w http.ResponseWriter) {
	expires := time.Now().Add(7 * 24 * time.Hour)
	value := strconv.FormatInt(expires.Unix(), 10)
	http.SetCookie(w, &http.Cookie{Name: "pocketmark", Value: value + "." + a.sign(value), Path: "/", HttpOnly: true, Secure: a.secure, SameSite: http.SameSiteStrictMode, Expires: expires, MaxAge: 7 * 24 * 60 * 60})
}
