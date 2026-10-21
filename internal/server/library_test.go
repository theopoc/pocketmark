package server

import (
	"context"
	"fmt"
	"pocketmark/internal/store"
	"strings"
	"testing"
)

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
	_, _ = a.Store.DB.Exec("UPDATE links SET content='Sample text' WHERE id=?", id)
	requireStatus(t, request(a, "POST", fmt.Sprintf("/api/links/%d/annotations", id), `{"quote":"Sample","start":0,"end":6,"note":"Useful","color":"blue"}`, true, nil), 200)
	w := request(a, "GET", fmt.Sprintf("/api/links/%d/annotations", id), "", true, nil)
	requireStatus(t, w, 200)
	if !strings.Contains(w.Body.String(), `"quote":"Sample"`) {
		t.Fatal(w.Body.String())
	}
}
