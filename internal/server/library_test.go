package server

import (
	"context"
	"encoding/json"
	"fmt"
	"pocketmark/internal/store"
	"strings"
	"testing"
)

func TestBookmarkTagFilters(t *testing.T) {
	a := newTestServer(t, "", false)
	for _, link := range []store.Link{
		{URL: "https://example.com/both", Tags: []string{"Go", "C++, notes"}, Favorite: true},
		{URL: "https://example.com/go", Tags: []string{"Go"}, Favorite: true},
		{URL: "https://example.com/notes", Tags: []string{"C++, notes"}},
	} {
		if _, err := a.Store.Create(t.Context(), link); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		query string
		total int
		count int
	}{
		{"tag=", 3, 3},
		{"tag=Go", 2, 2},
		{"tag=&tag=Go&tag=Go", 2, 2},
		{"tag=Go&tag=C%2B%2B%2C+notes", 1, 1},
		{"tag=Go&tag=C%2B%2B%2C+notes&favorite=1&q=both", 1, 1},
		{"tag=C%2B%2B%2C+notes&tag=Go&page=2", 1, 0},
		{"tag=Go&tag=go", 2, 2},
	} {
		w := request(a, "GET", "/api/links?"+tc.query, "", true, nil)
		requireStatus(t, w, 200)
		var page store.Page
		if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil {
			t.Fatal(err)
		}
		if page.Total != tc.total || len(page.Links) != tc.count {
			t.Errorf("%s: want total %d and %d links, got %+v", tc.query, tc.total, tc.count, page)
		}
	}
}

func TestLibraryHTTPBulkAndHTML(t *testing.T) {
	a := newTestServer(t, "", false)
	c, e := a.Store.AddCollection(context.Background(), store.Collection{Name: "Before"})
	if e != nil {
		t.Fatal(e)
	}
	requireStatus(t, request(a, "PUT", fmt.Sprintf("/api/collections/%d", c), `{"name":"After","parentId":null}`, true, nil), 200)
	fixture := `<DL><DT><A HREF="https://example.com">Bookmark</A></DL>`
	requireStatus(t, request(a, "POST", "/api/import/html", fixture, true, nil), 200)
	p, _ := a.Store.List(context.Background(), store.Filter{})
	id := p.Links[0].ID
	requireStatus(t, request(a, "POST", "/api/links/bulk", fmt.Sprintf(`{"ids":[%d],"action":"favorite","value":true}`, id), true, nil), 200)
	requireStatus(t, request(a, "GET", "/api/export/html", "", true, nil), 200)
	finishTestCapture(t, a.Store, id, "Sample text", nil)
	requireStatus(t, request(a, "POST", fmt.Sprintf("/api/links/%d/annotations", id), `{"quote":"Sample","start":0,"end":6,"note":"Useful","color":"blue"}`, true, nil), 200)
	w := request(a, "GET", fmt.Sprintf("/api/links/%d/annotations", id), "", true, nil)
	requireStatus(t, w, 200)
	if !strings.Contains(w.Body.String(), `"quote":"Sample"`) {
		t.Fatal(w.Body.String())
	}
}
