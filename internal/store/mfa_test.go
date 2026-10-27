package store

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestMFAMigrationRevokesOnlyLegacySessions(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "legacy.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	account := Account{Username: "owner", Salt: "salt", Hash: "hash"}
	if err = s.SaveAccount(ctx, account); err != nil {
		t.Fatal(err)
	}
	if err = s.CreateSession(ctx, account.Salt, "legacy-session", time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	link := createLink(t, s, Link{URL: "https://example.test/retained", Notes: "kept"})
	if _, err = s.CreateAPIKey(ctx, "client", "client-hash"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.Exec("DROP TABLE mfa_recovery; DROP TABLE mfa"); err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if s.SessionValid(ctx, "legacy-session") {
		t.Fatal("legacy session survived the MFA migration")
	}
	if got, err := s.Get(ctx, link); err != nil || got.Notes != "kept" {
		t.Fatal("library changed during migration", err)
	}
	if !s.HasAPIKeyHash(ctx, "client-hash") {
		t.Fatal("integration key changed during migration")
	}
	if _, err = s.db.Exec("UPDATE mfa SET secret=X'0102' WHERE id=1"); err != nil {
		t.Fatal(err)
	}
	if err = s.CreateSession(ctx, account.Salt, "new-session", time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if !s.SessionValid(ctx, "new-session") {
		t.Fatal("ordinary restart revoked a post-migration session")
	}
}

func TestMFANativeBackupInvalidatesCodesOnlyOnRestore(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "live.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err = s.db.Exec("UPDATE mfa SET secret=X'0102' WHERE id=1; INSERT INTO mfa_recovery(hash) VALUES('saved-code')"); err != nil {
		t.Fatal(err)
	}
	f, err := s.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	path := f.Name()
	f.Close()
	defer os.Remove(path)
	var count int
	if err = s.db.QueryRow("SELECT count(*) FROM mfa_recovery").Scan(&count); err != nil || count != 1 {
		t.Fatal("backup changed live recovery codes", err)
	}
	restored, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err = restored.db.QueryRow("SELECT count(*) FROM mfa_recovery").Scan(&count); err != nil || count != 0 {
		t.Fatal("restored recovery codes were not invalidated", err)
	}
	state, err := restored.MFA(ctx)
	if err != nil || len(state.Secret) != 2 {
		t.Fatal("restore removed the encrypted factor", err)
	}
	if _, err = restored.db.Exec("INSERT INTO mfa_recovery(hash) VALUES('new-code')"); err != nil {
		t.Fatal(err)
	}
	if err = restored.Close(); err != nil {
		t.Fatal(err)
	}
	restored, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	if err = restored.db.QueryRow("SELECT count(*) FROM mfa_recovery").Scan(&count); err != nil || count != 1 {
		t.Fatal("ordinary restart removed newly generated codes", err)
	}
}
