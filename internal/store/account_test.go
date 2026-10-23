package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"testing"
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
