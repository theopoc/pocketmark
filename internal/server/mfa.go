package server

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"image/png"
	"net/http"
	"strings"
	"time"

	"github.com/pquerna/otp"
	"github.com/pquerna/otp/hotp"
	"github.com/pquerna/otp/totp"
)

// Challenges are short-lived, bounded and process-local. They never authorize
// library access and disappear on restart. Only their keyed digests are indexed.
type mfaChallenge struct {
	kind, salt, username, secret, session string
	generation                            int64
	adminApproved, busy, recoveryGrant    bool
	expires                               time.Time
	attempts                              loginWindow
}

func publicAuthPath(path string) bool {
	return path == "/api/login" || path == "/api/setup" || path == "/api/mfa/enroll" || path == "/api/mfa/verify"
}

func (a *Server) registerMFA(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/mfa/enroll", a.mfaEnroll)
	mux.HandleFunc("POST /api/mfa/verify", a.mfaVerify)
	mux.HandleFunc("POST /api/mfa/replace", a.mfaReplace)
	mux.HandleFunc("POST /api/mfa/recovery-codes", a.mfaRecoveryCodes)
	mux.HandleFunc("POST /api/mfa/reset", a.mfaReset)
}

func (a *Server) newMFAChallenge(w http.ResponseWriter, challenge mfaChallenge) bool {
	value := randomSecret()
	now := time.Now()
	a.mfaMu.Lock()
	if a.mfaPending == nil {
		a.mfaPending = make(map[string]*mfaChallenge)
	}
	for key, item := range a.mfaPending {
		if !item.expires.After(now) {
			delete(a.mfaPending, key)
		}
	}
	if len(a.mfaPending) >= 32 {
		a.mfaMu.Unlock()
		w.Header().Set("Retry-After", "60")
		fail(w, 429, "too many sign-ins in progress; try again later")
		return false
	}
	challenge.expires = now.Add(5 * time.Minute)
	a.mfaPending[a.sessionHash(value)] = &challenge
	a.mfaMu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: "pocketmark_mfa", Value: value, Path: "/api/mfa/", HttpOnly: true, Secure: a.secure, SameSite: http.SameSiteStrictMode, MaxAge: 300})
	return true
}

func (a *Server) claimMFAChallenge(w http.ResponseWriter, r *http.Request) (string, mfaChallenge, bool) {
	cookie, err := r.Cookie("pocketmark_mfa")
	if err != nil || len(cookie.Value) != 64 {
		fail(w, 401, "sign-in expired; start again")
		return "", mfaChallenge{}, false
	}
	key := a.sessionHash(cookie.Value)
	a.mfaMu.Lock()
	defer a.mfaMu.Unlock()
	challenge, ok := a.mfaPending[key]
	if !ok || !challenge.expires.After(time.Now()) {
		delete(a.mfaPending, key)
		fail(w, 401, "sign-in expired; start again")
		return "", mfaChallenge{}, false
	}
	if challenge.busy {
		fail(w, 409, "verification is already in progress")
		return "", mfaChallenge{}, false
	}
	challenge.busy = true
	return key, *challenge, true
}

func (a *Server) releaseMFAChallenge(key string, challenge mfaChallenge, consumed bool) {
	a.mfaMu.Lock()
	defer a.mfaMu.Unlock()
	if _, ok := a.mfaPending[key]; !ok {
		return
	}
	if consumed {
		delete(a.mfaPending, key)
		return
	}
	challenge.busy = false
	a.mfaPending[key] = &challenge
}

func (a *Server) clearMFAChallenge(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: "pocketmark_mfa", Value: "", Path: "/api/mfa/", HttpOnly: true, Secure: a.secure, SameSite: http.SameSiteStrictMode, MaxAge: -1})
}

func (a *Server) clearPendingMFA(resetBudget bool) {
	a.mfaMu.Lock()
	defer a.mfaMu.Unlock()
	clear(a.mfaPending)
	if resetBudget {
		a.mfaAttempts = loginWindow{}
	}
}

func (a *Server) allowMFA(challenge *mfaChallenge) bool {
	a.mfaMu.Lock()
	defer a.mfaMu.Unlock()
	now := time.Now()
	if challenge != nil {
		if now.Sub(challenge.attempts.at) >= time.Minute {
			challenge.attempts = loginWindow{at: now}
		}
		if challenge.attempts.count >= 5 {
			return false
		}
	}
	if now.Sub(a.mfaAttempts.at) >= time.Minute {
		a.mfaAttempts = loginWindow{at: now}
	}
	if a.mfaAttempts.count >= 10 {
		return false
	}
	if challenge != nil {
		challenge.attempts.count++
	}
	a.mfaAttempts.count++
	return true
}

func (a *Server) mfaThrottle(w http.ResponseWriter, challenge *mfaChallenge) bool {
	if a.allowMFA(challenge) {
		return true
	}
	w.Header().Set("Retry-After", "60")
	fail(w, 429, "too many verification attempts; retry in a minute")
	return false
}

func (a *Server) mfaCipher() (cipher.AEAD, error) {
	key := sha256.Sum256([]byte("pocketmark/totp/v1\x00" + a.token))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func (a *Server) encryptMFA(secret string) ([]byte, error) {
	aead, err := a.mfaCipher()
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return nil, err
	}
	return aead.Seal(nonce, nonce, []byte(secret), []byte("Pocketmark TOTP v1")), nil
}

func (a *Server) decryptMFA(encrypted []byte) (string, error) {
	aead, err := a.mfaCipher()
	if err != nil || len(encrypted) < aead.NonceSize() {
		return "", errors.New("factor cannot be decrypted")
	}
	plain, err := aead.Open(nil, encrypted[:aead.NonceSize()], encrypted[aead.NonceSize():], []byte("Pocketmark TOTP v1"))
	return string(plain), err
}

func matchTOTPCounter(secret, code string, now time.Time) int64 {
	code = strings.TrimSpace(code)
	if len(code) != 6 {
		return -1
	}
	for _, r := range code {
		if r < '0' || r > '9' {
			return -1
		}
	}
	current := now.Unix() / 30
	for _, candidate := range []int64{current, current - 1, current + 1} {
		if candidate < 0 {
			continue
		}
		valid, err := hotp.ValidateCustom(code, uint64(candidate), secret, hotp.ValidateOpts{Digits: otp.DigitsSix, Algorithm: otp.AlgorithmSHA1})
		if err == nil && valid {
			return candidate
		}
	}
	return -1
}

func recoveryDigest(code string) string {
	code = strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(code), "-", ""))
	if len(code) != 32 {
		return ""
	}
	if _, err := hex.DecodeString(code); err != nil {
		return ""
	}
	sum := sha256.Sum256([]byte("pocketmark/recovery/v1\x00" + code))
	return hex.EncodeToString(sum[:])
}

func newRecoveryCodes() ([]string, []string) {
	codes, hashes := make([]string, 0, 10), make([]string, 0, 10)
	for range 10 {
		raw := strings.ToUpper(randomSecret()[:32])
		code := raw[:8] + "-" + raw[8:16] + "-" + raw[16:24] + "-" + raw[24:]
		codes = append(codes, code)
		hashes = append(hashes, recoveryDigest(code))
	}
	return codes, hashes
}

func enrollmentImage(username, secret string) (string, string, error) {
	var bytesSecret []byte
	var err error
	if secret != "" {
		bytesSecret, err = base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(secret)
		if err != nil {
			return "", "", err
		}
	}
	key, err := totp.Generate(totp.GenerateOpts{Issuer: "Pocketmark", AccountName: username, Secret: bytesSecret, SecretSize: 20, Period: 30})
	if err != nil {
		return "", "", err
	}
	img, err := key.Image(220, 220)
	if err != nil {
		return "", "", err
	}
	var buf bytes.Buffer
	if err = png.Encode(&buf, img); err != nil {
		return "", "", err
	}
	return key.Secret(), "data:image/png;base64," + base64.StdEncoding.EncodeToString(buf.Bytes()), nil
}

func (a *Server) mfaEnroll(w http.ResponseWriter, r *http.Request) {
	var body struct {
		SetupToken string `json:"setupToken"`
	}
	if !decode(w, r, &body, 4096) {
		return
	}
	key, challenge, ok := a.claimMFAChallenge(w, r)
	if !ok {
		return
	}
	defer func() { a.releaseMFAChallenge(key, challenge, false) }()
	if !a.mfaThrottle(w, &challenge) {
		return
	}
	if challenge.kind != "enroll" {
		fail(w, 403, "enrollment is unavailable")
		return
	}
	account, err := a.Store.Account(r.Context())
	state, stateErr := a.Store.MFA(r.Context())
	if err != nil || stateErr != nil || account.Salt != challenge.salt || state.Generation != challenge.generation || len(state.Secret) != 0 {
		fail(w, 401, "account changed; sign in again")
		return
	}
	if !challenge.adminApproved && !secretEqual(body.SetupToken, a.token) {
		fail(w, 403, "administrator setup key required")
		return
	}
	secret, qr, err := enrollmentImage(challenge.username, challenge.secret)
	if err != nil {
		fail(w, 503, "could not prepare authentication; try again")
		return
	}
	challenge.secret, challenge.adminApproved = secret, true
	respond(w, 200, map[string]string{"secret": secret, "qr": qr})
}

func (a *Server) mfaVerify(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Code string `json:"code"`
	}
	if !decode(w, r, &body, 1024) {
		return
	}
	key, challenge, ok := a.claimMFAChallenge(w, r)
	if !ok {
		return
	}
	consumed := false
	defer func() { a.releaseMFAChallenge(key, challenge, consumed) }()
	if !a.mfaThrottle(w, &challenge) {
		return
	}
	expires := time.Now().Add(7 * 24 * time.Hour)
	value := "v3." + randomSecret()
	if challenge.kind == "enroll" || challenge.kind == "replace" {
		if challenge.secret == "" || !challenge.adminApproved {
			fail(w, 403, "start enrollment first")
			return
		}
		if challenge.kind == "replace" {
			cookie, err := r.Cookie("pocketmark")
			if err != nil || a.sessionHash(cookie.Value) != challenge.session || !a.Store.SessionValid(r.Context(), challenge.session) {
				fail(w, 401, "session changed; sign in again")
				return
			}
		}
		counter := matchTOTPCounter(challenge.secret, body.Code, a.totpNow())
		if counter < 0 {
			fail(w, 401, "invalid authentication code")
			return
		}
		encrypted, err := a.encryptMFA(challenge.secret)
		if err != nil {
			fail(w, 503, "could not save authentication")
			return
		}
		codes, hashes := newRecoveryCodes()
		if err = a.Store.ActivateMFA(r.Context(), challenge.salt, challenge.generation, counter, encrypted, hashes, challenge.session, a.sessionHash(value), expires, r.UserAgent(), challenge.recoveryGrant); err != nil {
			fail(w, 409, "account changed; start again")
			return
		}
		consumed = true
		if challenge.session == "" {
			a.setSessionCookie(w, value, expires)
		}
		a.clearMFAChallenge(w)
		respond(w, 200, map[string]any{"authenticated": true, "recoveryCodes": codes})
		return
	}
	if challenge.kind != "verify" {
		fail(w, 401, "sign-in expired; start again")
		return
	}
	state, err := a.Store.MFA(r.Context())
	if err != nil || state.Generation != challenge.generation || len(state.Secret) == 0 {
		fail(w, 401, "account changed; sign in again")
		return
	}
	recoveryHash := recoveryDigest(body.Code)
	counter := int64(-1)
	if recoveryHash == "" {
		secret, err := a.decryptMFA(state.Secret)
		if err != nil {
			fail(w, 401, "authentication unavailable; use a recovery code or administrator reset")
			return
		}
		counter = matchTOTPCounter(secret, body.Code, a.totpNow())
		if counter < 0 {
			fail(w, 401, "invalid authentication code")
			return
		}
	}
	if err = a.Store.SignInMFA(r.Context(), challenge.salt, challenge.generation, counter, recoveryHash, a.sessionHash(value), expires, r.UserAgent()); err != nil {
		fail(w, 401, "invalid or already used authentication code")
		return
	}
	consumed = true
	a.setSessionCookie(w, value, expires)
	a.clearMFAChallenge(w)
	respond(w, 200, map[string]bool{"authenticated": true, "usedRecoveryCode": recoveryHash != ""})
}

// authorizeMFAChange requires a browser session, current password and either a
// fresh factor or the one-time grant from a recent recovery-code sign-in.
func (a *Server) authorizeMFAChange(w http.ResponseWriter, r *http.Request, allowRecoveryGrant bool) (string, int64, bool, bool) {
	if requestPrincipal(r).session == "" {
		fail(w, 403, "a browser session is required")
		return "", 0, false, false
	}
	var body struct{ Password, Code string }
	if !decode(w, r, &body, 4096) || !a.mfaThrottle(w, nil) {
		return "", 0, false, false
	}
	if body.Password == "" || len(body.Password) > 1024 {
		fail(w, 400, "password required")
		return "", 0, false, false
	}
	if body.Code == "" && !allowRecoveryGrant {
		fail(w, 403, "authentication or recovery code required")
		return "", 0, false, false
	}
	if !a.passwordMu.TryLock() {
		w.Header().Set("Retry-After", "1")
		fail(w, 429, "authentication busy; retry shortly")
		return "", 0, false, false
	}
	defer a.passwordMu.Unlock()
	account, err := a.Store.Account(r.Context())
	state, stateErr := a.Store.MFA(r.Context())
	if err != nil || stateErr != nil || !secretEqual(passwordHash(body.Password, account.Salt), account.Hash) || len(state.Secret) == 0 {
		fail(w, 403, "incorrect password or authentication unavailable")
		return "", 0, false, false
	}
	recoveryHash := recoveryDigest(body.Code)
	counter := int64(-1)
	if body.Code != "" && recoveryHash == "" {
		secret, err := a.decryptMFA(state.Secret)
		if err == nil {
			counter = matchTOTPCounter(secret, body.Code, a.totpNow())
		}
		if counter < 0 {
			fail(w, 403, "invalid authentication code")
			return "", 0, false, false
		}
	}
	if err = a.Store.AuthorizeMFAChange(r.Context(), account.Salt, state.Generation, counter, recoveryHash, requestPrincipal(r).session); err != nil {
		fail(w, 403, "invalid or already used authentication code")
		return "", 0, false, false
	}
	return account.Salt, state.Generation, body.Code == "", true
}

func (a *Server) mfaReplace(w http.ResponseWriter, r *http.Request) {
	salt, generation, recoveryGrant, ok := a.authorizeMFAChange(w, r, true)
	if !ok {
		return
	}
	account, err := a.Store.Account(r.Context())
	if err != nil || account.Salt != salt {
		fail(w, 409, "account changed; start again")
		return
	}
	secret, qr, err := enrollmentImage(account.Username, "")
	if err != nil {
		fail(w, 503, "could not prepare authentication; try again")
		return
	}
	if !a.newMFAChallenge(w, mfaChallenge{kind: "replace", salt: salt, username: account.Username, secret: secret, session: requestPrincipal(r).session, generation: generation, adminApproved: true, recoveryGrant: recoveryGrant}) {
		return
	}
	respond(w, 200, map[string]string{"secret": secret, "qr": qr})
}

func (a *Server) mfaRecoveryCodes(w http.ResponseWriter, r *http.Request) {
	salt, generation, _, ok := a.authorizeMFAChange(w, r, false)
	if !ok {
		return
	}
	codes, hashes := newRecoveryCodes()
	if err := a.Store.ReplaceRecoveryCodes(r.Context(), salt, generation, requestPrincipal(r).session, hashes); err != nil {
		fail(w, 409, "account changed; try again")
		return
	}
	respond(w, 200, map[string]any{"recoveryCodes": codes})
}

func (a *Server) mfaReset(w http.ResponseWriter, r *http.Request) {
	if requestPrincipal(r).session != "" || !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") || !secretEqual(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), a.token) {
		fail(w, 403, "administrator recovery key required")
		return
	}
	if err := a.Store.ResetMFA(r.Context()); err != nil {
		fail(w, 503, "could not reset authentication")
		return
	}
	a.clearPendingMFA(true)
	respond(w, 200, map[string]bool{"ok": true})
}
