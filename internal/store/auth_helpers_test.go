package store

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"
)

// Assertions use the same error-reporting authentication paths as the server.
// A storage failure must fail the test rather than look like a rejected key.
func apiKeyAuthenticates(t *testing.T, s *Store, ctx context.Context, hash string) bool {
	t.Helper()
	_, err := s.AuthenticateAPIKeyProfile(ctx, hash)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		t.Fatal(err)
	}
	return err == nil
}

func sessionUsable(t *testing.T, s *Store, ctx context.Context, hash string) bool {
	t.Helper()
	valid, err := s.CheckAndTouchSession(ctx, hash)
	if err != nil {
		t.Fatal(err)
	}
	return valid
}

func sessionConfirmed(t *testing.T, s *Store, ctx context.Context, hash string) bool {
	t.Helper()
	confirmed, err := s.CheckSessionConfirmed(ctx, hash)
	if err != nil {
		t.Fatal(err)
	}
	return confirmed
}

// Modern session fixtures exercise enrollment/sign-in, including proof
// consumption and the production insertion limits. The store treats the
// encrypted factor as opaque; cryptographic verification belongs to server tests.
func signInSession(ctx context.Context, s *Store, salt, hash string, expires time.Time, device ...string) error {
	label := ""
	if len(device) > 0 {
		label = device[0]
	}
	state, err := s.MFA(ctx)
	if err != nil {
		return err
	}
	if len(state.Secret) == 0 {
		return s.ActivateMFA(ctx, salt, state.Generation, 0, []byte("test-only-encrypted-factor"), nil, "", hash, expires, label, false)
	}
	var counter int64
	if err := s.db.QueryRowContext(ctx, "SELECT last_counter+1 FROM mfa WHERE id=1").Scan(&counter); err != nil {
		return err
	}
	return s.SignInMFA(ctx, salt, state.Generation, counter, "", hash, expires, label)
}
