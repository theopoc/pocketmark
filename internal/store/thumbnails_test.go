package store

import (
	"bytes"
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"runtime"
	"testing"
)

func TestThumbnailLegacyRestartAndURLInvalidation(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "legacy.db")
	s, err := openTestStore(t, path)
	if err != nil {
		t.Fatal(err)
	}
	id, err := s.Create(ctx, Link{URL: "https://example.com"})
	if err != nil {
		t.Fatal(err)
	}
	s.Close()

	for restart := 0; restart < 2; restart++ {
		s, err = openTestStore(t, path)
		if err != nil {
			t.Fatal(err)
		}
		if restart == 0 {
			l, err := s.Next(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if err = s.Finish(ctx, l, "title", "", "", nil, nil, []byte("cached image")); err != nil {
				t.Fatal(err)
			}
		}
		data, err := s.Thumbnail(ctx, id)
		if err != nil || !bytes.Equal(data, []byte("cached image")) {
			t.Fatalf("cache lost: %q %v", data, err)
		}
		page, err := s.List(ctx, Filter{})
		if err != nil || len(page.Links) != 1 || !page.Links[0].HasThumbnail {
			t.Fatalf("list: %+v %v", page, err)
		}
		s.Close()
	}
	s, err = openTestStore(t, path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err = s.Queue(ctx, id); err != nil {
		t.Fatal(err)
	}
	l, err := s.Next(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.Exec("UPDATE links SET url='https://other.example' WHERE id=$1", id); err != nil {
		t.Fatal(err)
	}
	if err = s.Finish(ctx, l, "", "", "", nil, nil, []byte("stale")); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Thumbnail(ctx, id); err != sql.ErrNoRows {
		t.Fatalf("stale thumbnail survived: %v", err)
	}
}

func BenchmarkThumbnailCache(b *testing.B) {
	for _, cached := range []bool{false, true} {
		name := "metadata"
		if cached {
			name = "images"
		}
		b.Run(name, func(b *testing.B) {
			s, err := openTestStore(b, filepath.Join(b.TempDir(), "cache.db"))
			if err != nil {
				b.Fatal(err)
			}
			defer s.Close()
			ctx := context.Background()
			payload := bytes.Repeat([]byte("x"), 512<<10)
			for i := 0; i < 40; i++ {
				_, err := s.Create(ctx, Link{URL: fmt.Sprintf("https://example.com/%d", i)})
				if err != nil {
					b.Fatal(err)
				}
				l, err := s.Next(ctx)
				if err != nil {
					b.Fatal(err)
				}
				var thumbnail []byte
				if cached {
					thumbnail = payload
				}
				if err = s.Finish(ctx, l, "", "", "", nil, nil, thumbnail); err != nil {
					b.Fatal(err)
				}
			}
			payload = nil
			runtime.GC()
			b.ResetTimer()
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				p, err := s.List(ctx, Filter{})
				if err != nil {
					b.Fatal(err)
				}
				if cached {
					for _, l := range p.Links {
						data, err := s.Thumbnail(ctx, l.ID)
						if err != nil || len(data) != 512<<10 {
							b.Fatal(err)
						}
					}
				}
			}
		})
	}
}
