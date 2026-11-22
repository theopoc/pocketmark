package store

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestAITagSettingsMutationsAcrossReplicas(t *testing.T) {
	first := testStore(t)
	second, err := Open(first.databaseURL, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	// A contending attempt must return this pool's only connection immediately.
	second.db.SetMaxOpenConns(1)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	ran, err := first.TryAITagSettings(ctx, func() {
		ran, err := second.TryAITagSettings(ctx, func() { t.Fatal("overlapping owner mutation") })
		if err != nil || ran {
			t.Fatalf("contender result: ran=%v err=%v", ran, err)
		}
		// An owner mutation may renew credentials while holding the settings
		// lock, and the other replica can still serve unrelated reads.
		err = first.UpdateAITagCredentials(ctx, func(_ []byte, save func([]byte) error) error {
			return save([]byte("updated"))
		})
		if err != nil {
			t.Fatal(err)
		}
		if data, err := second.ReadAITagCredentials(ctx); err != nil || string(data) != "updated" {
			t.Fatal("contender retained a connection or blocked credential updates")
		}
	})
	if err != nil || !ran {
		t.Fatalf("first owner mutation: ran=%v err=%v", ran, err)
	}
	retried := false
	ran, err = second.TryAITagSettings(ctx, func() { retried = true })
	if err != nil || !ran || !retried {
		t.Fatalf("second replica failed to acquire released lock: ran=%v err=%v", ran, err)
	}
}

func TestAITagCredentialUpdatesAcrossReplicas(t *testing.T) {
	first := testStore(t)
	second, err := Open(first.databaseURL, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	wrote := make(chan struct{})
	release := make(chan struct{})
	lateError := errors.New("operation failed after rotation")
	firstDone := make(chan error, 1)
	go func() {
		firstDone <- first.UpdateAITagCredentials(ctx, func(_ []byte, save func([]byte) error) error {
			if err := save([]byte("consumed")); err != nil {
				return err
			}
			close(wrote)
			select {
			case <-release:
			case <-ctx.Done():
				return ctx.Err()
			}
			if err := save([]byte("rotated")); err != nil {
				return err
			}
			return lateError
		})
	}()
	select {
	case <-wrote:
	case err := <-firstDone:
		t.Fatalf("first writer failed: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	// A second pool in its own directory sees the consumption immediately.
	envelope, err := second.ReadAITagCredentials(ctx)
	if err != nil || string(envelope) != "consumed" {
		t.Fatal("credential update was not committed")
	}
	var available bool
	if err := second.db.QueryRowContext(ctx, "SELECT pg_try_advisory_xact_lock($1)", aiCredentialLock).Scan(&available); err != nil || available {
		t.Fatal("rotating session was not locked across pools")
	}
	secondDone := make(chan error, 1)
	go func() {
		secondDone <- second.UpdateAITagCredentials(ctx, func(latest []byte, save func([]byte) error) error {
			if string(latest) != "rotated" {
				return errors.New("concurrent writer used stale credentials")
			}
			return save([]byte("newer"))
		})
	}()
	close(release)
	if !errors.Is(<-firstDone, lateError) {
		t.Fatal("callback error was lost")
	}
	if err := <-secondDone; err != nil {
		t.Fatal(err)
	}
	envelope, err = first.ReadAITagCredentials(ctx)
	if err != nil || string(envelope) != "newer" {
		t.Fatal("replicas did not share latest credentials")
	}
}
