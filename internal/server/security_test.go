package server

import (
	"bufio"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"pocketmark/internal/store"
)

func TestSessionRevocationAcrossRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sessions.db")
	s, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { s.Close() }()
	a := New(s, testToken, "", false)
	requireStatus(t, request(a, "POST", "/api/setup", setupRequest, false, nil), 201)
	login := func() string {
		t.Helper()
		w := request(a, "POST", "/api/login", setupCredentials, false, nil)
		requireStatus(t, w, 200)
		return w.Result().Cookies()[0].String()
	}
	first, second := login(), login()
	if first == second {
		t.Fatal("logins must issue independent random sessions")
	}
	firstHeaders := map[string]string{"Cookie": first}
	secondHeaders := map[string]string{"Cookie": second}
	requireStatus(t, request(a, "POST", "/api/logout", "", false, firstHeaders), 200)
	requireStatus(t, request(a, "GET", "/api/account", "", false, firstHeaders), 401)
	requireStatus(t, request(a, "POST", "/api/tokens", `{"name":"replay"}`, false, firstHeaders), 401)
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	a = New(s, testToken, "", false)
	requireStatus(t, request(a, "GET", "/api/account", "", false, firstHeaders), 401)
	requireStatus(t, request(a, "GET", "/api/account", "", false, secondHeaders), 200)
	// Recovery-key rotation also invalidates cookies without storing raw secrets.
	rotated := New(s, testToken+"-rotated", "", false)
	requireStatus(t, request(rotated, "GET", "/api/account", "", false, secondHeaders), 401)
	account, err := s.Account(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	expired := "v2." + strings.Repeat("a", 64)
	if err = s.CreateSession(context.Background(), account.Salt, a.sessionHash(expired), time.Now().Add(-time.Second)); err != nil {
		t.Fatal(err)
	}
	requireStatus(t, request(a, "GET", "/api/account", "", false, map[string]string{"Cookie": "pocketmark=" + expired}), 401)
	// A correctly signed legacy cookie is rejected even with a future expiry.
	expiry := strconv.FormatInt(time.Now().Add(time.Hour).Unix(), 10)
	h := hmac.New(sha256.New, []byte(testToken))
	h.Write([]byte(expiry + account.Salt))
	legacy := expiry + "." + hex.EncodeToString(h.Sum(nil))
	requireStatus(t, request(a, "GET", "/api/account", "", false, map[string]string{"Cookie": "pocketmark=" + legacy}), 401)
	requireStatus(t, request(a, "PUT", "/api/account", setupCredentials, true, nil), 200)
	requireStatus(t, request(a, "GET", "/api/account", "", false, secondHeaders), 401)
}

func TestLoginLimitsDoNotShareAnonymousBudget(t *testing.T) {
	a := newTestServer(t, "", false)
	requireStatus(t, request(a, "PUT", "/api/account", setupCredentials, true, nil), 200)
	for range 20 {
		requireStatus(t, request(a, "POST", "/api/login", `{}`, false, nil), 400)
	}
	send := func(addr, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "http://pocketmark.test/api/login", strings.NewReader(body))
		r.RemoteAddr = addr
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		a.ServeHTTP(w, r)
		return w
	}
	for range 10 {
		requireStatus(t, send("198.51.100.1:1234", `{"username":"reader","password":"wrong"}`), 401)
	}
	requireStatus(t, send("198.51.100.1:1234", setupCredentials), 429)
	requireStatus(t, send("198.51.100.2:1234", setupCredentials), 200)
	a.passwordMu.Lock()
	w := send("198.51.100.2:1234", setupCredentials)
	a.passwordMu.Unlock()
	requireStatus(t, w, 429)
	if w.Header().Get("Retry-After") != "1" {
		t.Fatal("busy password worker must not queue callers")
	}
}

func TestLoginSourceTrustAndBounds(t *testing.T) {
	a := newTestServer(t, "", false)
	if err := a.SetTrustedProxies("10.0.0.0/24, 2001:db8:ffff::/64"); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ peer, forwarded, want string }{
		{"198.51.100.1:20", "198.51.100.2", "198.51.100.1"},
		{"10.0.0.1:20", "198.51.100.2", "198.51.100.2"},
		{"10.0.0.1:20", "192.0.2.99, 198.51.100.2, 10.0.0.2", "198.51.100.2"},
		{"10.0.0.1:20", "198.51.100.2, invalid", "10.0.0.1"},
		{"[2001:db8:1::1]:20", "", "2001:db8:1::"},
		{"[::ffff:198.51.100.1]:20", "198.51.100.2", "198.51.100.1"},
	} {
		r := httptest.NewRequest("POST", "/api/login", nil)
		r.RemoteAddr = tc.peer
		r.Header.Set("X-Forwarded-For", tc.forwarded)
		if got := a.clientSource(r).String(); got != tc.want {
			t.Errorf("source %s / %s: %s != %s", tc.peer, tc.forwarded, got, tc.want)
		}
	}
	if err := a.SetTrustedProxies("not-a-cidr"); err == nil {
		t.Fatal("invalid trust config accepted")
	}
	for i := 0; i < 300; i++ {
		r := httptest.NewRequest("POST", "/api/login", nil)
		r.RemoteAddr = fmt.Sprintf("198.51.%d.%d:20", i/256, i%256)
		if got := a.allowLogin(r); got != (i < 256) {
			t.Fatalf("source %d allowed=%v", i, got)
		}
	}
	if len(a.loginAttempts) != 256 {
		t.Fatal("unbounded limiter")
	}
}

func TestSlowLoginCannotBlockLibraryOrHealth(t *testing.T) {
	a := newTestServer(t, "", false)
	srv := httptest.NewServer(a)
	defer srv.Close()
	var connections []net.Conn
	defer func() {
		for _, conn := range connections {
			conn.Close()
		}
	}()
	for range cap(a.authRequests) {
		conn, err := net.Dial("tcp", srv.Listener.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		connections = append(connections, conn)
		// Intentionally incomplete request; never sends a complete JSON value.
		fmt.Fprintf(conn, "POST /api/login HTTP/1.1\r\nHost: pocketmark.test\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{")
	}
	deadline := time.Now().Add(2 * time.Second)
	for len(a.authRequests) != cap(a.authRequests) && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if len(a.authRequests) != cap(a.authRequests) {
		t.Fatal("slow connections did not reach handler")
	}
	requireStatus(t, request(a, "POST", "/api/login", setupCredentials, false, nil), 503)
	for _, path := range []string{"/healthz", "/livez", "/api/stats"} {
		requireStatus(t, request(a, "GET", path, "", true, nil), 200)
	}
	// Liveness and readiness are independent of library concurrency too.
	for range cap(a.requests) {
		a.requests <- struct{}{}
	}
	for _, path := range []string{"/healthz", "/livez"} {
		requireStatus(t, request(a, "GET", path, "", false, nil), 200)
	}
	for range cap(a.requests) {
		<-a.requests
	}
	for _, conn := range connections {
		conn.SetReadDeadline(time.Now().Add(7 * time.Second))
		response, err := http.ReadResponse(bufio.NewReader(conn), nil)
		if err != nil {
			t.Fatal("authentication body deadline did not produce a response:", err)
		}
		response.Body.Close()
		if response.StatusCode != 400 {
			t.Fatalf("deadline status %d", response.StatusCode)
		}
	}
	requireStatus(t, request(a, "POST", "/api/login", `{}`, false, nil), 400)
}
