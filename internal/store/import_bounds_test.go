package store

import (
	"context"
	"errors"
	"io"
	"path/filepath"
	"strings"
	"testing"
)

func TestJSONImportPreflightRejectsAmplificationBeforeDecoding(t *testing.T) {
	objects := strings.Repeat("{},", 10000) + "{}"
	for name, body := range map[string]string{
		"links":            `{"links":[` + objects + `]}`,
		"nested links":     `{"collections":[{"links":[` + objects + `]}]}`,
		"combined links":   `{"collections":[{"links":[{}]}],"links":[` + strings.Repeat("{},", 9999) + `{}]}`,
		"pins":             `{"links":[],"pinnedLinks":[` + objects + `]}`,
		"collections":      `{"collections":[` + strings.Repeat("{},", 2000) + `{}]}`,
		"duplicate fields": `{"links":[` + strings.Repeat("{},", 9999) + `{}],"LiNkS":[{}]}`,
		"unicode folding":  `{"link\u017f":[` + objects + `]}`,
		"tags":             `{"links":[{"tags":[` + strings.Repeat(`"x",`, 32) + `"x"]}]}`,
		"duplicate tags":   `{"links":[{"tags":[` + strings.Repeat(`"x",`, 31) + `"x"],"TAGS":["x"]}]}`,
		"depth":            `{"links":[],"unknown":` + strings.Repeat("[", 65) + `0` + strings.Repeat("]", 65) + `}`,
	} {
		t.Run(name, func(t *testing.T) {
			s := testStore(t)
			id := createLink(t, s, Link{URL: "https://example.com/keep"})
			if _, err := s.Import(context.Background(), strings.NewReader(body)); err == nil || !strings.Contains(err.Error(), "exceeds") {
				t.Fatalf("missing structural rejection: %v", err)
			}
			if got := getLink(t, s, id); got.URL != "https://example.com/keep" {
				t.Fatal("existing library changed")
			}
			assertNoImportFiles(t, s)
		})
	}
	// Three megabytes previously expanded into one million importLink structs.
	// The streaming preflight must stop near the 10,001st record, not read all.
	for _, prefix := range []string{`{"links":[`, `{"links":[],"pinnedLinks":[`, `{"links":[]} [`} {
		body := prefix + strings.Repeat("{},", 999999) + "{}]}"
		r := strings.NewReader(body)
		if err := preflightImport(r); err == nil || len(body)-r.Len() > 64<<10 {
			t.Fatalf("preflight consumed unbounded records: read=%d err=%v", len(body)-r.Len(), err)
		}
	}
}

func TestJSONImportAtStructuralLimits(t *testing.T) {
	s := testStore(t)
	// Unsupported legacy file records are skipped, but still count toward limits.
	body := `{"links":[` + strings.Repeat(`{"type":"pdf"},`, 9999) + `{"type":"pdf"}],"pinnedLinks":[` + strings.Repeat("{},", 9999) + `{}],"legacy":{"unknown":[1,true,null]}}`
	result, err := s.Import(context.Background(), strings.NewReader(body))
	if err != nil || result.Skipped != 10000 {
		t.Fatalf("limit import: %+v %v", result, err)
	}
	assertNoImportFiles(t, s)
}

func assertNoImportFiles(t *testing.T, s *Store) {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(s.directory, ".import-*"))
	if err != nil || len(files) != 0 {
		t.Fatalf("temporary imports left behind: %v %v", files, err)
	}
}

type failedImportReader struct{}

func (failedImportReader) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }

func TestImportStagingFailuresLeaveNoFilesOrChanges(t *testing.T) {
	for _, format := range []string{"json", "html"} {
		t.Run(format, func(t *testing.T) {
			s := testStore(t)
			importFile := s.Import
			if format == "html" {
				importFile = s.ImportHTML
			}
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			if _, err := importFile(ctx, strings.NewReader("")); !errors.Is(err, context.Canceled) {
				t.Fatalf("cancellation lost: %v", err)
			}
			if _, err := importFile(context.Background(), failedImportReader{}); !errors.Is(err, io.ErrUnexpectedEOF) {
				t.Fatalf("upload failure lost: %v", err)
			}
			if _, err := importFile(context.Background(), io.LimitReader(repeatedByteReader{}, (8<<20)+1)); err == nil || !strings.Contains(err.Error(), "8 MiB") {
				t.Fatalf("oversize upload: %v", err)
			}
			assertNoImportFiles(t, s)
			createLink(t, s, Link{URL: "https://example.com/after-failure"})
		})
	}
}
