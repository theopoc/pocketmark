package store

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"pocketmark/internal/pgtest"
	"strings"
	"testing"
	"time"
)

func openTestStore(t testing.TB, path string) (*Store, error) {
	t.Helper()
	return Open(pgtest.URL(t, path), pgtest.Directory(path))
}

func restoreTestStore(t testing.TB, path string) (*Store, error) {
	return Open(pgtest.Restore(t, path), pgtest.Directory(path))
}

func TestConcurrentAccountEnrollmentAndAttachmentLimit(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	if err := s.SaveAccount(ctx, Account{Username: "owner", Salt: "salt", Hash: "hash"}); err != nil {
		t.Fatal(err)
	}
	race := func(write func(int) error) []error {
		start := make(chan struct{})
		result := make(chan error, 8)
		for i := range 8 {
			go func() { <-start; result <- write(i) }()
		}
		close(start)
		var failures []error
		for range 8 {
			if err := <-result; err != nil {
				failures = append(failures, err)
			}
		}
		return failures
	}
	failed := race(func(i int) error {
		key := fmt.Sprintf("test-%d", i)
		if err := s.CreateMFAChallenge(ctx, key, MFAChallenge{Kind: "enroll", Salt: "salt"}); err != nil {
			return err
		}
		return s.ActivateMFA(ctx, key, "salt", 0, 1, []byte{1}, nil, "", fmt.Sprintf("session-%d", i), time.Now().Add(time.Hour), "test", false)
	})
	if len(failed) != 7 {
		t.Fatalf("enrollment must have one winner: %v", failed)
	}
	for _, err := range failed {
		if !errors.Is(err, ErrMFAChanged) {
			t.Fatal(err)
		}
	}
	id := createLink(t, s, Link{URL: "https://example.test/concurrent"})
	save := func(int) error {
		_, err := s.SaveAsset(ctx, Asset{LinkID: id, Name: "file.pdf", MediaType: "application/pdf", Kind: "pdf"}, strings.NewReader("pdf"))
		return err
	}
	for range 31 {
		if err := save(0); err != nil {
			t.Fatal(err)
		}
	}
	if failed := race(save); len(failed) != 7 {
		t.Fatalf("attachment quota must have one remaining slot: %v", failed)
	}
	files, err := s.Assets(ctx, id)
	if err != nil || len(files) != 32 {
		t.Fatalf("persisted attachments=%d, err=%v", len(files), err)
	}
}

func TestUnicodeSearchAndExplicitXBELIdentity(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	xml := `<xbel><bookmark href="https://example.test/first"><title>東京 Книга</title></bookmark><bookmark id="1" href="https://example.test/second"><title>Test</title></bookmark></xbel>`
	if err := s.ApplyDAV(ctx, "client", strings.NewReader(xml), "", ""); err != nil {
		t.Fatal(err)
	}
	createLink(t, s, Link{URL: "https://test.example.org/third", Title: "Unrelated"})
	urlMatch, err := s.List(ctx, Filter{Query: "third"})
	if err != nil || len(urlMatch.Links) != 1 || !strings.Contains(urlMatch.Links[0].SearchSnippet, "\x1ethird\x1f") {
		t.Fatalf("URL highlight: %+v %v", urlMatch, err)
	}
	domainMatch, err := s.List(ctx, Filter{Query: "example"})
	if err != nil || len(domainMatch.Links) == 0 || !strings.Contains(domainMatch.Links[0].SearchSnippet, "\x1eexample\x1f") {
		t.Fatalf("host highlight: %+v %v", domainMatch, err)
	}
	var snapshot bytes.Buffer
	if _, err := s.WriteDAVSnapshot(ctx, &snapshot); err != nil {
		t.Fatal(err)
	}
	canonical, err := s.WriteDAVSnapshot(ctx, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	additional := strings.Replace(snapshot.String(), "</xbel>", `<bookmark id="123" href="https://example.test/fourth"><title>Fourth</title></bookmark></xbel>`, 1)
	if err = s.ApplyDAV(ctx, "client", strings.NewReader(additional), canonical.ETag, ""); err != nil {
		t.Fatal("valid If-Match with new identity rejected", err)
	}
	snapshot.Reset()
	if _, err = s.WriteDAVSnapshot(ctx, &snapshot); err != nil {
		t.Fatal(err)
	}
	before := snapshot.String()
	bad := `<xbel><!-- highestId :9999: --><bookmark id="b-9241" href="https://example.test/invalid"/></xbel>`
	if err := s.ApplyDAV(ctx, "client", strings.NewReader(bad), "", ""); err == nil {
		t.Fatal("unknown identity accepted")
	}
	snapshot.Reset()
	if _, err := s.WriteDAVSnapshot(ctx, &snapshot); err != nil || before != snapshot.String() {
		t.Fatalf("rejected XBEL changed public snapshot: %v", err)
	}
	for _, filter := range []Filter{{Query: "東京"}, {Query: "КНИГА"}, {Query: "кника", Fuzzy: true}} {
		p, err := s.List(ctx, filter)
		if err != nil || len(p.Links) != 1 || p.Links[0].URL != "https://example.test/first" {
			t.Fatalf("query %q: %v (%v)", filter.Query, p, err)
		}
		if filter.Query == "КНИГА" && !strings.Contains(p.Links[0].SearchSnippet, "\x1eКнига\x1f") {
			t.Errorf("original Unicode highlight missing: %q", p.Links[0].SearchSnippet)
		}
	}
}
