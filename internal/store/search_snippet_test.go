package store

import (
	"context"
	"path/filepath"
	"pocketmark/internal/pgtest"
	"strings"
	"testing"
)

func TestSearchExcerptFromLegacyDatabaseAfterRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.db")
	pgtest.Migrate(t, path, `INSERT INTO links(id,url,title,content,created_at,updated_at) VALUES(7,'https://example.com/legacy','Legacy bookmark','Saved café reference','2024-01-01T00:00:00Z','2024-01-01T00:00:00Z');`)
	for restart := 0; restart < 2; restart++ {
		s, err := openTestStore(t, path)
		if err != nil {
			t.Fatal(err)
		}
		page, err := s.List(context.Background(), Filter{Query: "cafe", Fuzzy: true})
		s.Close()
		if err != nil || page.Total != 1 || len(page.Links) != 1 {
			t.Fatalf("legacy restart %d: %+v, %v", restart, page, err)
		}
		if link := page.Links[0]; link.ID != 7 || link.Content != "" || !strings.Contains(link.SearchSnippet, "\x1ecafé\x1f") {
			t.Fatalf("legacy search excerpt: %+v", link)
		}
	}
}
