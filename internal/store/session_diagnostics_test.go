package store

import (
	"context"
	"database/sql"
	"net/netip"
	"path/filepath"
	"testing"
	"time"

	"pocketmark/internal/pgtest"
)

func TestSessionDiagnosticsAfterRestart(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "restart.db")
	s, err := openTestStore(t, path)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SaveAccount(ctx, Account{Username: "fixture", Salt: "fixture", Hash: "fixture"}); err != nil {
		t.Fatal(err)
	}
	client := SessionClient{UserAgent: "test browser", Address: netip.MustParseAddr("2001:db8:1::27")}
	if err := signInSession(ctx, s, "fixture", "test-session", time.Now().Add(time.Hour), client); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = openTestStore(t, path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	current, err := s.Sessions(ctx, "test-session")
	if err != nil || len(current) != 1 || current[0].IPAddress != "2001:db8:1::27" || !current[0].Current {
		t.Fatalf("session address after restart: %+v (%v)", current, err)
	}
	if valid, err := s.CheckAndTouchSession(ctx, "test-session"); !valid || err != nil {
		t.Fatalf("persisted session: %v %v", valid, err)
	}
	if valid, err := s.CheckAndTouchSession(ctx, "missing"); valid || err != nil {
		t.Fatalf("missing session: %v %v", valid, err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CheckAndTouchSession(ctx, "test-session"); err == nil {
		t.Fatal("storage failure became invalid credentials")
	}
	if _, err := s.CheckSessionConfirmed(ctx, "test-session"); err == nil {
		t.Fatal("storage failure became unconfirmed session")
	}
}

func TestSchemaTwoSessionsKeepUnknownAddressAfterUpgrade(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "schema-two.db")
	db, err := sql.Open("pgx", pgtest.URL(t, path))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(initialSchema + challengeSchema + `
CREATE TABLE pocketmark_migrations(version integer PRIMARY KEY);
INSERT INTO pocketmark_migrations VALUES(1),(2);
INSERT INTO sessions(hash,expires_at,device) VALUES('previous-session',epoch_seconds()+3600,'legacy browser');`); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		s, err := openTestStore(t, path)
		if err != nil {
			t.Fatal(err)
		}
		sessions, err := s.Sessions(ctx, "previous-session")
		s.Close()
		if err != nil || len(sessions) != 1 || sessions[0].Device != "legacy browser" || !sessions[0].Current || sessions[0].IPAddress != "" {
			t.Fatalf("migrated session: %+v (%v)", sessions, err)
		}
	}
}
