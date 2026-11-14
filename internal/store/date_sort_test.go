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
	s, err := openTestStore(t, path)
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
		if _, err := s.db.Exec("UPDATE links SET created_at=$1,updated_at=$2,content=$3 WHERE id=$4", date, date, strings.Repeat("Saved article ", 4096), id); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	for restart := 0; restart < 2; restart++ {
		s, err := openTestStore(t, path)
		if err != nil {
			t.Fatal(err)
		}
		s.db.SetMaxOpenConns(1)
		if _, err := s.db.Exec("SET enable_seqscan=off; SET enable_sort=off"); err != nil {
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
			order := map[string]string{"newest": "link_instant(l.created_at) DESC,l.id DESC", "oldest": "link_instant(l.created_at),l.id", "updated": "link_instant(l.updated_at) DESC,l.id DESC"}[sort]
			for _, where := range []string{"1=1", "l.collection_id IS NULL", "l.collection_id=1"} {
				rows, err := s.db.Query("EXPLAIN SELECT " + columns + " FROM links l WHERE " + where + " ORDER BY " + order + " LIMIT 40 OFFSET 0")
				if err != nil {
					t.Fatal(err)
				}
				var plans []string
				for rows.Next() {

					var detail string
					if err := rows.Scan(&detail); err != nil {
						t.Fatal(err)
					}
					plans = append(plans, detail)
				}
				if err := rows.Err(); err != nil {
					t.Fatal(err)
				}
				rows.Close()
				if plan := strings.Join(plans, "\n"); !strings.Contains(plan, "Index Scan") {
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
