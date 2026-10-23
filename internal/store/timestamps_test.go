package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"
)

func TestCreationTimestampsUpgradeLegacyDatabaseOnce(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.db")
	legacy, err := sql.Open("pocketmark-sqlite3", path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = legacy.Exec(`CREATE TABLE collections(id INTEGER PRIMARY KEY,name TEXT NOT NULL,parent_id INTEGER REFERENCES collections(id));
CREATE TABLE compat_tags(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE);
INSERT INTO collections(id,name) VALUES(7,'Legacy collection');
INSERT INTO compat_tags(id,name) VALUES(9,'Legacy tag');`)
	if err != nil {
		t.Fatal(err)
	}
	if err = legacy.Close(); err != nil {
		t.Fatal(err)
	}
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	readDates := func() [3]string {
		t.Helper()
		var dates [3]string
		for i, query := range []string{"SELECT created_at FROM library_metadata WHERE id=1", "SELECT created_at FROM collections WHERE id=7", "SELECT created_at FROM compat_tags WHERE id=9"} {
			if err := s.db.QueryRow(query).Scan(&dates[i]); err != nil {
				t.Fatal(err)
			}
			if _, err := time.Parse(time.RFC3339Nano, dates[i]); err != nil {
				t.Fatalf("invalid persisted date %q: %v", dates[i], err)
			}
		}
		return dates
	}
	want := readDates()
	var description string
	if err := s.db.QueryRow("SELECT description FROM collections WHERE id=7").Scan(&description); err != nil || description != "" {
		t.Fatalf("legacy collection description should migrate to empty: %q (%v)", description, err)
	}
	if want[0] != want[1] || want[0] != want[2] {
		t.Fatalf("legacy rows should use the recorded upgrade date: %v", want)
	}
	if _, err = s.db.Exec("UPDATE collections SET name='Renamed' WHERE id=7"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.Exec("UPDATE compat_tags SET name='Renamed' WHERE id=9"); err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if got := readDates(); got != want {
		t.Fatalf("rename/reopen changed creation dates: got %v want %v", got, want)
	}
}

func TestCreationTimestampsCoverNativeAndImportWriters(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	if _, err := s.db.Exec("UPDATE library_metadata SET created_at='2001-01-01T00:00:00Z' WHERE id=1"); err != nil {
		t.Fatal(err)
	}
	cid := createCollection(t, s, "Native", nil)
	if _, err := s.db.Exec("INSERT INTO collections(name) VALUES('Imported')"); err != nil {
		t.Fatal(err)
	}
	lid := createLink(t, s, Link{URL: "https://example.com", Tags: []string{"native-tag"}})
	var original string
	if err := s.db.QueryRow("SELECT created_at FROM compat_tags WHERE name='native-tag'").Scan(&original); err != nil {
		t.Fatal(err)
	}
	l := getLink(t, s, lid)
	l.Tags = append(l.Tags, "edited-tag")
	if err := s.Update(ctx, lid, l); err != nil {
		t.Fatal(err)
	}
	if err := s.UpdateCollection(ctx, cid, Collection{Name: "Edited"}); err != nil {
		t.Fatal(err)
	}
	var current string
	if err := s.db.QueryRow("SELECT created_at FROM compat_tags WHERE name='native-tag'").Scan(&current); err != nil {
		t.Fatal(err)
	}
	if current != original {
		t.Fatal("native tag edit reset creation date")
	}
	rows, err := s.db.Query("SELECT created_at FROM collections UNION ALL SELECT created_at FROM compat_tags")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		var date string
		if err := rows.Scan(&date); err != nil {
			t.Fatal(err)
		}
		if _, err := time.Parse(time.RFC3339Nano, date); err != nil || date == "2001-01-01T00:00:00Z" {
			t.Fatalf("new row did not record creation time: %q (%v)", date, err)
		}
		count++
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if count != 4 {
		t.Fatalf("expected native/imported collections and native/edited tags, got %d rows", count)
	}
}
