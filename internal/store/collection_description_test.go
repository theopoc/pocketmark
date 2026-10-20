package store

import (
	"bytes"
	"context"
	"strings"
	"testing"
)

func TestCollectionDescriptionPersistsAcrossNativeRenameMoveAndJSONExport(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	description := "Synthetic collection description\nSecond paragraph."
	cid, err := s.AddCollection(ctx, Collection{Name: "Created on Android", Description: &description})
	if err != nil {
		t.Fatal(err)
	}
	parent := createCollection(t, s, "Parent", nil)
	if err = s.UpdateCollection(ctx, cid, Collection{Name: "Renamed natively", ParentID: &parent}); err != nil {
		t.Fatal(err)
	}
	cs, err := s.Collections(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range cs {
		if c.ID == cid && (c.Description == nil || *c.Description != description || c.ParentID == nil || *c.ParentID != parent) {
			t.Fatalf("native edit discarded description: %+v", c)
		}
	}
	var exported bytes.Buffer
	if err = s.Export(ctx, &exported); err != nil {
		t.Fatal(err)
	}
	restored := testStore(t)
	if _, err = restored.Import(ctx, bytes.NewReader(exported.Bytes())); err != nil {
		t.Fatal(err)
	}
	cs, err = restored.Collections(ctx)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, c := range cs {
		if c.Name == "Renamed natively" {
			found = true
			if c.Description == nil || *c.Description != description || c.ParentID == nil {
				t.Fatalf("JSON roundtrip discarded collection metadata: %+v", c)
			}
		}
	}
	if !found {
		t.Fatal("collection missing after JSON roundtrip")
	}
	empty := ""
	if err = s.UpdateCollection(ctx, cid, Collection{Name: "Cleared", Description: &empty}); err != nil {
		t.Fatal(err)
	}
	var got string
	if err = s.DB.QueryRow("SELECT description FROM collections WHERE id=?", cid).Scan(&got); err != nil || got != "" {
		t.Fatalf("explicit description clear failed: %q (%v)", got, err)
	}
}

func TestCollectionDescriptionBoundsBeforeMutation(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	limit := strings.Repeat("x", 8192)
	cid, err := s.AddCollection(ctx, Collection{Name: "Bounded", Description: &limit})
	if err != nil {
		t.Fatal(err)
	}
	tooLong := limit + "x"
	if _, err = s.AddCollection(ctx, Collection{Name: "Must not be created", Description: &tooLong}); err == nil {
		t.Fatal("oversized collection description accepted")
	}
	if err = s.UpdateCollection(ctx, cid, Collection{Name: "Must not be renamed", Description: &tooLong}); err == nil {
		t.Fatal("oversized collection edit accepted")
	}
	var name, description string
	if err = s.DB.QueryRow("SELECT name,description FROM collections WHERE id=?", cid).Scan(&name, &description); err != nil {
		t.Fatal(err)
	}
	if name != "Bounded" || description != limit {
		t.Fatal("rejected collection edit partially persisted")
	}
	var imported bytes.Buffer
	imported.WriteString(`{"collections":[{"id":1,"name":"Must not be imported","description":"` + tooLong + `"}],"links":[]}`)
	if _, err = s.Import(ctx, &imported); err == nil {
		t.Fatal("oversized imported description accepted")
	}
	var count int
	if err = s.DB.QueryRow("SELECT count(*) FROM collections").Scan(&count); err != nil || count != 1 {
		t.Fatalf("rejected create/import partially persisted: count %d (%v)", count, err)
	}
}
