package store

import (
	"context"
	"testing"
)

func TestCollectionMovesRejectCycles(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	a := createCollection(t, s, "A", nil)
	b := createCollection(t, s, "B", &a)
	if e := s.UpdateCollection(ctx, a, Collection{Name: "cycle", ParentID: &b}); e == nil {
		t.Fatal("cycle accepted")
	}
	if e := s.UpdateCollection(ctx, b, Collection{Name: "Renamed"}); e != nil {
		t.Fatal(e)
	}
	if e := s.UpdateCollection(ctx, a, Collection{Name: "A", ParentID: &b}); e != nil {
		t.Fatal(e)
	}
	cs, _ := s.Collections(ctx)
	if len(cs) != 2 {
		t.Fatal(cs)
	}
}
func TestBulkAtomicAndSearchSort(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	a := createLink(t, s, Link{URL: "https://example.com/a", Title: "Zebra browser"})
	b := createLink(t, s, Link{URL: "https://example.com/b", Title: "Alpine"})
	if e := s.Bulk(ctx, BulkChange{IDs: []int64{a, 9999}, Action: "favorite", Value: true}); e == nil {
		t.Fatal("missing id accepted")
	}
	if getLink(t, s, a).Favorite {
		t.Fatal("partial bulk committed")
	}
	if e := s.Bulk(ctx, BulkChange{IDs: []int64{a, b}, Action: "tags", Tags: []string{"shared"}}); e != nil {
		t.Fatal(e)
	}
	p, e := s.List(ctx, Filter{Sort: "title", Tag: "shared"})
	if e != nil || p.Total != 2 || p.Links[0].ID != b {
		t.Fatalf("%+v %v", p, e)
	}
	p, e = s.List(ctx, Filter{Query: "browzer", Fuzzy: true})
	if e != nil || p.Total != 1 || p.Links[0].ID != a {
		t.Fatalf("%+v %v", p, e)
	}
	if e := s.Bulk(ctx, BulkChange{IDs: []int64{a, a}, Action: "delete"}); e == nil {
		t.Fatal("duplicate id accepted")
	}
	if _, e := s.Get(ctx, a); e != nil {
		t.Fatal("rolled back delete lost link")
	}
}
func TestAnnotationsAnchorUnicodeStaleAndCascade(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	id := createLink(t, s, Link{URL: "https://example.com"})
	_, e := s.db.Exec("UPDATE links SET content=? WHERE id=?", "A 😀 café article", id)
	if e != nil {
		t.Fatal(e)
	}
	a := Annotation{Quote: "😀 café", Start: 2, End: 8, Note: "Remember", Color: "green"}
	aid, e := s.SaveAnnotation(ctx, id, 0, a)
	if e != nil {
		t.Fatal(e)
	}
	a.Start = 3
	if _, e = s.SaveAnnotation(ctx, id, 0, a); e == nil {
		t.Fatal("bad anchor accepted")
	}
	list, e := s.Annotations(ctx, id)
	if e != nil || len(list) != 1 || list[0].Stale {
		t.Fatalf("%+v %v", list, e)
	}
	_, _ = s.db.Exec("UPDATE links SET content='changed' WHERE id=?", id)
	list, e = s.Annotations(ctx, id)
	if e != nil || !list[0].Stale {
		t.Fatal("stale anchor not identified")
	}
	if e = s.DeleteAnnotation(ctx, id+1, aid); e == nil {
		t.Fatal("cross-link delete accepted")
	}
	if e = s.Delete(ctx, id); e != nil {
		t.Fatal(e)
	}
	var count int
	_ = s.db.QueryRow("SELECT count(*) FROM annotations").Scan(&count)
	if count != 0 {
		t.Fatal("annotation not cascade deleted")
	}
}
