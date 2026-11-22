package store

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"strings"
	"testing"
)

func TestAITagMetadataRoundTrips(t *testing.T) {
	ctx := t.Context()
	source := testStore(t)
	privateURL := "https://private.example"
	id := createLink(t, source, Link{URL: privateURL, Description: "Owner description"})
	if err := source.IndexDocument(ctx, id, privateURL, "Private title", "Private description", "Private body"); err != nil {
		t.Fatal(err)
	}
	createLink(t, source, Link{URL: "https://public.example", Title: "Owner title", Description: "Owner description"})
	for _, format := range []string{"json", "html", "xbel"} {
		t.Run(format, func(t *testing.T) {
			dest := testStore(t)
			var buf bytes.Buffer
			var err error
			switch format {
			case "json":
				if err = source.Export(ctx, &buf); err == nil {
					_, err = dest.Import(ctx, &buf)
				}
			case "html":
				if err = source.ExportHTML(ctx, &buf); err == nil {
					_, err = dest.ImportHTML(ctx, &buf)
				}
			case "xbel":
				if _, err = source.WriteDAVSnapshot(ctx, &buf); err == nil {
					err = dest.ApplyDAV(ctx, "browser", bytes.NewReader(buf.Bytes()), "", "")
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			createLink(t, dest, Link{URL: "https://seed.example", Tags: []string{"tag"}})
			if err = dest.SetAITagModel(ctx, "test"); err != nil {
				t.Fatal(err)
			}
			if err = dest.SetAITagEnabled(ctx, true); err != nil {
				t.Fatal(err)
			}
			if err = dest.StartAITagScan(ctx); err != nil {
				t.Fatal(err)
			}
			for range 2 {
				j, err := dest.NextAITagJob(ctx, false)
				if err != nil {
					t.Fatal(err)
				}
				link := getLink(t, dest, j.ID)
				if j.Domain == "private.example" {
					if link.Title != "Private title" || j.Title != "" {
						t.Fatalf("reimported private title: %q / job %+v", link.Title, j)
					}
				} else if j.Title != "Owner title" {
					t.Fatalf("public title lost: %+v", j)
				}
				if j.Description != "Owner description" || j.Excerpt != "" {
					t.Fatalf("wrong exported fields %+v", j)
				}
				if err = dest.FinishAITagJob(ctx, j, nil); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}

func TestAITagLegacyProvenance(t *testing.T) {
	s := testStore(t)
	ctx := t.Context()
	_, err := s.Import(ctx, strings.NewReader(`{"format":"pocketmark","version":1,"links":[{"url":"https://legacy-json.example","title":"Old title"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.ImportHTML(ctx, strings.NewReader(`<TITLE>Pocketmark bookmarks</TITLE><DL><DT><A HREF="https://legacy-html.example">Old title</A></DL>`))
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.ImportHTML(ctx, strings.NewReader(`<TITLE>Bookmarks</TITLE><DL><DT><A HREF="https://browser.example">Browser title</A></DL>`))
	if err != nil {
		t.Fatal(err)
	}
	createLink(t, s, Link{URL: "https://seed.example", Tags: []string{"tag"}})
	if err = s.SetAITagModel(ctx, "test"); err != nil {
		t.Fatal(err)
	}
	if err = s.SetAITagEnabled(ctx, true); err != nil {
		t.Fatal(err)
	}
	if err = s.StartAITagScan(ctx); err != nil {
		t.Fatal(err)
	}
	for range 3 {
		j, err := s.NextAITagJob(ctx, false)
		if err != nil {
			t.Fatal(err)
		}
		if j.Domain == "browser.example" {
			if j.Title != "Browser title" {
				t.Fatalf("generic owner metadata omitted %+v", j)
			}
		} else if j.Title != "" || getLink(t, s, j.ID).Title != "Old title" {
			t.Fatalf("unknown-provenance metadata %+v", j)
		}
		if err = s.FinishAITagJob(ctx, j, nil); err != nil {
			t.Fatal(err)
		}
	}
}

func TestAITagAdoptsChangedURLAndRetriesNewCapture(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	createLink(t, s, Link{URL: "https://seed.example", Tags: []string{"topic"}})
	if err := s.SetAITagModel(ctx, "selected"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAITagEnabled(ctx, true); err != nil {
		t.Fatal(err)
	}
	id := createLink(t, s, Link{URL: "https://old.example", Title: "Old article"})
	first, err := s.NextAITagJob(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.SetAITagModel(ctx, "selected"); err != nil {
		t.Fatal(err)
	}
	if err = s.SetAITagEnabled(ctx, true); err != nil {
		t.Fatal(err)
	}
	if _, err = s.NextAITagJob(ctx, false); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("duplicate settings released active inference", err)
	}
	if err = s.Update(ctx, id, Link{URL: "https://new.example", Title: "New article"}); err != nil {
		t.Fatal(err)
	}
	if err = s.StartAITagScan(ctx); err != nil {
		t.Fatal(err)
	}
	if err = s.FinishAITagJob(ctx, first, []string{"topic"}); err != nil {
		t.Fatal(err)
	}
	fresh, err := s.NextAITagJob(ctx, false)
	if err != nil || fresh.Domain != "new.example" {
		t.Fatalf("adoption failed %+v %v", fresh, err)
	}
	// The job started with fallback metadata. Basic capture adds a public
	// excerpt before the inference returns, keeping the URL unchanged.
	for range 2 {
		link, err := s.Next(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if err = s.Finish(ctx, link, "unused", "", "New public excerpt", nil, nil); err != nil {
			t.Fatal(err)
		}
	}
	if err = s.FinishAITagJob(ctx, fresh, []string{"topic"}); err != nil {
		t.Fatal(err)
	}
	if tags := getLink(t, s, id).Tags; len(tags) != 0 {
		t.Fatal("stale article classified", tags)
	}
	retry, err := s.NextAITagJob(ctx, false)
	if err != nil || retry.ID != id || retry.Excerpt != "New public excerpt" {
		t.Fatalf("lost fresh capture %+v %v", retry, err)
	}
	if err = s.FinishAITagJob(ctx, retry, []string{"topic"}); err != nil {
		t.Fatal(err)
	}
	page, err := s.List(ctx, Filter{Tags: []string{" ToPic "}})
	if err != nil || page.Total != 2 {
		t.Fatal("spaced tag filter", page.Total, err)
	}
}

func TestAITagScanAdoptsUntaggedAgain(t *testing.T) {
	s := testStore(t)
	ctx := t.Context()
	createLink(t, s, Link{URL: "https://seed.example", Tags: []string{"topic"}})
	if err := s.SetAITagModel(ctx, "model"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAITagEnabled(ctx, true); err != nil {
		t.Fatal(err)
	}
	id := createLink(t, s, Link{URL: "https://example.org", Title: "Topic"})
	first, err := s.NextAITagJob(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, tags := range [][]string{{"manual"}, nil} {
		if err = s.Bulk(ctx, BulkChange{IDs: []int64{id}, Action: "tags", Tags: tags}); err != nil {
			t.Fatal(err)
		}
	}
	if err = s.StartAITagScan(ctx); err != nil {
		t.Fatal(err)
	}
	if err = s.FinishAITagJob(ctx, first, []string{"topic"}); err != nil {
		t.Fatal(err)
	}
	fresh, err := s.NextAITagJob(ctx, false)
	if err != nil || fresh.ID != id {
		t.Fatalf("scan lost the newly untagged bookmark %+v, %v", fresh, err)
	}
}

func TestAITagXBELPreservesOrRestrictsExistingMetadata(t *testing.T) {
	s := testStore(t)
	ctx := t.Context()
	const u = "https://existing.example"
	id := createLink(t, s, Link{URL: u, Title: "Owner title"})
	if err := s.IndexDocument(ctx, id, u, "Unused title", "Private description", "private"); err != nil {
		t.Fatal(err)
	}
	sync := func(mark, title, desc string, wantTitlePrivate, wantDescriptionPrivate bool) {
		t.Helper()
		payload := `<xbel><bookmark href="` + u + `" ` + mark + `><title>` + title + `</title>` + desc + `</bookmark></xbel>`
		if err := s.ApplyDAV(ctx, "client", strings.NewReader(payload), "", ""); err != nil {
			t.Fatal(err)
		}
		var fields aiPrivateFields
		if err := s.db.QueryRow("SELECT ai_private_title,ai_private_description FROM links WHERE id=$1", id).Scan(&fields.title, &fields.description); err != nil || fields.title != wantTitlePrivate || fields.description != wantDescriptionPrivate {
			t.Fatalf("sync %q fields %+v %v", mark, fields, err)
		}
	}
	sync("", "Owner title", "", false, true)
	sync(`pocketmark-ai-public="description"`, "Private replacement", "<desc>Verified replacement</desc>", true, false)
	sync("", "Private replacement", "<desc>Unknown replacement</desc>", true, true)
	sync(`pocketmark-ai-public="title description"`, "Private replacement", "<desc>Unknown replacement</desc>", true, true)
}
