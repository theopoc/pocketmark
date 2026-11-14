package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"testing"
	"time"
)

func TestAPIKeyLimitAndRevocation(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	for i := 0; i < 32; i++ {
		if _, err := s.CreateScopedAPIKey(ctx, fmt.Sprintf("client %d", i), fmt.Sprintf("%064x", i+1), "full", 0); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.CreateScopedAPIKey(ctx, "overflow", fmt.Sprintf("%064x", 33), "full", 0); !errors.Is(err, ErrAPIKeyLimit) {
		t.Fatalf("key limit: %v", err)
	}
	keys, err := s.APIKeys(ctx)
	if err != nil || len(keys) != 32 {
		t.Fatalf("keys: %+v (%v)", keys, err)
	}
	hash := fmt.Sprintf("%064x", 1)
	if !apiKeyAuthenticates(t, s, ctx, hash) {
		t.Fatal("created key missing")
	}
	if err = s.DeleteAPIKey(ctx, keys[0].ID); err != nil {
		t.Fatal(err)
	}
	if apiKeyAuthenticates(t, s, ctx, hash) {
		t.Fatal("revoked key accepted")
	}
	if err = s.DeleteAPIKey(ctx, keys[0].ID); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("missing key: %v", err)
	}
	if _, err = s.CreateScopedAPIKey(ctx, "replacement", fmt.Sprintf("%064x", 33), "full", 0); err != nil {
		t.Fatal(err)
	}
}

func TestRenamedAPIKeyPreservesCredentialAndHistoryAcrossRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "library.db")
	s, err := openTestStore(t, path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { s.Close() }()
	ctx := context.Background()
	key, err := s.CreateScopedAPIKey(ctx, "Old name", "unchanged hash", "full", 0)
	if err != nil {
		t.Fatal(err)
	}
	if !apiKeyAuthenticates(t, s, ctx, "unchanged hash") {
		t.Fatal("key rejected")
	}
	active := false
	if err := s.UpdateAPIKey(ctx, key.ID, nil, &active); err != nil {
		t.Fatal(err)
	}
	before, err := s.APIKeys(ctx)
	if err != nil {
		t.Fatal(err)
	}
	name := "Renamed sync"
	if err := s.UpdateAPIKey(ctx, key.ID, &name, nil); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = openTestStore(t, path)
	if err != nil {
		t.Fatal(err)
	}
	keys, err := s.APIKeys(ctx)
	expected := before[0]
	expected.Name = name
	if err != nil || len(keys) != 1 || keys[0] != expected {
		t.Fatalf("rename changed credential metadata: %+v (%v)", keys, err)
	}
	if apiKeyAuthenticates(t, s, ctx, "unchanged hash") {
		t.Fatal("rename reactivated key")
	}
	active = true
	if err := s.UpdateAPIKey(ctx, key.ID, nil, &active); err != nil {
		t.Fatal(err)
	}
	if !apiKeyAuthenticates(t, s, ctx, "unchanged hash") {
		t.Fatal("rename changed secret")
	}
	if err := s.UpdateAPIKey(ctx, key.ID+1, &name, nil); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("missing key: %v", err)
	}
}

func TestAPIKeyActivityAndDisable(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	key, err := s.CreateScopedAPIKey(ctx, "client", "test hash", "full", 0)
	if err != nil || !key.Active || key.LastUsedAt != "" {
		t.Fatalf("new key: %+v (%v)", key, err)
	}
	if !apiKeyAuthenticates(t, s, ctx, "test hash") || apiKeyAuthenticates(t, s, ctx, "unknown") {
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
	active := false
	if err := s.UpdateAPIKey(ctx, key.ID, nil, &active); err != nil {
		t.Fatal(err)
	}
	if apiKeyAuthenticates(t, s, ctx, "test hash") {
		t.Fatal("disabled key accepted")
	}
	keys, err = s.APIKeys(ctx)
	if err != nil || keys[0].Active || keys[0].LastUsedAt != used {
		t.Fatalf("disabled activity changed: %+v (%v)", keys, err)
	}
	active = true
	if err := s.UpdateAPIKey(ctx, key.ID, nil, &active); err != nil {
		t.Fatal(err)
	}
	if !apiKeyAuthenticates(t, s, ctx, "test hash") {
		t.Fatal("reactivated key rejected")
	}
	if err := s.UpdateAPIKey(ctx, key.ID+1, nil, &active); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("missing key: %v", err)
	}
}
