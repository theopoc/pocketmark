package store

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSecurityMigrationAndRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err = s.SaveAccount(ctx, Account{Username: "owner", Salt: "salt", Hash: "digest"}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Create(ctx, Link{URL: "https://example.test", Title: "preserved"}); err != nil {
		t.Fatal(err)
	}
	// Reproduce the schema before profiles, expiration and session metadata.
	_, err = s.db.Exec(`DROP TABLE api_tokens; CREATE TABLE api_tokens(id INTEGER PRIMARY KEY,name TEXT NOT NULL,hash TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,last_used_at TEXT NOT NULL DEFAULT '');
 INSERT INTO api_tokens VALUES(1,'legacy','old-key','2026-01-01',1,'');
 DROP TABLE sessions; CREATE TABLE sessions(id INTEGER PRIMARY KEY AUTOINCREMENT,hash TEXT NOT NULL UNIQUE,expires_at INTEGER NOT NULL);
 INSERT INTO sessions(hash,expires_at) VALUES('old-cookie',unixepoch()+3600);`)
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { s.Close() }()
	keys, err := s.APIKeys(ctx)
	if err != nil || len(keys) != 1 || keys[0].Profile != "full" || keys[0].ExpiresAt != 0 {
		t.Fatalf("migration: %+v %v", keys, err)
	}
	if !s.SessionValid(ctx, "old-cookie") || s.SessionConfirmed(ctx, "old-cookie") {
		t.Fatal("legacy session must remain valid but require confirmation")
	}
	sessions, err := s.Sessions(ctx, "old-cookie")
	if err != nil || len(sessions) != 1 || !sessions[0].Current || sessions[0].IdleTimeoutMinutes != 0 {
		t.Fatalf("sessions: %+v %v", sessions, err)
	}
	if err = s.ConfirmSession(ctx, "old-cookie", "salt"); err != nil {
		t.Fatal(err)
	}
	if err = s.SetSessionIdleTimeout(ctx, "old-cookie", 60); err != nil {
		t.Fatal(err)
	}
	// Set last activity as a real successful request would.
	if _, err = s.db.Exec("UPDATE sessions SET last_used_at=unixepoch()"); err != nil {
		t.Fatal(err)
	}
	if err = s.CreateSession(ctx, "salt", "second-cookie", time.Now().Add(time.Hour), strings.Repeat("a", 1000)); err != nil {
		t.Fatal(err)
	}
	if err = s.DeleteOtherSessions(ctx, "old-cookie"); err != nil {
		t.Fatal(err)
	}
	if err = s.RotateAPIKey(ctx, 1, "new-key"); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if s.SessionValid(ctx, "second-cookie") || !s.SessionValid(ctx, "old-cookie") || !s.SessionConfirmed(ctx, "old-cookie") {
		t.Fatal("session state lost across restart")
	}
	if s.AuthenticateAPIKey(ctx, "old-key") || !s.AuthenticateAPIKey(ctx, "new-key") {
		t.Fatal("rotation lost across restart")
	}
	l, err := s.Get(ctx, 1)
	if err != nil || l.Title != "preserved" {
		t.Fatal("migration lost library")
	}
}

func TestSessionExpiryConfirmationAndIdle(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	if err := s.SaveAccount(ctx, Account{Username: "owner", Salt: "salt", Hash: "digest"}); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateSession(ctx, "salt", "session", time.Now().Add(time.Hour), strings.Repeat("a", 1000)); err != nil {
		t.Fatal(err)
	}
	sessions, err := s.Sessions(ctx, "session")
	if err != nil || len(sessions) != 1 || len(sessions[0].Device) != 256 {
		t.Fatalf("bounded metadata: %+v %v", sessions, err)
	}
	if !s.SessionConfirmed(ctx, "session") {
		t.Fatal("fresh password login should be confirmed")
	}
	if _, err = s.db.Exec("UPDATE sessions SET confirmed_at=unixepoch()-300"); err != nil {
		t.Fatal(err)
	}
	if s.SessionConfirmed(ctx, "session") {
		t.Fatal("confirmation expiry not enforced")
	}
	if err = s.ConfirmSession(ctx, "session", "wrong-salt"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("stale credentials confirmed session")
	}
	if err = s.SetSessionIdleTimeout(ctx, "session", 15); err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.Exec("UPDATE sessions SET last_used_at=unixepoch()-900"); err != nil {
		t.Fatal(err)
	}
	if s.TouchSession(ctx, "session") || s.SessionValid(ctx, "session") {
		t.Fatal("idle session revived")
	}
	if err = s.ConfirmSession(ctx, "session", "salt"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("idle session confirmed")
	}
	if err = s.CreateSession(ctx, "salt", "absolute", time.Now().Add(-time.Second)); err != nil {
		t.Fatal(err)
	}
	if s.TouchSession(ctx, "absolute") {
		t.Fatal("absolute expiry bypass")
	}
}

func TestScopedKeyExpiryAndRotation(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	key, err := s.CreateScopedAPIKey(ctx, "capture", "original", "capture", time.Now().Add(time.Hour).Unix())
	if err != nil {
		t.Fatal(err)
	}
	if profile, err := s.AuthenticateAPIKeyProfile(ctx, "original"); err != nil || profile != "capture" {
		t.Fatalf("profile: %s %v", profile, err)
	}
	if err = s.RotateAPIKey(ctx, key.ID, "rotated"); err != nil {
		t.Fatal(err)
	}
	if s.AuthenticateAPIKey(ctx, "original") {
		t.Fatal("old key accepted")
	}
	keys, err := s.APIKeys(ctx)
	if err != nil || keys[0].Profile != key.Profile || keys[0].ExpiresAt != key.ExpiresAt || keys[0].LastUsedAt != "" {
		t.Fatal("rotation changed policy")
	}
	if _, err = s.db.Exec("UPDATE api_tokens SET expires_at=unixepoch()"); err != nil {
		t.Fatal(err)
	}
	if s.AuthenticateAPIKey(ctx, "rotated") || s.HasAPIKeyHash(ctx, "rotated") {
		t.Fatal("expired key accepted")
	}
	if err = s.RotateAPIKey(ctx, key.ID, "again"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("expired key rotated")
	}
}
