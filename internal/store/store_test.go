package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

func testStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "library.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func createLink(t *testing.T, s *Store, l Link) int64 {
	t.Helper()
	id, err := s.Create(context.Background(), l)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func getLink(t *testing.T, s *Store, id int64) Link {
	t.Helper()
	l, err := s.Get(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	return l
}

func createCollection(t *testing.T, s *Store, name string, parent *int64) int64 {
	t.Helper()
	id, err := s.AddCollection(context.Background(), Collection{Name: name, ParentID: parent})
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestCRUDPersistsAcrossReopen(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "nested", "library.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	collection := createCollection(t, s, "Research", nil)
	id := createLink(t, s, Link{URL: "https://example.com/article", Title: "First", CollectionID: &collection, Tags: []string{"read"}})
	created := getLink(t, s, id)
	if created.ID != id || created.Status != "pending" || created.CreatedAt == "" || created.UpdatedAt == "" {
		t.Fatalf("unexpected new link: %+v", created)
	}
	created.Title = "Updated"
	created.Description = "An article"
	created.Notes = "My notes"
	created.Tags = []string{"personal", "read"}
	created.Favorite = true
	created.Read = true
	if err := s.Update(ctx, id, created); err != nil {
		t.Fatal(err)
	}
	want := getLink(t, s, id)
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := getLink(t, s, id); !reflect.DeepEqual(got, want) {
		t.Fatalf("reopen changed link:\ngot  %+v\nwant %+v", got, want)
	}
	page, err := s.List(ctx, Filter{Query: "notes"})
	if err != nil || len(page.Links) != 1 || page.Links[0].SearchSnippet != "My \x1enotes\x1f" || page.Links[0].Content != "" {
		t.Fatalf("search excerpt after restart: %+v, %v", page, err)
	}
	if _, err := s.Create(ctx, Link{URL: created.URL}); err == nil {
		t.Fatal("duplicate URL was accepted")
	}
	if err := s.Delete(ctx, id); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Get(ctx, id); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("Get after delete: %v", err)
	}
	if err := s.Delete(ctx, id); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("Delete missing link: %v", err)
	}
	if err := s.Update(ctx, id, created); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("Update missing link: %v", err)
	}
}

func TestSearchTracksAllIndexedFieldsAndMutations(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	id := createLink(t, s, Link{URL: "https://searchable.example.com/", Title: "Café Concurrency", Description: "Durable storage", Notes: "Personal observation", Tags: []string{"systems"}})
	claimed, err := s.Next(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Finish(ctx, claimed, "", "", "Captured aardvark", []byte("archive"), nil); err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{"CAFE", "concur", "searchable", "durab", "observ", "syst", "aard", "cafe concurrency"} {
		t.Run(query, func(t *testing.T) {
			page, err := s.List(ctx, Filter{Query: query})
			if err != nil || page.Total != 1 || len(page.Links) != 1 || page.Links[0].ID != id {
				t.Fatalf("query %q: page=%+v err=%v", query, page, err)
			}
			if page.Links[0].Content != "" {
				t.Fatal("list loaded captured content")
			}
			if !strings.Contains(page.Links[0].SearchSnippet, "\x1e") || !strings.Contains(page.Links[0].SearchSnippet, "\x1f") {
				t.Fatalf("query %q has no highlighted excerpt: %q", query, page.Links[0].SearchSnippet)
			}
		})
	}
	for _, query := range []string{`"`, `OR`, `cafe OR nonexistent`, `*`, `cafe" OR "*`} {
		if _, err := s.List(ctx, Filter{Query: query}); err != nil {
			t.Errorf("literal user search %q produced FTS syntax error: %v", query, err)
		}
	}
	l := getLink(t, s, id)
	l.Title = "Replacement title"
	l.Notes = "New note"
	l.Tags = []string{"changed"}
	if err := s.Update(ctx, id, l); err != nil {
		t.Fatal(err)
	}
	for query, count := range map[string]int{"concurrency": 0, "observation": 0, "systems": 0, "replacement": 1, "changed": 1, "aardvark": 1} {
		page, err := s.List(ctx, Filter{Query: query})
		if err != nil || page.Total != count {
			t.Errorf("after update query %q: total=%d want=%d err=%v", query, page.Total, count, err)
		}
	}
	if err := s.Delete(ctx, id); err != nil {
		t.Fatal(err)
	}
	page, err := s.List(ctx, Filter{Query: "replacement"})
	if err != nil || page.Total != 0 {
		t.Fatalf("deleted FTS entry remains: %+v, %v", page, err)
	}
}

func TestSearchExcerptBoundsAndOrdinaryLists(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	id := createLink(t, s, Link{URL: "https://example.com/snippet", Title: "Compact result"})
	if _, err := s.db.Exec("UPDATE links SET content=? WHERE id=?", "<script>not executable</script> needle "+strings.Repeat("界", 1200), id); err != nil {
		t.Fatal(err)
	}
	for _, filter := range []Filter{{Query: "needle"}, {Query: "Compact", Fuzzy: true}, {}} {
		page, err := s.List(ctx, filter)
		if err != nil || len(page.Links) != 1 {
			t.Fatalf("list: %+v, %v", page, err)
		}
		link := page.Links[0]
		if link.Content != "" || len([]rune(link.SearchSnippet)) > 600 {
			t.Fatal("library response includes unbounded captured content")
		}
		if filter.Query == "needle" {
			if !strings.Contains(link.SearchSnippet, "\x1eneedle\x1f") {
				t.Fatalf("missing content match: %q", link.SearchSnippet)
			}
		} else if link.SearchSnippet != "" {
			t.Fatal("ordinary/fuzzy list should not carry an FTS excerpt")
		}
	}
}

func TestFiltersAndPagination(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	collection := createCollection(t, s, "Saved", nil)
	inbox := createLink(t, s, Link{URL: "https://example.com/inbox", Tags: []string{"exact"}, Favorite: true})
	filed := createLink(t, s, Link{URL: "https://example.com/filed", CollectionID: &collection, Tags: []string{"exact"}, Read: true})
	other := createLink(t, s, Link{URL: "https://example.com/other", CollectionID: &collection, Tags: []string{"exactly"}, Favorite: true})
	for _, tc := range []struct {
		name   string
		filter Filter
		ids    []int64
	}{
		{"inbox", Filter{Collection: "0"}, []int64{inbox}},
		{"collection", Filter{Collection: strconv.FormatInt(collection, 10)}, []int64{other, filed}},
		{"tag", Filter{Tag: "exact"}, []int64{filed, inbox}},
		{"favorite", Filter{Favorite: true}, []int64{other, inbox}},
		{"unread", Filter{Unread: true}, []int64{other, inbox}},
		{"combined", Filter{Tag: "exact", Favorite: true, Unread: true}, []int64{inbox}},
		{"missing", Filter{Collection: "999"}, []int64{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			page, err := s.List(ctx, tc.filter)
			if err != nil {
				t.Fatal(err)
			}
			ids := []int64{}
			for _, l := range page.Links {
				ids = append(ids, l.ID)
			}
			if page.Total != len(tc.ids) || !reflect.DeepEqual(ids, tc.ids) {
				t.Fatalf("got ids=%v total=%d, want=%v", ids, page.Total, tc.ids)
			}
		})
	}
	for i := 0; i < 42; i++ {
		createLink(t, s, Link{URL: fmt.Sprintf("https://example.com/page/%d", i)})
	}
	first, err := s.List(ctx, Filter{Page: -1})
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.List(ctx, Filter{Page: 2})
	if err != nil {
		t.Fatal(err)
	}
	last, err := s.List(ctx, Filter{Page: 3})
	if err != nil {
		t.Fatal(err)
	}
	if first.Page != 1 || first.PageSize != 40 || first.Total != 45 || len(first.Links) != 40 || second.Total != 45 || len(second.Links) != 5 || last.Total != 45 || len(last.Links) != 0 {
		t.Fatalf("bad pagination: first=%+v second=%+v last=%+v", first, second, last)
	}
	if first.Links[39].ID <= second.Links[0].ID {
		t.Fatal("pages overlap or ordering is not descending")
	}
}

func TestNormalizeAndLimits(t *testing.T) {
	zero := int64(0)
	l := Link{URL: " https://example.com/path?q=value ", Title: "  ", CollectionID: &zero, Tags: []string{" one ", "", "one", "two"}}
	if err := Normalize(&l); err != nil {
		t.Fatal(err)
	}
	if l.URL != "https://example.com/path?q=value" || l.Title != l.URL || l.CollectionID != nil || !reflect.DeepEqual(l.Tags, []string{"one", "two"}) {
		t.Fatalf("normalization: %+v", l)
	}
	for _, raw := range []string{"", "example.com", "file:///tmp/test", "javascript:alert(1)", "ftp://example.com", "http:///missing", "https://user:pass@example.com/", "https://example.com/%xx", "https://example.com/" + strings.Repeat("a", 4096)} {
		t.Run(raw[:min(len(raw), 40)], func(t *testing.T) {
			if err := Normalize(&Link{URL: raw}); err == nil {
				t.Fatalf("accepted invalid URL %q", raw)
			}
		})
	}
	valid := Link{URL: "http://example.com/", Title: strings.Repeat("t", 1024), Description: strings.Repeat("d", 8192), Notes: strings.Repeat("n", 65536), Tags: []string{strings.Repeat("x", 80)}}
	if err := Normalize(&valid); err != nil {
		t.Fatalf("exact field limits rejected: %v", err)
	}
	for _, tc := range []struct {
		name   string
		change func(*Link)
	}{
		{"title", func(l *Link) { l.Title = strings.Repeat("t", 1025) }},
		{"description", func(l *Link) { l.Description = strings.Repeat("d", 8193) }},
		{"notes", func(l *Link) { l.Notes = strings.Repeat("n", 65537) }},
		{"tag bytes", func(l *Link) { l.Tags = []string{strings.Repeat("é", 41)} }},
		{"tag count", func(l *Link) { l.Tags = make([]string, 33) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			l := Link{URL: "https://example.com/"}
			tc.change(&l)
			if err := Normalize(&l); err == nil {
				t.Fatal("over-limit field was accepted")
			}
		})
	}
}

func TestQueueRecoveryAndURLChangeRace(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "queue.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	id := createLink(t, s, Link{URL: "https://example.com/old"})
	old, err := s.Next(ctx)
	if err != nil || old.ID != id || old.Status != "processing" {
		t.Fatalf("claim: %+v %v", old, err)
	}
	if _, err := s.Next(ctx); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("second claim of running link: %v", err)
	}
	if err := s.Queue(ctx, id); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("requeued processing link: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	recovered, err := s.Next(ctx)
	if err != nil || recovered.ID != id {
		t.Fatalf("lost interrupted job: %+v %v", recovered, err)
	}
	updated := recovered
	updated.URL = "https://example.com/new"
	updated.Title = updated.URL
	if err := s.Update(ctx, id, updated); err != nil {
		t.Fatal(err)
	}
	current, err := s.Next(ctx)
	if err != nil || current.URL != updated.URL {
		t.Fatalf("new URL not queued: %+v %v", current, err)
	}
	if err := s.Finish(ctx, recovered, "Stale", "Stale", "old content", []byte("old archive"), nil); err != nil {
		t.Fatal(err)
	}
	if err := s.Finish(ctx, recovered, "", "", "", nil, errors.New("old failure")); err != nil {
		t.Fatal(err)
	}
	if got := getLink(t, s, id); got.Status != "processing" || got.Content != "" || got.ArchiveAvailable || got.Error != "" {
		t.Fatalf("stale completion changed current job: %+v", got)
	}
	if err := s.Finish(ctx, current, "Fetched title", "Fetched description", "searchable capture", []byte("archive bytes"), nil); err != nil {
		t.Fatal(err)
	}
	ready := getLink(t, s, id)
	if ready.Status != "ready" || ready.Title != "Fetched title" || ready.Description != "Fetched description" || ready.Content != "searchable capture" || !ready.ArchiveAvailable {
		t.Fatalf("completion lost fields: %+v", ready)
	}
	ready.URL = "https://example.com/third"
	if err := s.Update(ctx, id, ready); err != nil {
		t.Fatal(err)
	}
	if got := getLink(t, s, id); got.Status != "pending" || got.Content != "" || got.ArchiveAvailable {
		t.Fatalf("URL edit retained stale capture: %+v", got)
	}
	job, err := s.Next(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Finish(ctx, job, "", "", "", nil, errors.New("timeout")); err != nil {
		t.Fatal(err)
	}
	if got := getLink(t, s, id); got.Status != "failed" || got.Error != "timeout" {
		t.Fatalf("failure not recorded: %+v", got)
	}
	if err := s.Queue(ctx, id); err != nil {
		t.Fatal(err)
	}
	if got := getLink(t, s, id); got.Status != "pending" || got.Error != "" {
		t.Fatalf("retry not queued: %+v", got)
	}
}

func TestDeleteCollectionMovesLinksToInboxAndKeepsChildren(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	parent := createCollection(t, s, " Parent ", nil)
	child := createCollection(t, s, "Child", &parent)
	id := createLink(t, s, Link{URL: "https://example.com/", CollectionID: &parent})
	if err := s.DeleteCollection(ctx, parent); err != nil {
		t.Fatal(err)
	}
	if got := getLink(t, s, id); got.CollectionID != nil {
		t.Fatalf("orphaned link not in inbox: %+v", got)
	}
	collections, err := s.Collections(ctx)
	if err != nil || len(collections) != 1 || collections[0].ID != child || collections[0].ParentID != nil {
		t.Fatalf("child collection: %+v %v", collections, err)
	}
	if err := s.DeleteCollection(ctx, parent); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("delete missing collection: %v", err)
	}
	for _, name := range []string{"", "  ", strings.Repeat("x", 121)} {
		if _, err := s.AddCollection(ctx, Collection{Name: name}); err == nil {
			t.Errorf("accepted invalid collection name %q", name)
		}
	}
	missing := int64(999)
	if _, err := s.Create(ctx, Link{URL: "https://example.com/missing", CollectionID: &missing}); err == nil {
		t.Fatal("accepted link with nonexistent collection")
	}
}
