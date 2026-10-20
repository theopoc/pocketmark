package store

import (
	"bytes"
	"context"
	"strings"
	"testing"
)

func TestLongURLPlaceholderEditAndExportRoundTrip(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	const prefix = "https://example.com/"
	rawURL := prefix + strings.Repeat("a", 1500-len(prefix))
	id := createLink(t, s, Link{URL: rawURL})
	l := getLink(t, s, id)
	if l.Title != rawURL || len(l.Title) != 1500 {
		t.Fatalf("long URL placeholder lost: title length=%d", len(l.Title))
	}
	l.Notes = "Keep this long bookmark"
	l.Favorite = true
	if err := s.Update(ctx, id, l); err != nil {
		t.Fatalf("editing fetched long-URL bookmark: %v", err)
	}
	var exported bytes.Buffer
	if err := s.Export(ctx, &exported); err != nil {
		t.Fatal(err)
	}
	restored := testStore(t)
	result, err := restored.Import(ctx, &exported)
	if err != nil || result.Imported != 1 || result.Skipped != 0 {
		t.Fatalf("reimport long-URL placeholder: %+v, %v", result, err)
	}
	page, err := restored.List(ctx, Filter{})
	if err != nil || len(page.Links) != 1 {
		t.Fatalf("restored links: %+v, %v", page, err)
	}
	got := page.Links[0]
	if got.URL != rawURL || got.Title != rawURL || got.Notes != l.Notes || !got.Favorite {
		t.Fatal("long URL, placeholder or user metadata did not round-trip")
	}

	// The exception must retain the exact placeholder so capture can replace it.
	job, err := restored.Next(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := restored.Finish(ctx, job, "Captured readable title", "Captured description", "Captured text", []byte("<p>Captured text</p>"), nil); err != nil {
		t.Fatal(err)
	}
	ready := getLink(t, restored, job.ID)
	if ready.Title != "Captured readable title" || ready.Description != "Captured description" || ready.Status != "ready" || !ready.ArchiveAvailable || ready.URL != rawURL || ready.Notes != l.Notes || !ready.Favorite {
		t.Fatalf("capture did not replace the URL placeholder while keeping metadata: %+v", ready)
	}
}
