package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pquerna/otp/totp"

	"pocketmark/internal/store"
)

func responseCookie(t *testing.T, w *httptest.ResponseRecorder, name string) string {
	t.Helper()
	for _, cookie := range w.Result().Cookies() {
		if cookie.Name == name {
			return cookie.Name + "=" + cookie.Value
		}
	}
	t.Fatalf("missing %s cookie", name)
	return ""
}

func TestMFARejectsPasswordOnlySessionAfterRollbackAndRestart(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "rollback.db")
	s, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	a := New(s, testToken, "", false)
	verified := responseCookie(t, passwordLogin(t, a), "pocketmark")
	account, err := s.Account(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// The older binary inserts the digest of a v2 cookie after password-only login.
	legacy := "v2." + randomSecret()
	if err = s.CreateSession(ctx, account.Salt, a.sessionHash(legacy), time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	a = New(s, testToken, "", false)
	if !s.SessionValid(ctx, a.sessionHash(legacy)) {
		t.Fatal("test did not preserve the rollback session")
	}
	requireStatus(t, request(a, "GET", "/api/session", "", false, map[string]string{"Cookie": "pocketmark=" + legacy}), 401)
	requireStatus(t, request(a, "GET", "/api/session", "", false, map[string]string{"Cookie": "pocketmark=v3." + strings.TrimPrefix(legacy, "v2.")}), 401)
	requireStatus(t, request(a, "GET", "/api/session", "", false, map[string]string{"Cookie": verified}), 200)
}

func TestMFAChallengeLimitsDoNotBlockAdministratorReset(t *testing.T) {
	a := newTestServer(t, "", false)
	setup := request(a, "POST", "/api/setup", setupRequest, false, nil)
	_, _, codes, _, _ := enrollForTest(t, a, pendingCookie(t, setup), "")
	first := pendingCookie(t, request(a, "POST", "/api/login", setupCredentials, false, nil))
	second := pendingCookie(t, request(a, "POST", "/api/login", setupCredentials, false, nil))
	for range 5 {
		requireStatus(t, request(a, "POST", "/api/mfa/verify", `{"code":"invalid"}`, false, map[string]string{"Cookie": first}), 401)
	}
	requireStatus(t, request(a, "POST", "/api/mfa/verify", `{"code":"invalid"}`, false, map[string]string{"Cookie": first}), 429)
	requireStatus(t, request(a, "POST", "/api/mfa/verify", `{"code":"`+codes[0]+`"}`, false, map[string]string{"Cookie": second}), 200)
	// Exhaust the shared anti-bruteforce budget independently of the reset.
	for a.allowMFA(nil) {
	}
	third := pendingCookie(t, request(a, "POST", "/api/login", setupCredentials, false, nil))
	requireStatus(t, request(a, "POST", "/api/mfa/verify", `{"code":"`+codes[1]+`"}`, false, map[string]string{"Cookie": third}), 429)
	requireStatus(t, request(a, "POST", "/api/mfa/reset", "", true, nil), 200)
}

func TestMFAResetClearsPendingChallengesAndVerificationBudget(t *testing.T) {
	a := newTestServer(t, "", false)
	setup := request(a, "POST", "/api/setup", setupRequest, false, nil)
	_, _, _, _, _ = enrollForTest(t, a, pendingCookie(t, setup), "")
	for range 32 {
		if !a.newMFAChallenge(httptest.NewRecorder(), mfaChallenge{kind: "verify"}) {
			t.Fatal("failed to fill challenge capacity")
		}
	}
	if a.newMFAChallenge(httptest.NewRecorder(), mfaChallenge{kind: "verify"}) {
		t.Fatal("challenge capacity exceeded")
	}
	for a.allowMFA(nil) {
	}
	requireStatus(t, request(a, "POST", "/api/mfa/reset", "", true, nil), 200)
	login := request(a, "POST", "/api/login", setupCredentials, false, nil)
	requireStatus(t, login, 200)
	session, _, _, _, _ := enrollForTest(t, a, pendingCookie(t, login), testToken)
	requireStatus(t, request(a, "GET", "/api/session", "", false, map[string]string{"Cookie": session}), 200)
}

func pendingCookie(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	for _, cookie := range w.Result().Cookies() {
		if cookie.Name == "pocketmark" {
			t.Fatal("password-only step issued a full session")
		}
	}
	return responseCookie(t, w, "pocketmark_mfa")
}

func enrollForTest(t *testing.T, a *Server, pending string, setupKey string) (string, string, []string, *httptest.ResponseRecorder, string) {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"setupToken": setupKey})
	w := request(a, "POST", "/api/mfa/enroll", string(body), false, map[string]string{"Cookie": pending})
	requireStatus(t, w, 200)
	var enrollment struct{ Secret, QR string }
	if err := json.Unmarshal(w.Body.Bytes(), &enrollment); err != nil || enrollment.Secret == "" || !strings.HasPrefix(enrollment.QR, "data:image/png;base64,") {
		t.Fatal("invalid enrollment response", err)
	}
	code, err := totp.GenerateCode(enrollment.Secret, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	w = request(a, "POST", "/api/mfa/verify", `{"code":"`+code+`"}`, false, map[string]string{"Cookie": pending})
	requireStatus(t, w, 200)
	var result struct{ RecoveryCodes []string }
	if err = json.Unmarshal(w.Body.Bytes(), &result); err != nil || len(result.RecoveryCodes) != 10 {
		t.Fatal("missing recovery codes", err)
	}
	return responseCookie(t, w, "pocketmark"), enrollment.Secret, result.RecoveryCodes, w, code
}

func TestMFAEnrollmentReplayRecoveryAndReset(t *testing.T) {
	a := newTestServer(t, "", true)
	setup := request(a, "POST", "/api/setup", setupRequest, false, nil)
	requireStatus(t, setup, 201)
	pending := pendingCookie(t, setup)
	requireStatus(t, request(a, "GET", "/api/session", "", false, map[string]string{"Cookie": pending}), 401)
	session, secret, codes, _, code := enrollForTest(t, a, pending, "")
	requireStatus(t, request(a, "GET", "/api/session", "", false, map[string]string{"Cookie": session}), 200)
	state, err := a.Store.MFA(t.Context())
	if err != nil || bytes.Contains(state.Secret, []byte(secret)) {
		t.Fatal("TOTP secret was not encrypted", err)
	}
	login := request(a, "POST", "/api/login", setupCredentials, false, nil)
	requireStatus(t, login, 200)
	pending = pendingCookie(t, login)
	requireStatus(t, request(a, "POST", "/api/mfa/verify", `{"code":"`+code+`"}`, false, map[string]string{"Cookie": pending}), 401)
	w := request(a, "POST", "/api/mfa/verify", `{"code":"`+codes[0]+`"}`, false, map[string]string{"Cookie": pending})
	requireStatus(t, w, 200)
	recoverySession := responseCookie(t, w, "pocketmark")
	login = request(a, "POST", "/api/login", setupCredentials, false, nil)
	pending = pendingCookie(t, login)
	requireStatus(t, request(a, "POST", "/api/mfa/verify", `{"code":"`+codes[0]+`"}`, false, map[string]string{"Cookie": pending}), 401)
	// The just-used recovery code grants one replacement after password proof.
	w = request(a, "POST", "/api/mfa/replace", `{"password":"a good personal password","code":""}`, false, map[string]string{"Cookie": recoverySession})
	requireStatus(t, w, 200)
	var replacement struct{ Secret string }
	if err = json.Unmarshal(w.Body.Bytes(), &replacement); err != nil {
		t.Fatal(err)
	}
	newCode, _ := totp.GenerateCode(replacement.Secret, time.Now())
	verifyCookie := recoverySession + "; " + responseCookie(t, w, "pocketmark_mfa")
	w = request(a, "POST", "/api/mfa/verify", `{"code":"`+newCode+`"}`, false, map[string]string{"Cookie": verifyCookie})
	requireStatus(t, w, 200)
	requireStatus(t, request(a, "GET", "/api/session", "", false, map[string]string{"Cookie": session}), 401)
	requireStatus(t, request(a, "GET", "/api/session", "", false, map[string]string{"Cookie": recoverySession}), 200)
	// Advance the limiter window without sleeping during this multi-flow test.
	a.loginMu.Lock()
	for source, window := range a.loginAttempts {
		window.at = time.Now().Add(-time.Minute)
		a.loginAttempts[source] = window
	}
	a.loginMu.Unlock()
	a.mfaMu.Lock()
	a.mfaAttempts.at = time.Now().Add(-time.Minute)
	a.mfaMu.Unlock()
	reset := request(a, "POST", "/api/mfa/reset", "", true, nil)
	requireStatus(t, reset, 200)
	for _, cookie := range reset.Result().Cookies() {
		if cookie.Name == "pocketmark" {
			t.Fatal("administrator reset issued a browser session")
		}
	}
	requireStatus(t, request(a, "GET", "/api/session", "", false, map[string]string{"Cookie": recoverySession}), 401)
	login = request(a, "POST", "/api/login", setupCredentials, false, nil)
	pending = pendingCookie(t, login)
	requireStatus(t, request(a, "POST", "/api/mfa/enroll", `{"setupToken":"wrong"}`, false, map[string]string{"Cookie": pending}), 403)
}

func TestMFALegacyEnrollmentRequiresAdministrator(t *testing.T) {
	a := newTestServer(t, "", false)
	changed := request(a, "PUT", "/api/account", setupCredentials, true, nil)
	requireStatus(t, changed, 200)
	for _, cookie := range changed.Result().Cookies() {
		if cookie.Name == "pocketmark" {
			t.Fatal("administrator credential change issued a full session")
		}
	}
	login := request(a, "POST", "/api/login", setupCredentials, false, nil)
	pending := pendingCookie(t, login)
	requireStatus(t, request(a, "POST", "/api/mfa/enroll", `{"setupToken":"wrong"}`, false, map[string]string{"Cookie": pending}), 403)
	session, _, _, _, _ := enrollForTest(t, a, pending, testToken)
	requireStatus(t, request(a, "GET", "/api/account", "", false, map[string]string{"Cookie": session}), 200)
	// A password-only browser cannot turn its pending cookie into API access.
	requireStatus(t, request(a, "GET", "/api/account", "", false, map[string]string{"Cookie": pending}), http.StatusUnauthorized)
}

func TestMFARecoveryCodeIsAtomicAcrossConcurrentLogins(t *testing.T) {
	a := newTestServer(t, "", false)
	setup := request(a, "POST", "/api/setup", setupRequest, false, nil)
	_, _, codes, _, _ := enrollForTest(t, a, pendingCookie(t, setup), "")
	first := pendingCookie(t, request(a, "POST", "/api/login", setupCredentials, false, nil))
	second := pendingCookie(t, request(a, "POST", "/api/login", setupCredentials, false, nil))
	var wg sync.WaitGroup
	statuses := make(chan int, 2)
	for _, cookie := range []string{first, second} {
		wg.Add(1)
		go func(cookie string) {
			defer wg.Done()
			statuses <- request(a, "POST", "/api/mfa/verify", `{"code":"`+codes[0]+`"}`, false, map[string]string{"Cookie": cookie}).Code
		}(cookie)
	}
	wg.Wait()
	close(statuses)
	counts := map[int]int{}
	for status := range statuses {
		counts[status]++
	}
	if counts[200] != 1 || counts[401] != 1 {
		t.Fatalf("recovery code used more than once: %v", counts)
	}
}

func TestMFARecoveryGrantOnlyAllowsAuthenticatorReplacement(t *testing.T) {
	a, db := securityServer(t)
	setup := request(a, "POST", "/api/setup", setupRequest, false, nil)
	_, _, codes, _, _ := enrollForTest(t, a, pendingCookie(t, setup), "")
	login := request(a, "POST", "/api/login", setupCredentials, false, nil)
	verify := request(a, "POST", "/api/mfa/verify", `{"code":"`+codes[0]+`"}`, false, map[string]string{"Cookie": pendingCookie(t, login)})
	requireStatus(t, verify, 200)
	session := responseCookie(t, verify, "pocketmark")
	var originalUntil int64
	if err := db.QueryRow("SELECT recovery_until FROM sessions WHERE hash=?", a.sessionHash(strings.TrimPrefix(session, "pocketmark="))).Scan(&originalUntil); err != nil {
		t.Fatal(err)
	}
	body := `{"password":"a good personal password","code":""}`
	requireStatus(t, request(a, "POST", "/api/mfa/recovery-codes", body, false, map[string]string{"Cookie": session}), 403)
	// Changing credentials keeps the remaining recovery grant on the new session.
	changed := request(a, "PUT", "/api/account", setupCredentials, false, map[string]string{"Cookie": session})
	requireStatus(t, changed, 200)
	session = responseCookie(t, changed, "pocketmark")
	var retainedUntil int64
	if err := db.QueryRow("SELECT recovery_until FROM sessions WHERE hash=?", a.sessionHash(strings.TrimPrefix(session, "pocketmark="))).Scan(&retainedUntil); err != nil || retainedUntil != originalUntil {
		t.Fatal("account change altered the recovery grant deadline", err)
	}
	// A full challenge queue must not consume the grant before retrying.
	for range 32 {
		if !a.newMFAChallenge(httptest.NewRecorder(), mfaChallenge{kind: "verify"}) {
			t.Fatal("failed to fill challenge capacity")
		}
	}
	requireStatus(t, request(a, "POST", "/api/mfa/replace", body, false, map[string]string{"Cookie": session}), 429)
	a.clearPendingMFA(false)
	// An abandoned replacement can be retried without another recovery code.
	first := request(a, "POST", "/api/mfa/replace", body, false, map[string]string{"Cookie": session})
	requireStatus(t, first, 200)
	second := request(a, "POST", "/api/mfa/replace", body, false, map[string]string{"Cookie": session})
	requireStatus(t, second, 200)
	var firstEnrollment, secondEnrollment struct{ Secret string }
	if err := json.Unmarshal(first.Body.Bytes(), &firstEnrollment); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(second.Body.Bytes(), &secondEnrollment); err != nil {
		t.Fatal(err)
	}
	newCode, _ := totp.GenerateCode(secondEnrollment.Secret, time.Now())
	secondCookie := session + "; " + responseCookie(t, second, "pocketmark_mfa")
	oldCode, _ := totp.GenerateCode(firstEnrollment.Secret, time.Now())
	firstCookie := session + "; " + responseCookie(t, first, "pocketmark_mfa")
	// Concurrent confirmations can install only one of the proposed factors.
	var wg sync.WaitGroup
	statuses := make(chan int, 2)
	for _, proof := range []struct{ cookie, code string }{{firstCookie, oldCode}, {secondCookie, newCode}} {
		wg.Add(1)
		go func(proof struct{ cookie, code string }) {
			defer wg.Done()
			statuses <- request(a, "POST", "/api/mfa/verify", `{"code":"`+proof.code+`"}`, false, map[string]string{"Cookie": proof.cookie}).Code
		}(proof)
	}
	wg.Wait()
	close(statuses)
	counts := map[int]int{}
	for status := range statuses {
		counts[status]++
	}
	if counts[200] != 1 || counts[409] != 1 {
		t.Fatalf("concurrent replacements: %v", counts)
	}
	requireStatus(t, request(a, "POST", "/api/mfa/replace", body, false, map[string]string{"Cookie": session}), 403)
}

func TestMFARecoveryGrantMustStillBeValidAtConfirmation(t *testing.T) {
	a, db := securityServer(t)
	setup := request(a, "POST", "/api/setup", setupRequest, false, nil)
	_, _, codes, _, _ := enrollForTest(t, a, pendingCookie(t, setup), "")
	login := request(a, "POST", "/api/login", setupCredentials, false, nil)
	verify := request(a, "POST", "/api/mfa/verify", `{"code":"`+codes[0]+`"}`, false, map[string]string{"Cookie": pendingCookie(t, login)})
	session := responseCookie(t, verify, "pocketmark")
	replacement := request(a, "POST", "/api/mfa/replace", `{"password":"a good personal password","code":""}`, false, map[string]string{"Cookie": session})
	requireStatus(t, replacement, 200)
	var enrollment struct{ Secret string }
	if err := json.Unmarshal(replacement.Body.Bytes(), &enrollment); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("UPDATE sessions SET recovery_until=unixepoch()-1 WHERE hash=?", a.sessionHash(strings.TrimPrefix(session, "pocketmark="))); err != nil {
		t.Fatal(err)
	}
	before, err := a.Store.MFA(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	code, _ := totp.GenerateCode(enrollment.Secret, time.Now())
	cookie := session + "; " + responseCookie(t, replacement, "pocketmark_mfa")
	requireStatus(t, request(a, "POST", "/api/mfa/verify", `{"code":"`+code+`"}`, false, map[string]string{"Cookie": cookie}), 409)
	after, err := a.Store.MFA(t.Context())
	if err != nil || after.Generation != before.Generation || !bytes.Equal(after.Secret, before.Secret) {
		t.Fatal("expired recovery grant changed the authenticator", err)
	}
}

func TestMFAPendingChallengeRejectsCrossOriginAndCredentialChanges(t *testing.T) {
	a := newTestServer(t, "", false)
	setup := request(a, "POST", "/api/setup", setupRequest, false, nil)
	pending := pendingCookie(t, setup)
	requireStatus(t, request(a, "POST", "/api/mfa/enroll", `{}`, false, map[string]string{"Cookie": pending, "Origin": "https://attacker.test"}), 403)
	w := request(a, "POST", "/api/mfa/enroll", `{}`, false, map[string]string{"Cookie": pending})
	requireStatus(t, w, 200)
	var enrollment struct{ Secret string }
	if err := json.Unmarshal(w.Body.Bytes(), &enrollment); err != nil {
		t.Fatal(err)
	}
	code, _ := totp.GenerateCode(enrollment.Secret, time.Now())
	requireStatus(t, request(a, "PUT", "/api/account", `{"username":"reader","password":"changed personal password"}`, true, nil), 200)
	requireStatus(t, request(a, "POST", "/api/mfa/verify", `{"code":"`+code+`"}`, false, map[string]string{"Cookie": pending}), 401)
	requireStatus(t, request(a, "GET", "/api/session", "", false, map[string]string{"Cookie": pending}), 401)
}

func TestMFARotatedAdministratorKeyCanRecoverWithBackupCode(t *testing.T) {
	a := newTestServer(t, "", false)
	setup := request(a, "POST", "/api/setup", setupRequest, false, nil)
	_, secret, codes, _, _ := enrollForTest(t, a, pendingCookie(t, setup), "")
	rotated := New(a.Store, testToken+"-rotated", "", false)
	login := request(rotated, "POST", "/api/login", setupCredentials, false, nil)
	pending := pendingCookie(t, login)
	code, _ := totp.GenerateCode(secret, time.Now().Add(30*time.Second))
	requireStatus(t, request(rotated, "POST", "/api/mfa/verify", `{"code":"`+code+`"}`, false, map[string]string{"Cookie": pending}), 401)
	w := request(rotated, "POST", "/api/mfa/verify", `{"code":"`+codes[0]+`"}`, false, map[string]string{"Cookie": pending})
	requireStatus(t, w, 200)
	session := responseCookie(t, w, "pocketmark")
	requireStatus(t, request(rotated, "POST", "/api/mfa/reset", "", false, map[string]string{"Cookie": session}), 403)
	// The old administrator key no longer grants reset access after rotation.
	requireStatus(t, request(rotated, "POST", "/api/mfa/reset", "", true, nil), 401)
}
