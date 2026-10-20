package store

import (
	"context"
	"errors"
	"strings"
	"testing"
)

type interruptedFile struct{}

func (interruptedFile) Read(p []byte) (int, error) {
	copy(p, "partial")
	return 7, errors.New("upload interrupted")
}
func TestFileUploadAtomicRollback(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	if e := s.InitAssets(ctx); e != nil {
		t.Fatal(e)
	}
	l := Link{URL: "pocketmark-file:" + strings.Repeat("a", 64), Title: "file.pdf"}
	if _, _, e := s.CreateFile(ctx, l, Asset{Name: "file.pdf", MediaType: "application/pdf", Kind: "pdf"}, interruptedFile{}); e == nil {
		t.Fatal("interrupted file accepted")
	}
	for _, table := range []string{"links", "assets", "asset_chunks"} {
		var n int
		if e := s.DB.QueryRow("SELECT count(*) FROM " + table).Scan(&n); e != nil || n != 0 {
			t.Fatalf("partial %s: %d %v", table, n, e)
		}
	}
	if IsFileURL("pocketmark-file:" + strings.Repeat("X", 64)) {
		t.Fatal("invalid reserved identifier accepted")
	}
	id, _, e := s.CreateFile(ctx, l, Asset{Name: "file.pdf", MediaType: "application/pdf", Kind: "pdf"}, strings.NewReader("%PDF-body"))
	if e != nil {
		t.Fatal(e)
	}
	if e = s.Bulk(ctx, BulkChange{IDs: []int64{id}, Action: "capture"}); e == nil {
		t.Fatal("file capture accepted")
	}
}
