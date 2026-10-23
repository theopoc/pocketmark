package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
)

func TestSearchExcerptFromLegacyDatabaseAfterRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.db")
	legacy, err := sql.Open("pocketmark-sqlite3", path)
	if err != nil {
		t.Fatal(err)
	}
	// Pre-timestamp-migration schema with an existing external-content index.
	_, err = legacy.Exec(`CREATE TABLE collections(id INTEGER PRIMARY KEY,name TEXT NOT NULL,parent_id INTEGER);
CREATE TABLE links(id INTEGER PRIMARY KEY,url TEXT NOT NULL UNIQUE,title TEXT NOT NULL DEFAULT '',description TEXT NOT NULL DEFAULT '',notes TEXT NOT NULL DEFAULT '',collection_id INTEGER,tags TEXT NOT NULL DEFAULT '[]',favorite INTEGER NOT NULL DEFAULT 0,read INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'ready',error TEXT NOT NULL DEFAULT '',content TEXT NOT NULL DEFAULT '',archive BLOB,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE VIRTUAL TABLE links_fts USING fts5(title,url,description,notes,tags,content,content='links',content_rowid='id',tokenize='unicode61 remove_diacritics 2');
INSERT INTO links(id,url,title,content,created_at,updated_at) VALUES(7,'https://example.com/legacy','Legacy bookmark','Saved café reference','2024-01-01T00:00:00Z','2024-01-01T00:00:00Z');
INSERT INTO links_fts(links_fts) VALUES('rebuild');`)
	legacy.Close()
	if err != nil {
		t.Fatal(err)
	}
	for restart := 0; restart < 2; restart++ {
		s, err := Open(path)
		if err != nil {
			t.Fatal(err)
		}
		page, err := s.List(context.Background(), Filter{Query: "cafe"})
		s.Close()
		if err != nil || page.Total != 1 || len(page.Links) != 1 {
			t.Fatalf("legacy restart %d: %+v, %v", restart, page, err)
		}
		if link := page.Links[0]; link.ID != 7 || link.Content != "" || !strings.Contains(link.SearchSnippet, "\x1ecafé\x1f") {
			t.Fatalf("legacy search excerpt: %+v", link)
		}
	}
}
