package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func TestSessionDiagnosticsAfterRestart(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "restart.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SaveAccount(ctx, Account{Username: "fixture", Salt: "fixture", Hash: "fixture"}); err != nil {
		t.Fatal(err)
	}
	if err := signInSession(ctx, s, "fixture", "test-session", time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
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
