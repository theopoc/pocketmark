package store

import (
	"bytes"
	"context"
	"fmt"
	"strings"
	"testing"
)

func TestNetscapeRoundTripAndRepeatedJSONImport(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	fixture := `<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><H3>Reading &amp; Books</H3><DL><p><DT><H3>Nested</H3><DL><p><DT><A HREF="https://example.com/?a=1&amp;b=2" TAGS="go,reading" ADD_DATE="1577836800">Title &amp; text</A><DD>Helpful &amp; short<DT><A HREF="javascript:alert(1)">Skip unsafe scheme</A></DL><p></DL><p><DT><A HREF="https://example.org">Inbox</A></DL>`
	result, e := s.ImportHTML(ctx, strings.NewReader(fixture))
	if e != nil || result.Imported != 2 || result.Skipped != 1 {
		t.Fatalf("%+v %v", result, e)
	}
	p, e := s.List(ctx, Filter{Query: "Helpful"})
	if e != nil || p.Total != 1 || p.Links[0].CreatedAt != "2020-01-01T00:00:00Z" || p.Links[0].Description != "Helpful & short" {
		t.Fatalf("%+v %v", p, e)
	}
	var html bytes.Buffer
	if e = s.ExportHTML(ctx, &html); e != nil {
		t.Fatal(e)
	}
	dest := testStore(t)
	r, e := dest.ImportHTML(ctx, &html)
	if e != nil || r.Imported != 2 {
		t.Fatalf("%+v %v", r, e)
	}
	var exported bytes.Buffer
	if e = s.Export(ctx, &exported); e != nil {
		t.Fatal(e)
	}
	for range 2 {
		if _, e = s.Import(ctx, bytes.NewReader(exported.Bytes())); e != nil {
			t.Fatal(e)
		}
	}
	cs, _ := s.Collections(ctx)
	if len(cs) != 2 {
		t.Fatalf("duplicate hierarchy: %+v", cs)
	}
	p, e = dest.List(ctx, Filter{Query: "Helpful"})
	if e != nil || p.Total != 1 || p.Links[0].CreatedAt != "2020-01-01T00:00:00Z" {
		t.Fatalf("timestamp not retained: %+v %v", p, e)
	}
}
func TestNetscapeImportRollback(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	fixture := fmt.Sprintf(`<DL><DT><H3>Temp</H3><DL><DT><A HREF="https://example.com">Good</A><DT><A HREF="https://example.org">%s</A></DL></DL>`, strings.Repeat("x", 1025))
	if _, e := s.ImportHTML(ctx, strings.NewReader(fixture)); e == nil {
		t.Fatal("oversize title accepted")
	}
	p, _ := s.List(ctx, Filter{})
	cs, _ := s.Collections(ctx)
	if p.Total != 0 || len(cs) != 0 {
		t.Fatal("partial import persisted")
	}
}
