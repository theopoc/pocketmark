package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"testing"
	"time"
)

func TestAPIKeyLimitAndRevocation(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	for i := 0; i < 32; i++ {
		if _, err := s.CreateAPIKey(ctx, fmt.Sprintf("client %d", i), fmt.Sprintf("%064x", i+1)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.CreateAPIKey(ctx, "overflow", fmt.Sprintf("%064x", 33)); !errors.Is(err, ErrAPIKeyLimit) {
		t.Fatalf("key limit: %v", err)
	}
	keys, err := s.APIKeys(ctx)
	if err != nil || len(keys) != 32 {
		t.Fatalf("keys: %+v (%v)", keys, err)
	}
	hash := fmt.Sprintf("%064x", 1)
	if !s.HasAPIKeyHash(ctx, hash) {
		t.Fatal("created key missing")
	}
	if err = s.DeleteAPIKey(ctx, keys[0].ID); err != nil {
		t.Fatal(err)
	}
	if s.HasAPIKeyHash(ctx, hash) {
		t.Fatal("revoked key accepted")
	}
	if err = s.DeleteAPIKey(ctx, keys[0].ID); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("missing key: %v", err)
	}
	if _, err = s.CreateAPIKey(ctx, "replacement", fmt.Sprintf("%064x", 33)); err != nil {
		t.Fatal(err)
	}
}

func TestAPIKeyActivityAndDisable(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	key, err := s.CreateAPIKey(ctx, "client", "test hash")
	if err != nil || !key.Active || key.LastUsedAt != "" {
		t.Fatalf("new key: %+v (%v)", key, err)
	}
	if !s.AuthenticateAPIKey(ctx, "test hash") || s.AuthenticateAPIKey(ctx, "unknown") {
		t.Fatal("authentication mismatch")
	}
	keys, err := s.APIKeys(ctx)
	if err != nil {
		t.Fatal(err)
	}
	used := keys[0].LastUsedAt
	if _, err := time.Parse(time.RFC3339Nano, used); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAPIKeyActive(ctx, key.ID, false); err != nil {
		t.Fatal(err)
	}
	if s.AuthenticateAPIKey(ctx, "test hash") || s.HasAPIKeyHash(ctx, "test hash") {
		t.Fatal("disabled key accepted")
	}
	keys, err = s.APIKeys(ctx)
	if err != nil || keys[0].Active || keys[0].LastUsedAt != used {
		t.Fatalf("disabled activity changed: %+v (%v)", keys, err)
	}
	if err := s.SetAPIKeyActive(ctx, key.ID, true); err != nil {
		t.Fatal(err)
	}
	if !s.AuthenticateAPIKey(ctx, "test hash") {
		t.Fatal("reactivated key rejected")
	}
	if err := s.SetAPIKeyActive(ctx, key.ID+1, true); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("missing key: %v", err)
	}
}
