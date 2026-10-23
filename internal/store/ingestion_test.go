package store

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"testing"
)

func TestDocumentStorageStreamingAndRollback(t *testing.T) {
	for _, standalone := range []bool{false, true} {
		for _, tc := range []struct {
			name string
			size int64
			err  string
		}{
			{"empty", 0, "empty"},
			{"short", 1, ""},
			{"full-block", assetChunkSize, ""},
			{"partial-final-block", assetChunkSize + 13, ""},
			{"exact-limit", MaxAssetSize, ""},
			{"oversize", MaxAssetSize + 1, "exceeds 20 MiB"},
			{"interrupted", assetChunkSize + 13, "upload interrupted"},
		} {
			t.Run(fmt.Sprintf("standalone=%t/%s", standalone, tc.name), func(t *testing.T) {
				s := testStore(t)
				ctx := context.Background()
				var src io.Reader = io.LimitReader(repeatedByteReader{}, tc.size)
				if tc.name == "interrupted" {
					src = io.MultiReader(src, interruptedFile{})
				}
				var asset Asset
				var err error
				wantLinks := 1
				if standalone {
					_, asset, err = s.CreateFile(ctx, Link{URL: "pocketmark-file:" + strings.Repeat("a", 64)}, Asset{Name: "document.pdf", MediaType: "application/pdf", Kind: "pdf"}, src)
					if tc.err != "" {
						wantLinks = 0
					}
				} else {
					id := createLink(t, s, Link{URL: "https://example.com/document"})
					asset, err = s.SaveAsset(ctx, Asset{LinkID: id, Name: "document.pdf", MediaType: "application/pdf", Kind: "pdf"}, src)
				}
				if tc.err == "" {
					if err != nil || asset.Size != tc.size {
						t.Fatalf("asset: %+v, error: %v", asset, err)
					}
					var copied int64
					if err := s.WriteAsset(ctx, asset.ID, assetWriterFunc(func(p []byte) (int, error) {
						for _, b := range p {
							if b != 'x' {
								t.Fatal("stored bytes changed")
							}
						}
						copied += int64(len(p))
						return len(p), nil
					})); err != nil || copied != tc.size {
						t.Fatalf("download: %d bytes, error: %v", copied, err)
					}
				} else {
					if err == nil || !strings.Contains(err.Error(), tc.err) {
						t.Fatalf("want %q, got %v", tc.err, err)
					}
					for _, table := range []string{"assets", "asset_chunks"} {
						var count int
						if err := s.db.QueryRow("SELECT count(*) FROM " + table).Scan(&count); err != nil || count != 0 {
							t.Fatalf("partial %s retained: %d (%v)", table, count, err)
						}
					}
				}
				var links int
				if err := s.db.QueryRow("SELECT count(*) FROM links").Scan(&links); err != nil || links != wantLinks {
					t.Fatalf("bookmarks: got %d, want %d (%v)", links, wantLinks, err)
				}
			})
		}
	}
}

func TestDocumentStorageExistingDatabaseAndRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "existing.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if s != nil {
			if err := s.Close(); err != nil {
				t.Error(err)
			}
		}
	})
	ctx := context.Background()
	id := createLink(t, s, Link{URL: "https://example.com/existing", Notes: "Keep notes", Tags: []string{"reference"}})
	// Seed the pre-refactor asset schema directly, without either ingestion path.
	const legacyBody = "%PDF-1.7\nExisting attachment"
	if _, err := s.db.Exec(`INSERT INTO assets(id,link_id,name,media_type,kind,size,created_at) VALUES(41,?,'old.pdf','application/pdf','pdf',?,'2026-01-01T00:00:00Z');
INSERT INTO asset_chunks(asset_id,ordinal,data) VALUES(41,0,?)`, id, len(legacyBody), []byte(legacyBody)); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	a, err := s.SaveAsset(ctx, Asset{LinkID: id, Name: "new.pdf", MediaType: "application/pdf", Kind: "pdf"}, strings.NewReader("new attachment"))
	if err != nil {
		t.Fatal(err)
	}
	fileID, file, err := s.CreateFile(ctx, Link{URL: "pocketmark-file:" + strings.Repeat("b", 64), Title: "Manual", Content: "Restartquicksilver"}, Asset{Name: "manual.html", MediaType: "text/html", Kind: "html"}, strings.NewReader("<p>Restartquicksilver</p>"))
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	for assetID, expected := range map[int64]string{41: legacyBody, a.ID: "new attachment", file.ID: "<p>Restartquicksilver</p>"} {
		var body bytes.Buffer
		if err := s.WriteAsset(ctx, assetID, &body); err != nil || body.String() != expected {
			t.Fatalf("asset %d after restart: %q (%v)", assetID, body.String(), err)
		}
	}
	link, err := s.Get(ctx, id)
	if err != nil || link.Notes != "Keep notes" || len(link.Tags) != 1 || link.Tags[0] != "reference" {
		t.Fatalf("existing metadata changed: %+v (%v)", link, err)
	}
	page, err := s.List(ctx, Filter{Query: "Restartquicksilver"})
	if err != nil || page.Total != 1 || page.Links[0].ID != fileID || page.Links[0].Status != "ready" {
		t.Fatalf("standalone indexing lost after restart: %+v (%v)", page, err)
	}
}
