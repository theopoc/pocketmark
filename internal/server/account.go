package server

import (
	"context"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
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

// ResetLocalAccount is intended for an operator with access to the stopped
// server's data directory. Existing MFA remains enabled and sessions are revoked.
func ResetLocalAccount(ctx context.Context, s *store.Store, username, password string) error {
	username = strings.TrimSpace(username)
	if username == "" || len(username) > 120 || len(password) < 12 || len(password) > 1024 {
		return errors.New("choose a username and a password of 12–1024 bytes")
	}
	salt := randomSecret()
	return s.SaveAccount(ctx, store.Account{Username: username, Salt: salt, Hash: passwordHash(password, salt)})
}
func (a *Server) registerAccount(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/setup", a.setupStatus)
	mux.HandleFunc("POST /api/setup", a.setup)
	mux.HandleFunc("GET /api/account", a.account)
	mux.HandleFunc("PUT /api/account", a.setAccount)
	mux.HandleFunc("GET /api/tokens", a.tokens)
	mux.HandleFunc("POST /api/tokens", a.createToken)
	mux.HandleFunc("PATCH /api/tokens/{id}", a.updateToken)
	mux.HandleFunc("DELETE /api/tokens/{id}", a.deleteToken)
	mux.HandleFunc("POST /api/tokens/{id}/rotate", a.rotateToken)
}
func (a *Server) owner(r *http.Request) bool { return requestPrincipal(r).owner }
func (a *Server) requireOwner(w http.ResponseWriter, r *http.Request) bool {
	if !a.owner(r) {
		fail(w, 403, "account settings require the owner session")
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
	if !a.allowLogin(r) {
		w.Header().Set("Retry-After", "60")
		fail(w, 429, "too many setup attempts; retry in a minute")
		return
	}
	state, err := a.Store.SetupStatus(r.Context())
	if err != nil {
		handleError(w, err)
		return
	}
	if !state.SetupRequired {
		fail(w, 409, "account creation is unavailable")
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
	mfaState, err := a.Store.MFA(r.Context())
	if err != nil {
		fail(w, 503, "authentication unavailable; sign in again")
		return
	}
	if !a.newMFAChallenge(w, mfaChallenge{kind: "enroll", salt: salt, username: b.Username, generation: mfaState.Generation}) {
		return
	}
	respond(w, 201, map[string]bool{"mfaRequired": true, "enrollmentRequired": true})
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
	account := store.Account{Username: b.Username, Salt: salt, Hash: hash}
	value := "v3." + randomSecret()
	expires, err := a.Store.SaveAccountFromSession(r.Context(), account, requestPrincipal(r).session, a.sessionHash(value), r.UserAgent())
	if err != nil {
		fail(w, 401, "session changed; sign in again")
		return
	}
	a.clearPendingMFA(false)
	a.setSessionCookie(w, value, expires)
	respond(w, 200, map[string]bool{"ok": true})
}

type apiToken struct {
	store.APIKey
	Token string `json:"token,omitempty"`
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
		Name      string `json:"name"`
		Profile   string `json:"profile"`
		ExpiresAt int64  `json:"expiresAt"`
	}
	if !decode(w, r, &b, 4096) {
		return
	}
	b.Name = strings.TrimSpace(b.Name)
	if b.Name == "" || len(b.Name) > 120 {
		fail(w, 400, "name must contain 1–120 bytes")
		return
	}
	if b.Profile == "" {
		b.Profile = "read"
	}
	if b.Profile != "read" && b.Profile != "capture" && b.Profile != "sync" && b.Profile != "full" {
		fail(w, 400, "choose read, capture, sync or full permissions")
		return
	}
	if b.ExpiresAt < 0 || (b.ExpiresAt != 0 && b.ExpiresAt <= time.Now().Unix()) {
		fail(w, 400, "expiry must be a future Unix timestamp or zero")
		return
	}
	token := randomSecret()
	sum := sha256.Sum256([]byte(token))
	key, err := a.Store.CreateScopedAPIKey(r.Context(), b.Name, hex.EncodeToString(sum[:]), b.Profile, b.ExpiresAt)
	if errors.Is(err, store.ErrAPIKeyLimit) {
		fail(w, 409, err.Error())
		return
	}
	if err != nil {
		handleError(w, err)
		return
	}
	respond(w, 201, apiToken{APIKey: key, Token: token})
}
func (a *Server) updateToken(w http.ResponseWriter, r *http.Request) {
	if !a.requireOwner(w, r) {
		return
	}
	var b struct {
		Active *bool   `json:"active"`
		Name   *string `json:"name"`
	}
	if !decode(w, r, &b, 4096) {
		return
	}
	if b.Active == nil && b.Name == nil {
		fail(w, 400, "provide a name or an active boolean")
		return
	}
	if b.Name != nil {
		*b.Name = strings.TrimSpace(*b.Name)
		if *b.Name == "" || len(*b.Name) > 120 {
			fail(w, 400, "name must contain 1–120 bytes")
			return
		}
	}
	err := a.Store.UpdateAPIKey(r.Context(), id(r), b.Name, b.Active)
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
func (a *Server) setSessionCookie(w http.ResponseWriter, value string, expires time.Time) {
	maxAge := int(time.Until(expires).Seconds())
	if maxAge < 1 {
		maxAge = -1
	}
	http.SetCookie(w, &http.Cookie{Name: "pocketmark", Value: value, Path: "/", HttpOnly: true, Secure: a.secure, SameSite: http.SameSiteStrictMode, Expires: expires, MaxAge: maxAge})
}

func (a *Server) rotateToken(w http.ResponseWriter, r *http.Request) {
	token := randomSecret()
	sum := sha256.Sum256([]byte(token))
	err := a.Store.RotateAPIKey(r.Context(), id(r), hex.EncodeToString(sum[:]))
	if errors.Is(err, sql.ErrNoRows) {
		fail(w, 404, "active, unexpired key not found")
		return
	}
	if err != nil {
		handleError(w, err)
		return
	}
	respond(w, 200, map[string]string{"token": token})
}
