package store

import (
	"bytes"
	"context"
	"io"
	"path/filepath"
	"testing"
	"time"
)

type repeatedByteReader struct{}
type assetWriterFunc func([]byte) (int, error)

func (f assetWriterFunc) Write(p []byte) (int, error) { return f(p) }

func (repeatedByteReader) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = 'x'
	}
	return len(p), nil
}

func TestAssetStreamingRollbackAndCascade(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "assets.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	linkID, err := s.Create(ctx, Link{URL: "https://example.com"})
	if err != nil {
		t.Fatal(err)
	}
	body := bytes.Repeat([]byte("abc"), 50000)
	a, err := s.SaveAsset(ctx, Asset{LinkID: linkID, Name: "page.html", MediaType: "text/html", Kind: "html"}, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err = s.WriteAsset(ctx, a.ID, &out); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(out.Bytes(), body) || a.Size != int64(len(body)) {
		t.Fatal("asset content changed")
	}
	deadline, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if err = s.WriteAsset(deadline, a.ID, assetWriterFunc(func(p []byte) (int, error) {
		var count int
		e := s.db.QueryRowContext(deadline, "SELECT count(*) FROM links").Scan(&count)
		return len(p), e
	})); err != nil {
		t.Fatalf("download retained sole SQLite connection: %v", err)
	}
	_, err = s.SaveAsset(ctx, Asset{LinkID: linkID, Name: "too-large.pdf", MediaType: "application/pdf", Kind: "pdf"}, io.LimitReader(repeatedByteReader{}, MaxAssetSize+1))
	if err == nil {
		t.Fatal("oversize asset accepted")
	}
	assets, err := s.Assets(ctx, linkID)
	if err != nil || len(assets) != 1 {
		t.Fatalf("partial asset retained: %v %v", assets, err)
	}
	if err = s.Delete(ctx, linkID); err != nil {
		t.Fatal(err)
	}
	var count int
	if err = s.db.QueryRow("SELECT count(*) FROM asset_chunks").Scan(&count); err != nil || count != 0 {
		t.Fatalf("orphaned chunks %d %v", count, err)
	}
}

func TestAssetCountLimit(t *testing.T) {
	s, e := Open(filepath.Join(t.TempDir(), "assets.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	ctx := context.Background()
	id, e := s.Create(ctx, Link{URL: "https://example.com"})
	if e != nil {
		t.Fatal(e)
	}
	for i := 0; i < 33; i++ {
		_, e = s.SaveAsset(ctx, Asset{LinkID: id, Name: "a.html", MediaType: "text/html", Kind: "html"}, bytes.NewBufferString("a"))
		if i < 32 && e != nil {
			t.Fatal(e)
		}
		if i == 32 && e == nil {
			t.Fatal("attachment count unbounded")
		}
	}
}
