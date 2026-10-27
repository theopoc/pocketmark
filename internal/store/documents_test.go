package store

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestReaderDocumentSelectionOwnershipAndLimits(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	id := createLink(t, s, Link{URL: "https://example.com/page"})
	if _, err := s.ReaderDocument(ctx, id, nil); !errors.Is(err, ErrNoReaderDocument) {
		t.Fatalf("empty reader: %v", err)
	}
	claimed, err := s.Next(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Finish(ctx, claimed, "", "", "Automatic", []byte("<p>Automatic</p>"), nil); err != nil {
		t.Fatal(err)
	}
	if body, err := s.ReaderDocument(ctx, id, nil); err != nil || string(body) != "<p>Automatic</p>" {
		t.Fatalf("automatic reader: %q (%v)", body, err)
	}
	old, err := s.SaveAsset(ctx, Asset{LinkID: id, Name: "old.html", MediaType: "text/html", Kind: "html"}, strings.NewReader("<p>Old</p>"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.SaveAsset(ctx, Asset{LinkID: id, Name: "latest.html", MediaType: "text/html", Kind: "html"}, strings.NewReader("<p>Latest</p>")); err != nil {
		t.Fatal(err)
	}
	if body, err := s.ReaderDocument(ctx, id, nil); err != nil || string(body) != "<p>Latest</p>" {
		t.Fatalf("latest reader: %q (%v)", body, err)
	}
	if body, err := s.ReaderDocument(ctx, id, &old.ID); err != nil || string(body) != "<p>Old</p>" {
		t.Fatalf("explicit reader: %q (%v)", body, err)
	}
	otherID := createLink(t, s, Link{URL: "https://example.com/other"})
	if _, err = s.ReaderDocument(ctx, otherID, &old.ID); !errors.Is(err, ErrHTMLAssetNotFound) {
		t.Fatalf("cross-bookmark reader: %v", err)
	}
	pdf, err := s.SaveAsset(ctx, Asset{LinkID: id, Name: "file.pdf", MediaType: "application/pdf", Kind: "pdf"}, strings.NewReader("%PDF-1.7"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.ReaderDocument(ctx, id, &pdf.ID); !errors.Is(err, ErrHTMLAssetNotFound) {
		t.Fatalf("non-HTML reader: %v", err)
	}
	if _, err = s.SaveAsset(ctx, Asset{LinkID: id, Name: "large.html", MediaType: "text/html", Kind: "html"}, io.LimitReader(repeatedByteReader{}, (2<<20)+1)); err != nil {
		t.Fatal(err)
	}
	if _, err = s.ReaderDocument(ctx, id, nil); !errors.Is(err, ErrReaderTooLarge) {
		t.Fatalf("oversize reader: %v", err)
	}
}

func TestDocumentIndexingPreservesMetadataAndIgnoresStaleURL(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	id := createLink(t, s, Link{URL: "https://example.com/page", Notes: "Private", Tags: []string{"keep"}, Favorite: true})
	if err := s.IndexDocument(ctx, id, "https://example.com/page", "Captured title", "Captured description", "First text"); err != nil {
		t.Fatal(err)
	}
	link := getLink(t, s, id)
	if link.Title != "Captured title" || link.Description != "Captured description" || link.Content != "First text" || link.Notes != "Private" || !link.Favorite {
		t.Fatalf("initial indexing: %+v", link)
	}
	link.Title = "Personal title"
	link.Description = "Personal description"
	if err := s.Update(ctx, id, link); err != nil {
		t.Fatal(err)
	}
	if err := s.IndexDocument(ctx, id, link.URL, "Replacement title", "Replacement description", "Second text"); err != nil {
		t.Fatal(err)
	}
	link = getLink(t, s, id)
	if link.Title != "Personal title" || link.Description != "Personal description" || link.Content != "Second text" || len(link.Tags) != 1 || link.Tags[0] != "keep" {
		t.Fatalf("personal metadata overwritten: %+v", link)
	}
	oldURL := link.URL
	link.URL = "https://example.com/changed"
	if err := s.Update(ctx, id, link); err != nil {
		t.Fatal(err)
	}
	if err := s.IndexDocument(ctx, id, oldURL, "Stale title", "Stale description", "Stale text"); err != nil {
		t.Fatal(err)
	}
	link = getLink(t, s, id)
	if link.Content != "" || link.Status != "pending" || link.Title != "Personal title" {
		t.Fatalf("stale indexing applied: %+v", link)
	}
}

func TestSnapshotIncludesWALAndCleansFailedWork(t *testing.T) {
	s := testStore(t)
	id := createLink(t, s, Link{URL: "https://example.com/wal", Notes: "Committed in WAL"})
	f, err := s.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(f.Name())
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("snapshot permissions: %v (%v)", info, err)
	}
	copy, err := sql.Open("pocketmark-sqlite3", f.Name())
	if err != nil {
		t.Fatal(err)
	}
	var notes string
	err = copy.QueryRow("SELECT notes FROM links WHERE id=?", id).Scan(&notes)
	copy.Close()
	if err != nil || notes != "Committed in WAL" {
		t.Fatalf("snapshot lost committed data: %q (%v)", notes, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if failed, err := s.Snapshot(ctx); !errors.Is(err, context.Canceled) || failed != nil {
		t.Fatalf("cancelled snapshot: %v (%v)", failed, err)
	}
	paths, err := filepath.Glob(filepath.Join(s.directory, ".backup-*.db"))
	if err != nil || len(paths) != 1 || paths[0] != f.Name() {
		t.Fatalf("failed snapshot left temporary files: %v (%v)", paths, err)
	}
}

func TestSnapshotDoesNotWaitForApplicationConnection(t *testing.T) {
	s := testStore(t)
	id := createLink(t, s, Link{URL: "https://example.com/backup", Notes: "Committed in WAL"})
	// A busy application connection must not prevent an independent snapshot
	// reader from copying committed pages. Real captures and requests share it.
	conn, err := s.db.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	f, err := s.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(f.Name())
	defer f.Close()
	copy, err := sql.Open("pocketmark-sqlite3", f.Name())
	if err != nil {
		t.Fatal(err)
	}
	defer copy.Close()
	var notes string
	if err := copy.QueryRow("SELECT notes FROM links WHERE id=?", id).Scan(&notes); err != nil || notes != "Committed in WAL" {
		t.Fatalf("snapshot lost WAL data: %q (%v)", notes, err)
	}
}

func TestSnapshotLargeAssetRestoresOriginalBytes(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	id := createLink(t, s, Link{URL: "https://example.com/large"})
	const size = 19 << 20
	asset, err := s.SaveAsset(ctx, Asset{LinkID: id, Name: "large.pdf", MediaType: "application/pdf", Kind: "pdf"}, io.LimitReader(repeatedByteReader{}, size))
	if err != nil {
		t.Fatal(err)
	}
	f, err := s.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(f.Name())
	defer f.Close()
	restored, err := Open(f.Name())
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	want, got := sha256.New(), sha256.New()
	if _, err := io.Copy(want, io.LimitReader(repeatedByteReader{}, size)); err != nil {
		t.Fatal(err)
	}
	if err := restored.WriteAsset(ctx, asset.ID, got); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(want.Sum(nil), got.Sum(nil)) {
		t.Fatal("large backup changed the attachment bytes")
	}
}
