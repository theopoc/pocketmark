package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestImportLegacyHierarchyTagsPinsAndDuplicates(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	// Child precedes parent, and existing local IDs differ from export IDs.
	createCollection(t, s, "Existing", nil)
	createLink(t, s, Link{URL: "https://example.com/duplicate", Title: "Keep local"})
	fixture := `{
		"username":"upstream-user",
		"collections":[
			{"id":11,"parentId":10,"name":"Systems","color":"#0ea5e9","rssSubscriptions":[],"links":[
				{"id":42,"name":"Article","url":"https://example.com/article","description":"Details","createdAt":"2020-01-01T00:00:00Z","tags":[{"id":7,"name":"go","ownerId":2},{"name":" read "}]},
				{"id":43,"name":"Duplicate","url":"https://example.com/duplicate","tags":[]},
				{"id":44,"name":"Uploaded PDF","type":"pdf","url":null,"tags":[]}
			]},
			{"id":10,"parentId":null,"name":"Reading","links":[]}
		],
		"pinnedLinks":[{"id":42,"url":"https://example.com/article","monolith":"archives/11/42.html"}]
	}`
	result, err := s.Import(ctx, strings.NewReader(fixture))
	if err != nil || result.Imported != 1 || result.Skipped != 2 {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	collections, err := s.Collections(ctx)
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]Collection{}
	for _, c := range collections {
		byName[c.Name] = c
	}
	child := byName["Systems"]
	if child.ParentID == nil || *child.ParentID != byName["Reading"].ID {
		t.Fatalf("parent IDs not remapped: %+v", collections)
	}
	page, err := s.List(ctx, Filter{Query: "Article"})
	if err != nil || page.Total != 1 {
		t.Fatalf("imported article not searchable: %+v %v", page, err)
	}
	l := page.Links[0]
	if l.Title != "Article" || l.Description != "Details" || l.CollectionID == nil || *l.CollectionID != child.ID || !l.Favorite || !reflect.DeepEqual(l.Tags, []string{"go", "read"}) || l.ArchiveAvailable {
		t.Fatalf("imported data mismatch: %+v", l)
	}
	all, err := s.List(ctx, Filter{})
	if err != nil || all.Total != 2 {
		t.Fatalf("bad total after import: %+v %v", all, err)
	}
	for _, l := range all.Links {
		if l.URL == "https://example.com/duplicate" && l.Title != "Keep local" {
			t.Fatal("duplicate import overwrote existing link")
		}
	}
}

func TestImportRollsBackWholeDocument(t *testing.T) {
	for _, tc := range []struct {
		name string
		data string
	}{
		{"invalid URL after valid record", `{"collections":[{"id":1,"name":"Temporary","links":[{"url":"https://example.com/good"},{"url":"file:///etc/passwd"}]}]}`},
		{"missing parent", `{"collections":[{"id":1,"name":"Temporary","parentId":999,"links":[]}]}`},
		{"cycle", `{"collections":[{"id":1,"name":"A","parentId":2},{"id":2,"name":"B","parentId":1}]}`},
		{"self parent", `{"collections":[{"id":1,"name":"A","parentId":1}]}`},
		{"duplicate collection ID", `{"collections":[{"id":1,"name":"A"},{"id":1,"name":"B"}]}`},
		{"missing link collection", `{"collections":[{"id":1,"name":"A"}],"links":[{"url":"https://example.com/good"},{"url":"https://example.com/bad","collectionId":999}]}`},
		{"invalid tag after valid record", `{"links":[{"url":"https://example.com/good"},{"url":"https://example.com/bad","tags":[42]}]}`},
		{"unsupported version", `{"format":"pocketmark","version":2,"links":[]}`},
		{"unknown format", `{"format":"other","version":1,"links":[]}`},
		{"two documents", `{"links":[]} {"links":[]}`},
		{"trailing garbage", `{"links":[]} garbage`},
		{"unrecognized shape", `{"hello":"world"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := testStore(t)
			ctx := context.Background()
			keep := createCollection(t, s, "Keep", nil)
			id := createLink(t, s, Link{URL: "https://example.com/existing", CollectionID: &keep})
			if _, err := s.Import(ctx, strings.NewReader(tc.data)); err == nil {
				t.Fatal("invalid import succeeded")
			}
			page, err := s.List(ctx, Filter{})
			if err != nil || page.Total != 1 || len(page.Links) != 1 || page.Links[0].ID != id {
				t.Fatalf("partial import persisted: %+v %v", page, err)
			}
			collections, err := s.Collections(ctx)
			if err != nil || len(collections) != 1 || collections[0].ID != keep {
				t.Fatalf("partial collections persisted: %+v %v", collections, err)
			}
		})
	}
}

func TestExportRoundTripMetadataWithoutCapture(t *testing.T) {
	source := testStore(t)
	ctx := context.Background()
	parent := createCollection(t, source, "Parent", nil)
	child := createCollection(t, source, "Child", &parent)
	id := createLink(t, source, Link{URL: "https://example.com/roundtrip", Title: "A title", Description: "Description", Notes: "First line\nSecond line", CollectionID: &child, Tags: []string{"go", "café"}, Favorite: true, Read: true})
	createLink(t, source, Link{URL: "https://example.com/inbox", Notes: "Inbox note"})
	job, err := source.Next(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := source.Finish(ctx, job, "Fetched title", "Fetched description", "captured secret content", []byte("captured archive bytes"), nil); err != nil {
		t.Fatal(err)
	}
	want := getLink(t, source, id)
	var exported bytes.Buffer
	if err := source.Export(ctx, &exported); err != nil {
		t.Fatal(err)
	}
	if !json.Valid(exported.Bytes()) {
		t.Fatalf("invalid export: %s", exported.String())
	}
	if strings.Contains(exported.String(), "captured secret content") || strings.Contains(exported.String(), "captured archive bytes") {
		t.Fatal("metadata export contains captured content")
	}
	dest := testStore(t)
	createCollection(t, dest, "Existing", nil)
	result, err := dest.Import(ctx, &exported)
	if err != nil || result.Imported != 2 || result.Skipped != 0 {
		t.Fatalf("round trip import: %+v %v", result, err)
	}
	page, err := dest.List(ctx, Filter{Query: "roundtrip"})
	if err != nil || page.Total != 1 {
		t.Fatalf("round trip link: %+v %v", page, err)
	}
	got := getLink(t, dest, page.Links[0].ID)
	if got.URL != want.URL || got.Title != want.Title || got.Description != want.Description || got.Notes != want.Notes || got.Favorite != want.Favorite || got.Read != want.Read || !reflect.DeepEqual(got.Tags, want.Tags) {
		t.Fatalf("metadata changed:\ngot  %+v\nwant %+v", got, want)
	}
	if got.ArchiveAvailable || got.Content != "" || got.Status != "pending" {
		t.Fatalf("import claimed to restore archive: %+v", got)
	}
	collections, err := dest.Collections(ctx)
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]Collection{}
	for _, c := range collections {
		byName[c.Name] = c
	}
	if got.CollectionID == nil || *got.CollectionID != byName["Child"].ID || byName["Child"].ParentID == nil || *byName["Child"].ParentID != byName["Parent"].ID {
		t.Fatalf("round trip hierarchy lost: %+v link=%+v", collections, got)
	}
	inbox, err := dest.List(ctx, Filter{Collection: "0"})
	if err != nil || inbox.Total != 1 || inbox.Links[0].Notes != "Inbox note" {
		t.Fatalf("round trip inbox: %+v %v", inbox, err)
	}
}

type failingWriter struct{}

func (failingWriter) Write([]byte) (int, error) { return 0, errors.New("disk full") }

func TestExportPropagatesWriteFailureAndReleasesTransaction(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	if err := s.Export(ctx, failingWriter{}); err == nil || !strings.Contains(err.Error(), "disk full") {
		t.Fatalf("lost write error: %v", err)
	}
	createLink(t, s, Link{URL: "https://example.com/after-error"})
}
