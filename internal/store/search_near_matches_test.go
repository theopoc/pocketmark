package store

import (
	"context"
	"strings"
	"testing"
)

func TestNearMatchesIncludeFullTextAndPreserveFilters(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	collection := createCollection(t, s, "Reading", nil)
	for _, item := range []struct{ title, notes, content string }{
		{"Browser guide", "", "browser"}, // Matches both paths, returned once.
		{"Browzer guide", "", ""},
		{"Saved article", "", "browser"},
		{"Personal article", "browser", ""},
		{"Other article", "", "browzer"}, // No typo scanning of captured bodies.
	} {
		id := createLink(t, s, Link{URL: "https://example.com/" + strings.ReplaceAll(item.title, " ", "-"), Title: item.title, Notes: item.notes, CollectionID: &collection, Tags: []string{"reading"}, Favorite: true})
		if _, err := s.db.Exec("UPDATE links SET content=? WHERE id=?", item.content, id); err != nil {
			t.Fatal(err)
		}
	}
	createLink(t, s, Link{URL: "https://example.com/excluded", Title: "Browser elsewhere"})
	filter := Filter{Query: "browser", Fuzzy: true, Collection: "1", Tag: "reading", Favorite: true, Unread: true, Sort: "oldest"}
	page, err := s.List(ctx, filter)
	if err != nil || page.Total != 4 || len(page.Links) != 4 {
		t.Fatalf("combined search: %+v, %v", page, err)
	}
	for i, link := range page.Links {
		if link.ID != int64(i+1) || link.Content != "" {
			t.Fatalf("unexpected result or captured body in list: %+v", link)
		}
		if link.ID == 2 {
			if link.SearchSnippet != "" {
				t.Fatalf("typo-only result has an exact excerpt: %q", link.SearchSnippet)
			}
		} else if !strings.Contains(strings.ToLower(link.SearchSnippet), "\x1ebrowser\x1f") {
			t.Fatalf("missing full-text excerpt: %+v", link)
		}
	}
	filter.Page = 2
	page, err = s.List(ctx, filter)
	if err != nil || page.Total != 4 || len(page.Links) != 0 {
		t.Fatalf("combined search pagination: %+v, %v", page, err)
	}
}
