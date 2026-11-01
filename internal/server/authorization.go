package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
)

// Every registered API route has an explicit policy. New routes do not inherit
// integration permissions. HEAD uses the GET policy returned by ServeMux.
type routeAccess struct {
	profiles       string
	owner, confirm bool
}

var apiAccess = map[string]routeAccess{
	"GET /api/session":                                  {profiles: "read capture sync full"},
	"POST /api/logout":                                  {owner: true},
	"GET /api/account":                                  {owner: true},
	"PUT /api/account":                                  {owner: true, confirm: true},
	"GET /api/tokens":                                   {owner: true},
	"POST /api/tokens":                                  {owner: true},
	"PATCH /api/tokens/{id}":                            {owner: true, confirm: true},
	"DELETE /api/tokens/{id}":                           {owner: true, confirm: true},
	"POST /api/tokens/{id}/rotate":                      {owner: true, confirm: true},
	"POST /api/reauth":                                  {owner: true},
	"POST /api/mfa/replace":                             {owner: true},
	"POST /api/mfa/recovery-codes":                      {owner: true},
	"GET /api/sessions":                                 {owner: true},
	"PATCH /api/sessions/current":                       {owner: true, confirm: true},
	"DELETE /api/sessions/others":                       {owner: true, confirm: true},
	"DELETE /api/sessions/{id}":                         {owner: true, confirm: true},
	"GET /api/backup":                                   {owner: true, confirm: true},
	"GET /metrics":                                      {profiles: "read full"},
	"GET /api/stats":                                    {profiles: "read capture full"},
	"GET /api/tags":                                     {profiles: "read capture full"},
	"GET /api/tags/browse":                              {profiles: "read capture full"},
	"GET /api/collections":                              {profiles: "read capture full"},
	"POST /api/collections":                             {profiles: "capture full"},
	"PUT /api/collections/{id}":                         {profiles: "full"},
	"DELETE /api/collections/{id}":                      {profiles: "full"},
	"GET /api/links":                                    {profiles: "read capture full"},
	"POST /api/links":                                   {profiles: "capture full"},
	"GET /api/links/{id}":                               {profiles: "read capture full"},
	"PUT /api/links/{id}":                               {profiles: "capture full"},
	"DELETE /api/links/{id}":                            {profiles: "full"},
	"POST /api/links/bulk":                              {profiles: "full"},
	"POST /api/links/{id}/capture":                      {profiles: "capture full"},
	"GET /api/links/{id}/archive":                       {profiles: "read full"},
	"GET /api/links/{id}/favicon":                       {profiles: "read capture full"},
	"GET /api/links/{id}/thumbnail":                     {profiles: "read capture full"},
	"GET /api/links/{id}/assets":                        {profiles: "read capture full"},
	"POST /api/links/{id}/assets":                       {profiles: "capture full"},
	"GET /api/assets/{assetId}":                         {profiles: "read full"},
	"GET /api/assets/{assetId}/view":                    {profiles: "read full"},
	"DELETE /api/assets/{assetId}":                      {profiles: "full"},
	"POST /api/links/{id}/preserve":                     {profiles: "capture full"},
	"GET /api/links/{id}/reader":                        {profiles: "read full"},
	"GET /api/links/{id}/annotations":                   {profiles: "read full"},
	"POST /api/links/{id}/annotations":                  {profiles: "full"},
	"PUT /api/links/{id}/annotations/{annotationId}":    {profiles: "full"},
	"DELETE /api/links/{id}/annotations/{annotationId}": {profiles: "full"},
	"POST /api/files":                                   {profiles: "capture full"},
	"POST /api/import":                                  {profiles: "full"},
	"POST /api/import/html":                             {profiles: "full"},
	"GET /api/export":                                   {profiles: "read full"},
	"GET /api/export/html":                              {profiles: "read full"},
}

type principal struct {
	owner            bool
	profile, session string
}
type principalContextKey struct{}

func requestPrincipal(r *http.Request) principal {
	p, _ := r.Context().Value(principalContextKey{}).(principal)
	return p
}

func (a *Server) authenticate(r *http.Request, dav bool) (principal, bool) {
	auth := r.Header.Get("Authorization")
	if auth != "" {
		key := ""
		if strings.HasPrefix(auth, "Bearer ") {
			key = strings.TrimPrefix(auth, "Bearer ")
		} else if dav {
			_, password, ok := r.BasicAuth()
			if ok {
				key = password
			}
		}
		if key == "" {
			return principal{}, false
		}
		if len(key) != 64 {
			return principal{}, false
		}
		sum := sha256.Sum256([]byte(key))
		profile, err := a.Store.AuthenticateAPIKeyProfile(r.Context(), hex.EncodeToString(sum[:]))
		return principal{profile: profile}, err == nil
	}
	cookie, err := r.Cookie("pocketmark")
	// Versions before mandatory MFA issued v2 cookies after password-only login.
	// The keyed digest covers the prefix, so changing it cannot upgrade a cookie.
	if err != nil || len(cookie.Value) != 67 || !strings.HasPrefix(cookie.Value, "v3.") {
		return principal{}, false
	}
	hash := a.sessionHash(cookie.Value)
	return principal{owner: true, session: hash}, a.Store.TouchSession(r.Context(), hash)
}

func (a *Server) authorize(w http.ResponseWriter, r *http.Request) bool {
	dav := strings.HasPrefix(r.URL.Path, "/dav/")
	if !dav && !strings.HasPrefix(r.URL.Path, "/api/") && r.URL.Path != "/metrics" {
		return true
	}
	if publicAuthPath(r.URL.Path) {
		return true
	}
	p, ok := a.authenticate(r, dav)
	if !ok {
		if dav {
			w.Header().Set("WWW-Authenticate", `Basic realm="Pocketmark", charset="UTF-8"`)
		}
		fail(w, 401, "sign in required")
		return false
	}
	*r = *r.WithContext(context.WithValue(r.Context(), principalContextKey{}, p))
	_, pattern := a.mux.Handler(r)
	policy, known := apiAccess[pattern]
	if dav {
		policy, known = routeAccess{profiles: "sync full"}, true
	}
	if !p.owner && (!known || policy.owner || !containsProfile(policy.profiles, p.profile)) {
		fail(w, 403, "API key does not permit this operation")
		return false
	}
	// Sensitive actions require recent password knowledge from the owner.
	if policy.confirm && p.session != "" && !a.Store.SessionConfirmed(r.Context(), p.session) {
		respond(w, 403, map[string]string{"error": "Confirm your password to continue.", "code": "reauth_required"})
		return false
	}
	return true
}

func containsProfile(profiles, profile string) bool {
	for _, allowed := range strings.Fields(profiles) {
		if allowed == profile {
			return true
		}
	}
	return false
}
