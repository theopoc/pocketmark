package store

import (
	"bytes"
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestOpenInitializesPersistenceAndPreservesAcrossRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "library.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if s != nil {
			s.Close()
		}
	})
	ctx := context.Background()
	state, err := s.SetupStatus(ctx)
	if err != nil || !state.SetupRequired || state.PasswordEnabled {
		t.Fatalf("fresh setup: %+v (%v)", state, err)
	}
	account := Account{Username: "owner", Salt: "persisted salt", Hash: "persisted password hash"}
	if created, err := s.CreateAccount(ctx, account); err != nil || !created {
		t.Fatalf("setup: %t (%v)", created, err)
	}
	key, err := s.CreateAPIKey(ctx, "Floccus", strings.Repeat("a", 64))
	if err != nil {
		t.Fatal(err)
	}
	id := createLink(t, s, Link{URL: "https://example.com/keep", Notes: "Personal note", Tags: []string{"kept"}, Favorite: true})
	claimed, err := s.Next(ctx)
	if err != nil || claimed.ID != id {
		t.Fatalf("capture: %+v (%v)", claimed, err)
	}
	if err := s.Finish(ctx, claimed, "Captured title", "Description", "Captured text", []byte("<p>Automatic capture</p>"), nil); err != nil {
		t.Fatal(err)
	}
	asset, err := s.SaveAsset(ctx, Asset{LinkID: id, Name: "page.html", MediaType: "text/html", Kind: "html"}, strings.NewReader("<p>Uploaded page</p>"))
	if err != nil {
		t.Fatal(err)
	}
	fileID, file, err := s.CreateFile(ctx, Link{URL: "pocketmark-file:" + strings.Repeat("b", 64), Title: "Manual"}, Asset{Name: "manual.pdf", MediaType: "application/pdf", Kind: "pdf"}, strings.NewReader("%PDF-1.7\nManual"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.DAVLock(ctx, "client", true); err != nil {
		t.Fatal(err)
	}
	var before bytes.Buffer
	snapshot, err := s.WriteDAVSnapshot(ctx, &before)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.ConfirmDAVRead(ctx, "client", snapshot.Revision); err != nil {
		t.Fatal(err)
	}
	if err = s.StageDAV(ctx, "client", bytes.NewReader(before.Bytes())); err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.Account(ctx)
	if err != nil || got != account {
		t.Fatalf("account after restart: %+v (%v)", got, err)
	}
	state, err = s.SetupStatus(ctx)
	if err != nil || state.SetupRequired || !state.PasswordEnabled {
		t.Fatalf("setup after restart: %+v (%v)", state, err)
	}
	keys, err := s.APIKeys(ctx)
	if err != nil || len(keys) != 1 || keys[0] != key || !s.HasAPIKeyHash(ctx, strings.Repeat("a", 64)) {
		t.Fatalf("keys after restart: %+v (%v)", keys, err)
	}
	link, err := s.Get(ctx, id)
	if err != nil || link.Notes != "Personal note" || !link.Favorite || len(link.Tags) != 1 || link.Tags[0] != "kept" || link.Content != "Captured text" {
		t.Fatalf("bookmark after restart: %+v (%v)", link, err)
	}
	for assetID, expected := range map[int64]string{asset.ID: "<p>Uploaded page</p>", file.ID: "%PDF-1.7\nManual"} {
		var body bytes.Buffer
		if err = s.WriteAsset(ctx, assetID, &body); err != nil || body.String() != expected {
			t.Fatalf("asset %d: %q (%v)", assetID, body.String(), err)
		}
	}
	if fileLink, err := s.Get(ctx, fileID); err != nil || fileLink.Status != "ready" || fileLink.Type != "file" {
		t.Fatalf("file after restart: %+v (%v)", fileLink, err)
	}
	var after bytes.Buffer
	next, err := s.WriteDAVSnapshot(ctx, &after)
	if err != nil || snapshot.ETag != next.ETag || snapshot.Revision != next.Revision || !bytes.Equal(before.Bytes(), after.Bytes()) {
		t.Fatalf("DAV snapshot changed: %+v (%v)", next, err)
	}
	var staged bytes.Buffer
	temp, err := s.WriteDAVTemp(ctx, "client", &staged)
	if err != nil || !bytes.Equal(staged.Bytes(), before.Bytes()) {
		t.Fatalf("DAV staging lost (%v)", err)
	}
	if err = s.ApplyDAV(ctx, "client", bytes.NewReader(staged.Bytes()), snapshot.ETag, temp.ETag); err != nil {
		t.Fatalf("DAV lease did not survive restart: %v", err)
	}
}

func TestOpenRollsBackFailedSchemaInitialization(t *testing.T) {
	path := filepath.Join(t.TempDir(), "broken.db")
	legacy, err := sql.Open("pocketmark-sqlite3", path)
	if err != nil {
		t.Fatal(err)
	}
	defer legacy.Close()
	// A malformed feature schema fails after base/account/attachment creation.
	if _, err = legacy.Exec("CREATE TABLE dav_revision(id INTEGER PRIMARY KEY,value INTEGER)"); err != nil {
		t.Fatal(err)
	}
	s, err := Open(path)
	if err == nil || s != nil {
		if s != nil {
			s.Close()
		}
		t.Fatal("malformed schema was accepted")
	}
	for _, table := range []string{"links", "account_setup", "account", "api_tokens", "assets"} {
		var count int
		if err = legacy.QueryRow("SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?", table).Scan(&count); err != nil || count != 0 {
			t.Fatalf("partial schema %s: %d (%v)", table, count, err)
		}
	}
	if _, err = legacy.Exec("DROP TABLE dav_revision"); err != nil {
		t.Fatal(err)
	}
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	state, err := s.SetupStatus(context.Background())
	if err != nil || !state.SetupRequired {
		t.Fatalf("fresh setup after retry: %+v (%v)", state, err)
	}
}

func TestLegacyAccountSchemaNeverBecomesClaimable(t *testing.T) {
	for _, fixture := range []string{
		`CREATE TABLE account(id INTEGER PRIMARY KEY,username TEXT NOT NULL,salt TEXT NOT NULL,hash TEXT NOT NULL)`,
		`CREATE TABLE account(id INTEGER PRIMARY KEY,username TEXT NOT NULL,salt TEXT NOT NULL,hash TEXT NOT NULL); INSERT INTO account VALUES(1,'disabled','','')`,
		`CREATE TABLE api_tokens(id INTEGER PRIMARY KEY,name TEXT NOT NULL,hash TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL)`,
	} {
		t.Run(fixture, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "legacy.db")
			legacy, err := sql.Open("pocketmark-sqlite3", path)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = legacy.Exec(fixture); err != nil {
				legacy.Close()
				t.Fatal(err)
			}
			if err = legacy.Close(); err != nil {
				t.Fatal(err)
			}
			for i := 0; i < 2; i++ {
				s, err := Open(path)
				if err != nil {
					t.Fatal(err)
				}
				state, err := s.SetupStatus(context.Background())
				if err != nil || state.SetupRequired || state.PasswordEnabled {
					s.Close()
					t.Fatalf("legacy setup: %+v (%v)", state, err)
				}
				created, err := s.CreateAccount(context.Background(), Account{Username: "intruder", Salt: "salt", Hash: "hash"})
				s.Close()
				if err != nil || created {
					t.Fatalf("legacy claim accepted: %t (%v)", created, err)
				}
			}
		})
	}
}

func TestAccountClaimAcrossIndependentConnections(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shared.db")
	a, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	b, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	var wg sync.WaitGroup
	created := make(chan bool, 2)
	errors := make(chan error, 2)
	start := make(chan struct{})
	for _, s := range []*Store{a, b} {
		wg.Add(1)
		go func(s *Store) {
			defer wg.Done()
			<-start
			ok, err := s.CreateAccount(context.Background(), Account{Username: "owner", Salt: "salt", Hash: "hash"})
			created <- ok
			errors <- err
		}(s)
	}
	close(start)
	wg.Wait()
	close(created)
	close(errors)
	count := 0
	for ok := range created {
		if ok {
			count++
		}
	}
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	if count != 1 {
		t.Fatalf("got %d owners", count)
	}
}
