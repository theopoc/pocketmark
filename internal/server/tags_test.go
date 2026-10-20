package server

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"pocketmark/internal/store"
)

func TestBrowseAllTagsBeyondSidebarLimit(t *testing.T) {
	a := newTestServer(t, "", false)
	for batch := 0; batch < 7; batch++ {
		tags := []string{"shared"}
		for i := batch * 30; i < (batch+1)*30 && i < 205; i++ {
			tags = append(tags, fmt.Sprintf("tag-%03d", i))
		}
		if _, err := a.Store.Create(context.Background(), store.Link{URL: fmt.Sprintf("https://example.org/%d", batch), Tags: tags}); err != nil {
			t.Fatal(err)
		}
	}
	type result struct {
		Tags []struct {
			Name  string
			Count int
		}
		Total, Page, PageSize int
	}
	get := func(path string) result {
		t.Helper()
		w := request(a, "GET", path, "", true, nil)
		requireStatus(t, w, 200)
		var out result
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	requireStatus(t, request(a, "GET", "/api/tags/browse", "", false, nil), 401)
	first := get("/api/tags/browse")
	if first.Total != 206 || first.PageSize != 40 || len(first.Tags) != 40 || first.Tags[0].Name != "shared" || first.Tags[0].Count != 7 {
		t.Fatalf("unexpected first page: %+v", first)
	}
	last := get("/api/tags/browse?page=6")
	if len(last.Tags) != 6 || last.Tags[5].Name != "tag-204" {
		t.Fatalf("missing tags after sidebar cutoff: %+v", last)
	}
	found := get("/api/tags/browse?q=TAG-20")
	if found.Total != 5 || found.Tags[4].Name != "tag-204" || found.Tags[4].Count != 1 {
		t.Fatalf("unexpected search: %+v", found)
	}
	if empty := get("/api/tags/browse?q=%25"); empty.Total != 0 || len(empty.Tags) != 0 {
		t.Fatalf("wildcard treated as pattern: %+v", empty)
	}
	w := request(a, "GET", "/api/tags", "", true, nil)
	var sidebar []any
	requireStatus(t, w, 200)
	if err := json.Unmarshal(w.Body.Bytes(), &sidebar); err != nil || len(sidebar) != 200 {
		t.Fatal("sidebar contract changed")
	}
	for _, path := range []string{"/api/tags/browse?page=0", "/api/tags/browse?page=bad", "/api/tags/browse?page=1000001", "/api/tags/browse?jump=AB", "/api/tags/browse?jump=1", "/api/tags/browse?q=" + strings.Repeat("x", 513)} {
		requireStatus(t, request(a, "GET", path, "", true, nil), 400)
	}
}

func TestTagLetterJumpAcrossPages(t *testing.T) {
	a := newTestServer(t, "", false)
	tags := []string{"zebra", "Zinc", "écriture", "123", "日本語"}
	for i := 0; i < 85; i++ {
		tags = append(tags, fmt.Sprintf("alpha-%03d", i))
	}
	for start := 0; start < len(tags); start += 30 {
		end := min(start+30, len(tags))
		if _, err := a.Store.Create(context.Background(), store.Link{URL: fmt.Sprintf("https://example.org/index/%d", start), Tags: tags[start:end]}); err != nil {
			t.Fatal(err)
		}
	}
	type result struct {
		Tags []struct {
			Name, Letter string
			Count        int
		}
		Groups []struct {
			Letter string
			Count  int
		}
		Total, Page int
	}
	get := func(path string) result {
		t.Helper()
		w := request(a, "GET", path, "", true, nil)
		requireStatus(t, w, 200)
		var out result
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	jump := get("/api/tags/browse?jump=z")
	if jump.Page != 3 || jump.Total != 90 || len(jump.Groups) != 3 || jump.Groups[0].Letter != "A" || jump.Groups[0].Count != 85 || jump.Groups[1].Letter != "Z" || jump.Groups[1].Count != 2 || jump.Groups[2].Letter != "#" || jump.Groups[2].Count != 3 {
		t.Fatalf("unexpected jump or global groups: %+v", jump)
	}
	if len(jump.Tags) != 10 || jump.Tags[5].Letter != "Z" || jump.Tags[5].Name != "zebra" || jump.Tags[7].Letter != "#" {
		t.Fatalf("target letter not on the resolved page: %+v", jump.Tags)
	}
	other := get("/api/tags/browse?jump=%23")
	if other.Page != 3 || other.Tags[len(other.Tags)-1].Letter != "#" {
		t.Fatalf("other characters missing: %+v", other)
	}
	filtered := get("/api/tags/browse?q=z&jump=Z")
	if filtered.Page != 1 || filtered.Total != 2 || len(filtered.Groups) != 1 || filtered.Groups[0].Letter != "Z" || filtered.Groups[0].Count != 2 {
		t.Fatalf("letter counts did not follow search: %+v", filtered)
	}
	missing := get("/api/tags/browse?jump=B")
	if missing.Page != 1 || missing.Tags[0].Name != "alpha-000" {
		t.Fatalf("missing letter should retain the page: %+v", missing)
	}
}
