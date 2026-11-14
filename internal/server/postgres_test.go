package server

import (
	"pocketmark/internal/pgtest"
	"pocketmark/internal/store"
	"testing"
)

func openTestStore(t testing.TB, path string) (*store.Store, error) {
	t.Helper()
	return store.Open(pgtest.URL(t, path), pgtest.Directory(path))
}

func restoreTestStore(t testing.TB, path string) (*store.Store, error) {
	return store.Open(pgtest.Restore(t, path), pgtest.Directory(path))
}
