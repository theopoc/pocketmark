package server

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base32"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"image/png"
	"net/http"
	"pocketmark/internal/fault"
	"pocketmark/internal/observability"
	"pocketmark/internal/store"
	"strings"
	"time"

	"github.com/pquerna/otp"
	"github.com/pquerna/otp/hotp"
	"github.com/pquerna/otp/totp"
)

func publicAuthPath(path string) bool {
	return path == "/api/login" || path == "/api/setup" || path == "/api/mfa/enroll" || path == "/api/mfa/verify"
}

func (a *Server) registerMFA(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/mfa/enroll", a.mfaEnroll)
	mux.HandleFunc("POST /api/mfa/verify", a.mfaVerify)
	mux.HandleFunc("POST /api/mfa/replace", a.mfaReplace)
	mux.HandleFunc("POST /api/mfa/recovery-codes", a.mfaRecoveryCodes)
}

func (a *Server) newMFAChallenge(ctx context.Context, w http.ResponseWriter, challenge store.MFAChallenge) bool {
	value := randomSecret()
	if err := a.Store.CreateMFAChallenge(ctx, a.sessionHash(value), challenge); err != nil {
		if errors.Is(err, store.ErrMFALimit) {
			w.Header().Set("Retry-After", "60")
			fail(w, 429, "too many sign-ins in progress; try again later")
		} else {
			authFailure(w, "mfa_challenge_create_failed", err)
		}
		return false
	}
	http.SetCookie(w, &http.Cookie{Name: "pocketmark_mfa", Value: value, Path: "/api/mfa/", HttpOnly: true, Secure: a.secure, SameSite: http.SameSiteStrictMode, MaxAge: 300})
	return true
}

func (a *Server) mfaAttempt(w http.ResponseWriter, r *http.Request, key string) (store.MFAChallenge, bool) {
	c, err := a.Store.ReserveMFAAttempt(r.Context(), key)
	switch {
	case err == nil:
		return c, true
	case errors.Is(err, sql.ErrNoRows):
		fail(w, 401, "sign-in expired; start again")
	case errors.Is(err, store.ErrMFALimit):
		w.Header().Set("Retry-After", "60")
		fail(w, 429, "too many verification attempts; retry in a minute")
	default:
		authFailure(w, "mfa_attempt_failed", err)
	}
	return c, false
}

func (a *Server) claimMFAChallenge(w http.ResponseWriter, r *http.Request) (string, store.MFAChallenge, bool) {
	cookie, err := r.Cookie("pocketmark_mfa")
	if err != nil || len(cookie.Value) != 64 {
		fail(w, 401, "sign-in expired; start again")
		return "", store.MFAChallenge{}, false
	}
	key := a.sessionHash(cookie.Value)
	c, ok := a.mfaAttempt(w, r, key)
	return key, c, ok
}

func (a *Server) clearMFAChallenge(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: "pocketmark_mfa", Value: "", Path: "/api/mfa/", HttpOnly: true, Secure: a.secure, SameSite: http.SameSiteStrictMode, MaxAge: -1})
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
	var body struct{}
	if !decode(w, r, &body, 4096) {
		return
	}
	key, challenge, ok := a.claimMFAChallenge(w, r)
	if !ok {
		return
	}
	if challenge.Kind != "enroll" {
		fail(w, 403, "enrollment is unavailable")
		return
	}
	account, err := a.Store.Account(r.Context())
	state, stateErr := a.Store.MFA(r.Context())
	if authFailure(w, "mfa_state_failed", stateErr) {
		return
	}
	if err != nil || stateErr != nil || account.Salt != challenge.Salt || state.Generation != challenge.Generation || len(state.Secret) != 0 {
		if authFailure(w, "mfa_operation_failed", err) {
			return
		}
		fail(w, 401, "account changed; sign in again")
		return
	}
	if len(challenge.Secret) == 0 {
		var seed [20]byte
		if _, err = rand.Read(seed[:]); err != nil {
			authFailure(w, "mfa_seed_failed", err)
			return
		}
		candidate, err := a.encryptMFA(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(seed[:]))
		if authFailure(w, "mfa_encrypt_failed", err) {
			return
		}
		challenge.Secret, err = a.Store.EnrollmentSecret(r.Context(), key, candidate)
		if errors.Is(err, sql.ErrNoRows) {
			fail(w, 401, "sign-in expired; start again")
			return
		}
		if authFailure(w, "mfa_enrollment_failed", err) {
			return
		}
	}
	seed, err := a.decryptMFA(challenge.Secret)
	if authFailure(w, "mfa_decrypt_failed", err) {
		return
	}
	secret, qr, err := enrollmentImage(challenge.Username, seed)
	if err != nil {
		if authFailure(w, "mfa_operation_failed", err) {
			return
		}
		fail(w, 503, "could not prepare authentication; try again")
		return
	}
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
	expires := time.Now().Add(7 * 24 * time.Hour)
	value := "v3." + randomSecret()
	if challenge.Kind == "enroll" || challenge.Kind == "replace" {
		if len(challenge.Secret) == 0 {
			fail(w, 403, "start enrollment first")
			return
		}
		if challenge.Kind == "replace" {
			cookie, err := r.Cookie("pocketmark")
			if err != nil || a.sessionHash(cookie.Value) != challenge.Session {
				fail(w, 401, "session changed; sign in again")
				return
			}
			valid, err := a.Store.CheckAndTouchSession(r.Context(), challenge.Session)
			if authFailure(w, "mfa_session_failed", err) {
				return
			}
			if !valid {
				fail(w, 401, "session changed; sign in again")
				return
			}
		}
		seed, err := a.decryptMFA(challenge.Secret)
		if authFailure(w, "mfa_decrypt_failed", err) {
			return
		}
		counter := matchTOTPCounter(seed, body.Code, a.totpNow())
		if counter < 0 {
			fail(w, 401, "invalid authentication code")
			return
		}
		codes, hashes := newRecoveryCodes()
		if err = a.Store.ActivateMFA(r.Context(), key, challenge.Salt, challenge.Generation, counter, challenge.Secret, hashes, challenge.Session, a.sessionHash(value), expires, r.UserAgent(), challenge.RecoveryGrant); err != nil {
			if authFailure(w, "mfa_operation_failed", err) {
				return
			}
			fail(w, 409, "account changed; start again")
			return
		}
		if challenge.Session == "" {
			a.setSessionCookie(w, value, expires)
		}
		a.clearMFAChallenge(w)
		respond(w, 200, map[string]any{"authenticated": true, "recoveryCodes": codes})
		return
	}
	if challenge.Kind != "verify" {
		fail(w, 401, "sign-in expired; start again")
		return
	}
	state, err := a.Store.MFA(r.Context())
	if err != nil || state.Generation != challenge.Generation || len(state.Secret) == 0 {
		if authFailure(w, "mfa_operation_failed", err) {
			return
		}
		fail(w, 401, "account changed; sign in again")
		return
	}
	recoveryHash := recoveryDigest(body.Code)
	counter := int64(-1)
	if recoveryHash == "" {
		secret, err := a.decryptMFA(state.Secret)
		if err != nil {
			observability.Error(r.Context(), "mfa_decrypt_failed", fault.Wrap("mfa.decrypt", err))
			respond(w, 503, map[string]string{"error": "authentication unavailable; use a recovery code or local MFA reset", "code": "mfa_recovery_required"})
			return
		}
		counter = matchTOTPCounter(secret, body.Code, a.totpNow())
		if counter < 0 {
			fail(w, 401, "invalid authentication code")
			return
		}
	}
	if err = a.Store.SignInMFA(r.Context(), key, challenge.Salt, challenge.Generation, counter, recoveryHash, a.sessionHash(value), expires, r.UserAgent()); err != nil {
		if authFailure(w, "mfa_operation_failed", err) {
			return
		}
		fail(w, 401, "invalid or already used authentication code")
		return
	}
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
	if !decode(w, r, &body, 4096) {
		return "", 0, false, false
	}
	if _, ok := a.mfaAttempt(w, r, ""); !ok {
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
	if authFailure(w, "mfa_state_failed", stateErr) {
		return "", 0, false, false
	}
	if err != nil || stateErr != nil || !secretEqual(passwordHash(body.Password, account.Salt), account.Hash) || len(state.Secret) == 0 {
		if authFailure(w, "mfa_operation_failed", err) {
			return "", 0, false, false
		}
		fail(w, 403, "incorrect password or authentication unavailable")
		return "", 0, false, false
	}
	recoveryHash := recoveryDigest(body.Code)
	counter := int64(-1)
	if body.Code != "" && recoveryHash == "" {
		secret, err := a.decryptMFA(state.Secret)
		if authFailure(w, "mfa_decrypt_failed", err) {
			return "", 0, false, false
		}
		if err == nil {
			counter = matchTOTPCounter(secret, body.Code, a.totpNow())
		}
		if counter < 0 {
			fail(w, 403, "invalid authentication code")
			return "", 0, false, false
		}
	}
	if err = a.Store.AuthorizeMFAChange(r.Context(), account.Salt, state.Generation, counter, recoveryHash, requestPrincipal(r).session); err != nil {
		if authFailure(w, "mfa_operation_failed", err) {
			return "", 0, false, false
		}
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
		if authFailure(w, "mfa_operation_failed", err) {
			return
		}
		fail(w, 409, "account changed; start again")
		return
	}
	secret, qr, err := enrollmentImage(account.Username, "")
	if err != nil {
		if authFailure(w, "mfa_operation_failed", err) {
			return
		}
		fail(w, 503, "could not prepare authentication; try again")
		return
	}
	encrypted, err := a.encryptMFA(secret)
	if authFailure(w, "mfa_encrypt_failed", err) {
		return
	}
	if !a.newMFAChallenge(r.Context(), w, store.MFAChallenge{Kind: "replace", Salt: salt, Username: account.Username, Secret: encrypted, Session: requestPrincipal(r).session, Generation: generation, RecoveryGrant: recoveryGrant}) {
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
		if authFailure(w, "mfa_recovery_save_failed", err) {
			return
		}
		fail(w, 409, "account changed; try again")
		return
	}
	respond(w, 200, map[string]any{"recoveryCodes": codes})
}
