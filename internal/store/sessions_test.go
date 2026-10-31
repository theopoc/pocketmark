package store

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"
	"time"
)

func TestSessionsUpgradeBoundsAndCredentialChange(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	account := Account{Username: "owner", Salt: "old-salt", Hash: "password-hash"}
	if err = s.SaveAccount(ctx, account); err != nil {
		t.Fatal(err)
	}
	id := createLink(t, s, Link{URL: "https://example.test/kept", Title: "Keep me"})
	key, err := s.CreateAPIKey(ctx, "kept-key", "key-hash")
	if err != nil {
		t.Fatal(err)
	}
	// Simulate a database from before the session migration.
	if _, err = s.db.Exec("DROP TABLE sessions"); err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { s.Close() }()
	got, err := s.Account(ctx)
	if err != nil || got != account {
		t.Fatalf("account upgrade: %+v %v", got, err)
	}
	if link, err := s.Get(ctx, id); err != nil || link.Title != "Keep me" {
		t.Fatalf("library upgrade: %+v %v", link, err)
	}
	if !s.HasAPIKeyHash(ctx, "key-hash") {
		t.Fatal("upgrade lost API key")
	}
	expires := time.Now().Add(time.Hour)
	for i := 0; i < 34; i++ {
		if err = s.CreateSession(ctx, account.Salt, fmt.Sprint(i), expires); err != nil {
			t.Fatal(err)
		}
	}
	var count int
	if err = s.db.QueryRow("SELECT count(*) FROM sessions").Scan(&count); err != nil || count != 32 {
		t.Fatalf("session bound: %d %v", count, err)
	}
	if s.SessionValid(ctx, "0") || s.SessionValid(ctx, "1") || !s.SessionValid(ctx, "2") || !s.SessionValid(ctx, "33") {
		t.Fatal("oldest session eviction failed")
	}
	if err = s.RevokeSession(ctx, "33"); err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if s.SessionValid(ctx, "33") || !s.SessionValid(ctx, "2") {
		t.Fatal("restart lost session state")
	}
	account.Salt = "new-salt"
	if err = s.SaveAccount(ctx, account); err != nil {
		t.Fatal(err)
	}
	if s.SessionValid(ctx, "2") {
		t.Fatal("password change retained sessions")
	}
	if err = s.CreateSession(ctx, "old-salt", "stale-login", expires); err == nil {
		t.Fatal("stale login accepted after password change")
	}
	if err = s.CreateSession(ctx, account.Salt, "expired", time.Now().Add(-time.Second)); err != nil {
		t.Fatal(err)
	}
	if s.SessionValid(ctx, "expired") {
		t.Fatal("expired session accepted")
	}
	if err = s.CreateSession(ctx, account.Salt, "current", expires); err != nil {
		t.Fatal(err)
	}
	if err = s.db.QueryRow("SELECT count(*) FROM sessions").Scan(&count); err != nil || count != 1 {
		t.Fatalf("expired cleanup: %d %v", count, err)
	}
	keys, err := s.APIKeys(ctx)
	if err != nil || len(keys) != 1 || keys[0].ID != key.ID {
		t.Fatal("credential change lost API key")
	}
}
