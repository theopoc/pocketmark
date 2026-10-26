package server

import (
	"net/http"
)

func (a *Server) registerSessionSecurity(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/reauth", a.reauthenticate)
	mux.HandleFunc("GET /api/sessions", a.sessions)
	mux.HandleFunc("PATCH /api/sessions/current", a.sessionTimeout)
	mux.HandleFunc("DELETE /api/sessions/others", a.revokeOtherSessions)
	mux.HandleFunc("DELETE /api/sessions/{id}", a.revokeSession)
}

func (a *Server) reauthenticate(w http.ResponseWriter, r *http.Request) {
	p := requestPrincipal(r)
	if p.session == "" {
		fail(w, 400, "a browser session is required")
		return
	}
	var body struct {
		Password string `json:"password"`
	}
	if !decode(w, r, &body, 4096) {
		return
	}
	if body.Password == "" || len(body.Password) > 1024 {
		fail(w, 400, "password required")
		return
	}
	if !a.allowLogin(r) {
		w.Header().Set("Retry-After", "60")
		fail(w, 429, "too many attempts; retry in a minute")
		return
	}
	if !a.passwordMu.TryLock() {
		w.Header().Set("Retry-After", "1")
		fail(w, 429, "authentication busy; retry shortly")
		return
	}
	defer a.passwordMu.Unlock()
	account, err := a.Store.Account(r.Context())
	if err != nil || !secretEqual(passwordHash(body.Password, account.Salt), account.Hash) {
		fail(w, 403, "Incorrect password. Try again.")
		return
	}
	if err = a.Store.ConfirmSession(r.Context(), p.session, account.Salt); err != nil {
		fail(w, 401, "session changed; sign in again")
		return
	}
	respond(w, 200, map[string]int{"validForSeconds": 300})
}

func (a *Server) sessions(w http.ResponseWriter, r *http.Request) {
	sessions, err := a.Store.Sessions(r.Context(), requestPrincipal(r).session)
	if err != nil {
		handleError(w, err)
		return
	}
	respond(w, 200, sessions)
}

func (a *Server) sessionTimeout(w http.ResponseWriter, r *http.Request) {
	hash := requestPrincipal(r).session
	if hash == "" {
		fail(w, 400, "a browser session is required")
		return
	}
	var body struct {
		Minutes *int `json:"idleTimeoutMinutes"`
	}
	if !decode(w, r, &body, 1024) {
		return
	}
	if body.Minutes == nil || (*body.Minutes != 0 && *body.Minutes != 15 && *body.Minutes != 60 && *body.Minutes != 1440) {
		fail(w, 400, "choose an inactivity timeout of 0, 15, 60 or 1440 minutes")
		return
	}
	if err := a.Store.SetSessionIdleTimeout(r.Context(), hash, *body.Minutes); err != nil {
		handleError(w, err)
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}

func (a *Server) revokeSession(w http.ResponseWriter, r *http.Request) {
	if err := a.Store.DeleteSession(r.Context(), id(r)); err != nil {
		handleError(w, err)
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}

func (a *Server) revokeOtherSessions(w http.ResponseWriter, r *http.Request) {
	hash := requestPrincipal(r).session
	if hash == "" {
		fail(w, 400, "a browser session is required")
		return
	}
	if err := a.Store.DeleteOtherSessions(r.Context(), hash); err != nil {
		handleError(w, err)
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}
