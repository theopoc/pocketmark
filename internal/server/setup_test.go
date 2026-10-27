package server

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"pocketmark/internal/store"
)

const setupRequest = `{"username":"reader","password":"a good personal password","setupToken":"` + testToken + `"}`

const setupCredentials = `{"username":"reader","password":"a good personal password"}`

func TestSetupOnceAcrossRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "setup.db")
	s, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	a := New(s, testToken, "", false)
	requireSetup(t, a, true, false)
	// Eligibility persists even if the process restarts before setup.
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	a = New(s, testToken, "", false)
	requireSetup(t, a, true, false)
	requireStatus(t, request(a, "POST", "/api/setup", setupRequest, false, map[string]string{"Origin": "https://attacker.test"}), 403)
	requireStatus(t, request(a, "POST", "/api/setup", setupRequest, false, map[string]string{"Origin": "chrome-extension://attacker", "Sec-Fetch-Site": "cross-site"}), 403)
	requireStatus(t, request(a, "POST", "/api/setup", `{"username":"reader","password":"short"}`, false, nil), 400)
	// Missing or guessed setup keys cannot claim a fresh instance.
	requireStatus(t, request(a, "POST", "/api/setup", setupCredentials, false, nil), 403)
	requireStatus(t, request(a, "POST", "/api/setup", strings.Replace(setupRequest, testToken, "wrong-key", 1), false, nil), 403)
	requireSetup(t, a, true, false)
	w := request(a, "POST", "/api/setup", setupRequest, false, nil)
	requireStatus(t, w, 201)
	cookie, _, _, _, _ := enrollForTest(t, a, pendingCookie(t, w), "")
	requireStatus(t, request(a, "GET", "/api/account", "", false, map[string]string{"Cookie": cookie}), 200)
	requireSetup(t, a, false, true)
	a = New(s, testToken, "", false)
	requireSetup(t, a, false, true)
	requireStatus(t, request(a, "POST", "/api/setup", setupRequest, false, nil), 409)
	requireStatus(t, request(a, "POST", "/api/login", `{"token":"`+testToken+`"}`, false, nil), 400)
	requireStatus(t, request(a, "POST", "/api/login", setupCredentials, false, nil), 200)
	requireStatus(t, request(a, "PUT", "/api/account", `{"username":"reader","password":""}`, true, nil), 400)
}

func requireSetup(t *testing.T, a *Server, required, enabled bool) {
	t.Helper()
	w := request(a, "GET", "/api/setup", "", false, nil)
	requireStatus(t, w, 200)
	var got struct{ SetupRequired, PasswordEnabled bool }
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.SetupRequired != required || got.PasswordEnabled != enabled {
		t.Fatalf("unexpected setup state: %s", w.Body.String())
	}
}

func TestLegacySetupCannotClaimLibrary(t *testing.T) {
	for _, password := range []string{"", "legacy personal password"} {
		t.Run(password, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "legacy.db")
			s, err := store.Open(path)
			if err != nil {
				t.Fatal(err)
			}
			if err = s.Close(); err != nil {
				t.Fatal(err)
			}
			legacy, err := sql.Open("pocketmark-sqlite3", path)
			if err != nil {
				t.Fatal(err)
			}
			defer legacy.Close()
			// Reproduce the old account schema without the persisted setup decision.
			_, err = legacy.Exec(`DROP TABLE account_setup; DROP TABLE account; DROP TABLE api_tokens; CREATE TABLE account(id INTEGER PRIMARY KEY CHECK(id=1),username TEXT NOT NULL,salt TEXT NOT NULL,hash TEXT NOT NULL);
 CREATE TABLE api_tokens(id INTEGER PRIMARY KEY,name TEXT NOT NULL,hash TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL);`)
			if err != nil {
				t.Fatal(err)
			}
			if password != "" {
				_, err = legacy.Exec("INSERT INTO account VALUES(1,?,?,?)", "legacy", "salt", passwordHash(password, "salt"))
				if err != nil {
					t.Fatal(err)
				}
			}
			key := strings.Repeat("a", 64)
			digest := sha256.Sum256([]byte(key))
			if _, err := legacy.Exec("INSERT INTO api_tokens VALUES(1,'legacy client',?,'2026-01-01')", hex.EncodeToString(digest[:])); err != nil {
				t.Fatal(err)
			}
			if err = legacy.Close(); err != nil {
				t.Fatal(err)
			}
			s, err = store.Open(path)
			if err != nil {
				t.Fatal(err)
			}
			id, err := s.Create(context.Background(), store.Link{URL: "https://example.org/keep", Notes: "keep private"})
			if err != nil {
				t.Fatal(err)
			}
			if err := s.Close(); err != nil {
				t.Fatal(err)
			}
			s, err = store.Open(path)
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			a := New(s, testToken, "", false)
			requireSetup(t, a, false, password != "")
			requireStatus(t, request(a, "GET", "/api/links", "", false, map[string]string{"Authorization": "Bearer " + key}), 200)
			requireStatus(t, request(a, "POST", "/api/setup", setupRequest, false, map[string]string{"Authorization": "Bearer " + key}), 409)
			if password != "" {
				requireStatus(t, request(a, "POST", "/api/login", `{"username":"legacy","password":"legacy personal password"}`, false, nil), 200)
			}

			requireStatus(t, request(a, "POST", "/api/setup", setupRequest, false, nil), 409)
			requireStatus(t, request(a, "POST", "/api/login", `{"token":"`+testToken+`"}`, false, nil), 400)
			// The existing administrative API supports migration/recovery, without
			// issuing a browser session from the master token login endpoint.
			requireStatus(t, request(a, "PUT", "/api/account", setupCredentials, true, nil), 200)
			a = New(s, testToken, "", false)
			requireSetup(t, a, false, true)
			requireStatus(t, request(a, "POST", "/api/login", setupCredentials, false, nil), 200)
			link, err := s.Get(context.Background(), id)
			if err != nil || link.Notes != "keep private" {
				t.Fatalf("legacy library changed: %+v %v", link, err)
			}
		})
	}
}

func TestConcurrentSetupHasOneOwner(t *testing.T) {
	a := newTestServer(t, "", false)
	// Two handlers simulate separate processes sharing one database.
	b := New(a.Store, testToken, "", false)
	var wg sync.WaitGroup
	statuses := make(chan int, 2)
	for _, server := range []*Server{a, b} {
		wg.Add(1)
		go func(a *Server) {
			defer wg.Done()
			statuses <- request(a, "POST", "/api/setup", setupRequest, false, nil).Code
		}(server)
	}
	wg.Wait()
	close(statuses)
	counts := map[int]int{}
	for status := range statuses {
		counts[status]++
	}
	if counts[201] != 1 || counts[409] != 1 {
		t.Fatalf("setup race: %v", counts)
	}
}
