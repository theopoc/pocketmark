package store

import (
	"context"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestDateSortLegacyUpgradeAndRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	for i, date := range []string{
		"2024-01-01T10:00:00Z",
		"2024-01-01T11:00:00+02:00", // Earlier, despite its lexical order.
		"2024-01-01T10:00:00.500Z",
		"2024-01-01T10:00:00Z", // Equal instants retain the ID tie-breaker.
	} {
		id := createLink(t, s, Link{URL: "https://example.com/" + string(rune('a'+i)), Notes: "Keep notes", Tags: []string{"keep"}})
		if _, err := s.db.Exec("UPDATE links SET created_at=?,updated_at=?,content=? WHERE id=?", date, date, strings.Repeat("Saved article ", 4096), id); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.db.Exec("DROP INDEX IF EXISTS links_created_order; DROP INDEX IF EXISTS links_updated_order; DROP INDEX IF EXISTS links_collection_created_order; DROP INDEX IF EXISTS links_collection_updated_order"); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	for restart := 0; restart < 2; restart++ {
		s, err := Open(path)
		if err != nil {
			t.Fatal(err)
		}
		for sort, want := range map[string][]int64{"newest": {3, 4, 1, 2}, "oldest": {2, 1, 4, 3}, "updated": {3, 4, 1, 2}} {
			page, err := s.List(ctx, Filter{Sort: sort})
			if err != nil {
				t.Fatal(err)
			}
			var got []int64
			for _, link := range page.Links {
				got = append(got, link.ID)
				if link.Notes != "Keep notes" || len(link.Tags) != 1 || link.Tags[0] != "keep" {
					t.Fatalf("migration changed metadata: %+v", link)
				}
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("%s after restart %d: got %v, want %v", sort, restart, got, want)
			}
			order := map[string]string{"newest": "julianday(l.created_at) DESC,l.id DESC", "oldest": "julianday(l.created_at),l.id", "updated": "julianday(l.updated_at) DESC,l.id DESC"}[sort]
			for _, where := range []string{"1=1", "l.collection_id IS NULL", "l.collection_id=1"} {
				rows, err := s.db.Query("EXPLAIN QUERY PLAN SELECT " + columns + " FROM links l WHERE " + where + " ORDER BY " + order + " LIMIT 40 OFFSET 0")
				if err != nil {
					t.Fatal(err)
				}
				var plans []string
				for rows.Next() {
					var id, parent, unused int
					var detail string
					if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
						t.Fatal(err)
					}
					plans = append(plans, detail)
				}
				if err := rows.Err(); err != nil {
					t.Fatal(err)
				}
				rows.Close()
				if plan := strings.Join(plans, "\n"); strings.Contains(plan, "TEMP B-TREE") || !strings.Contains(plan, "USING INDEX links_") {
					t.Errorf("%s (%s) sorts the library instead of traversing a date index:\n%s", sort, where, plan)
				}
			}
		}
		if content := getLink(t, s, 1).Content; content != strings.Repeat("Saved article ", 4096) {
			t.Fatal("migration changed the saved article")
		}
		if err := s.Close(); err != nil {
			t.Fatal(err)
		}
	}
}
