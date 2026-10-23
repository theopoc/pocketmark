package store

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

func TestXBELSyncRetainsDataAndRollsBack(t *testing.T) {
	s, e := Open(filepath.Join(t.TempDir(), "test.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	ctx := context.Background()
	c, e := s.AddCollection(ctx, Collection{Name: "A & B"})
	if e != nil {
		t.Fatal(e)
	}
	id, e := s.Create(ctx, Link{URL: "https://example.org", Title: "Title", Notes: "keep notes", Tags: []string{"kept"}, Favorite: true, CollectionID: &c})
	if e != nil {
		t.Fatal(e)
	}
	var buf bytes.Buffer
	etag, e := s.ExportXBEL(ctx, &buf)
	if e != nil {
		t.Fatal(e)
	}
	input := strings.ReplaceAll(buf.String(), "Title", "Renamed")
	if e = s.ReplaceXBEL(ctx, strings.NewReader(input), etag); e != nil {
		t.Fatal(e)
	}
	l, e := s.Get(ctx, id)
	if e != nil || l.Title != "Renamed" || l.Notes != "keep notes" || !l.Favorite || len(l.Tags) != 1 {
		t.Fatalf("lost data: %+v %v", l, e)
	}
	before := l
	for _, bad := range []string{`<xbel><bookmark href="javascript:alert(1)"><title>bad</title></bookmark></xbel>`, `<xbel><folder>`, `<html/>`, `<xbel><bookmark href="https://example.org"/><bookmark href="https://example.org"/></xbel>`} {
		if e = s.ReplaceXBEL(ctx, strings.NewReader(bad), ""); e == nil {
			t.Fatalf("accepted %s", bad)
		}
	}
	l, e = s.Get(ctx, id)
	if e != nil || l.Title != before.Title {
		t.Fatal("failed sync mutated library")
	}
}

func TestXBELURLEditPreservesPersonalDataAndFiles(t *testing.T) {
	s, e := Open(filepath.Join(t.TempDir(), "test.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	ctx := context.Background()
	id, e := s.Create(ctx, Link{URL: "https://old.example", Title: "Title", Notes: "personal notes", Tags: []string{"kept"}, Favorite: true, Read: true})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.db.Exec(`UPDATE links SET content='Original text',archive=?,status='ready' WHERE id=?`, []byte("<p>Original text</p>"), id); e != nil {
		t.Fatal(e)
	}
	annotationID, e := s.SaveAnnotation(ctx, id, 0, Annotation{Quote: "Original", Start: 0, End: 8, Note: "Keep this"})
	if e != nil {
		t.Fatal(e)
	}
	asset, e := s.SaveAsset(ctx, Asset{LinkID: id, Name: "original.pdf", MediaType: "application/pdf", Kind: "pdf"}, strings.NewReader("%PDF-1.7"))
	if e != nil {
		t.Fatal(e)
	}
	fileID, e := s.Create(ctx, Link{URL: "https://file-placeholder.example", Title: "Local PDF"})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.db.Exec("UPDATE links SET url=?,status='ready' WHERE id=?", "pocketmark-file:"+strings.Repeat("a", 64), fileID); e != nil {
		t.Fatal(e)
	}
	var before bytes.Buffer
	etag, e := s.ExportXBEL(ctx, &before)
	if e != nil {
		t.Fatal(e)
	}
	if strings.Contains(before.String(), "pocketmark-file:") || strings.Contains(before.String(), "Local PDF") {
		t.Fatal("standalone file exported to browser")
	}
	if e = s.ReplaceXBEL(ctx, strings.NewReader(strings.ReplaceAll(before.String(), "https://old.example", "https://new.example")), etag); e != nil {
		t.Fatal(e)
	}
	l, e := s.Get(ctx, id)
	if e != nil {
		t.Fatal(e)
	}
	if l.URL != "https://new.example" || l.Notes != "personal notes" || !l.Favorite || !l.Read || len(l.Tags) != 1 || l.Tags[0] != "kept" {
		t.Fatalf("lost personal metadata %+v", l)
	}
	if l.Content != "" || l.ArchiveAvailable || l.Status != "pending" {
		t.Fatalf("stale capture retained %+v", l)
	}
	annotations, e := s.Annotations(ctx, id)
	if e != nil || len(annotations) != 1 || annotations[0].ID != annotationID || !annotations[0].Stale {
		t.Fatalf("annotation lost or not stale %+v %v", annotations, e)
	}
	if got, e := s.Asset(ctx, asset.ID); e != nil || got.LinkID != id {
		t.Fatalf("attachment lost %v", e)
	}
	if _, e = s.Get(ctx, fileID); e != nil {
		t.Fatal("XBEL deleted standalone file")
	}
}

func TestXBELRejectsConflictingAndInvalidIDsAtomically(t *testing.T) {
	s, e := Open(filepath.Join(t.TempDir(), "test.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	ctx := context.Background()
	first, e := s.Create(ctx, Link{URL: "https://one.example", Notes: "keep"})
	if e != nil {
		t.Fatal(e)
	}
	second, e := s.Create(ctx, Link{URL: "https://two.example"})
	if e != nil {
		t.Fatal(e)
	}
	inputs := []string{
		fmt.Sprintf(`<xbel><bookmark id="b-%d" href="https://two.example"/></xbel>`, first),
		fmt.Sprintf(`<xbel><bookmark id="b-%d" href="https://new.example"/><bookmark id="b-%d" href="https://two.example"/></xbel>`, first, first),
		`<xbel><bookmark id="b-invalid" href="https://new.example"/></xbel>`,
		`<xbel><bookmark id="b-999999" href="https://new.example"/></xbel>`,
		`<xbel><folder id="c-999999"><title>Unknown</title></folder></xbel>`,
		`<xbel><bookmark id="c-1" href="https://new.example"/></xbel>`,
		`<xbel><bookmark id="foreign" href="https://one.example"/><bookmark id="foreign" href="https://two.example"/></xbel>`,
	}
	for _, input := range inputs {
		if e = s.ReplaceXBEL(ctx, strings.NewReader(input), ""); e == nil {
			t.Fatalf("accepted ambiguous IDs %s", input)
		}
		l, e := s.Get(ctx, first)
		if e != nil || l.URL != "https://one.example" || l.Notes != "keep" {
			t.Fatalf("mutated on rejected sync %+v %v", l, e)
		}
		if _, e = s.Get(ctx, second); e != nil {
			t.Fatal("deleted on rejected sync")
		}
	}
}

func TestDAVHighestIDAndExpiredLeaseRequireFreshRead(t *testing.T) {
	s, e := Open(filepath.Join(t.TempDir(), "test.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	ctx := context.Background()
	id, e := s.Create(ctx, Link{URL: "https://example.org", Title: "Original"})
	if e != nil {
		t.Fatal(e)
	}
	var initial bytes.Buffer
	if _, e = s.ExportXBEL(ctx, &initial); e != nil {
		t.Fatal(e)
	}
	input := strings.Replace(initial.String(), "highestId :1:", "highestId :1000:", 1)
	if e = s.ReplaceXBEL(ctx, strings.NewReader(input), ""); e != nil {
		t.Fatal(e)
	}
	l, e := s.Get(ctx, id)
	if e != nil {
		t.Fatal(e)
	}
	l.Title = "Native"
	if e = s.Update(ctx, id, l); e != nil {
		t.Fatal(e)
	}
	var canonical bytes.Buffer
	if _, e = s.ExportXBEL(ctx, &canonical); e != nil {
		t.Fatal(e)
	}
	if !strings.Contains(canonical.String(), "highestId :1000:") {
		t.Fatal("deleted ID watermark lost")
	}
	if _, e = s.DAVLock(ctx, "client", true); e != nil {
		t.Fatal(e)
	}
	var snapshot bytes.Buffer
	meta, e := s.WriteDAVSnapshot(ctx, &snapshot)
	if e != nil {
		t.Fatal(e)
	}
	if e = s.ConfirmDAVRead(ctx, "client", meta.Revision); e != nil {
		t.Fatal(e)
	}
	l.Title = "Concurrent"
	if e = s.Update(ctx, id, l); e != nil {
		t.Fatal(e)
	}
	if _, e = s.db.Exec("UPDATE dav_lock SET modified=unixepoch()-1000"); e != nil {
		t.Fatal(e)
	}
	if _, e = s.DAVLockTime(ctx); !errors.Is(e, sql.ErrNoRows) {
		t.Fatalf("expired lock should appear absent: %v", e)
	}
	if e = s.StageDAV(ctx, "client", strings.NewReader(snapshot.String())); !errors.Is(e, ErrSyncConflict) {
		t.Fatalf("expired lease accepted stale tree: %v", e)
	}
	if _, e = s.DAVLock(ctx, "client", true); e != nil {
		t.Fatal(e)
	}
	if e = s.StageDAV(ctx, "client", strings.NewReader(snapshot.String())); !errors.Is(e, ErrSyncConflict) {
		t.Fatalf("reacquiring lease bypassed fresh GET: %v", e)
	}
	snapshot.Reset()
	meta, e = s.WriteDAVSnapshot(ctx, &snapshot)
	if e != nil {
		t.Fatal(e)
	}
	if e = s.ConfirmDAVRead(ctx, "client", meta.Revision); e != nil {
		t.Fatal(e)
	}
	if e = s.StageDAV(ctx, "client", strings.NewReader(snapshot.String())); e != nil {
		t.Fatalf("fresh synchronization rejected: %v", e)
	}
}
