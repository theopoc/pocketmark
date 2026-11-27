package store

import (
	"database/sql"
	"errors"
	"strings"
	"testing"

	"pocketmark/internal/capture"
)

type aiInput struct{ title, description, excerpt string }

// aiInputs drains the queue after a full scan and returns what AI tagging
// would send for each bookmark URL.
func aiInputs(t *testing.T, s *Store) map[string]aiInput {
	t.Helper()
	ctx := t.Context()
	if err := s.SetAITagModel(ctx, "test"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAITagEnabled(ctx, true); err != nil {
		t.Fatal(err)
	}
	if err := s.StartAITagScan(ctx); err != nil {
		t.Fatal(err)
	}
	got := map[string]aiInput{}
	for {
		j, err := s.NextAITagJob(ctx, false)
		if errors.Is(err, sql.ErrNoRows) {
			return got
		}
		if err != nil {
			t.Fatal(err)
		}
		var url string
		if err = s.db.QueryRowContext(ctx, "SELECT url FROM links WHERE id=$1", j.ID).Scan(&url); err != nil {
			t.Fatal(err)
		}
		got[url] = aiInput{j.Title, j.Description, j.Excerpt}
		if err = s.FinishAITagJob(ctx, j, nil); err != nil {
			t.Fatal(err)
		}
	}
}

func checkAIInputs(t *testing.T, got, want map[string]aiInput) {
	t.Helper()
	for url, w := range want {
		if g, ok := got[url]; !ok || g != w {
			t.Errorf("%s: AI input %+v, want %+v (queued %v)", url, g, w, ok)
		}
	}
}

// Each metadata source decides what AI tagging may send: owner-entered and
// basic-capture metadata are AI-public; browser uploads, URL fallback titles
// and unannotated replica metadata stay local.
func TestAITagInputFollowsMetadataSource(t *testing.T) {
	s := testStore(t)
	ctx := t.Context()

	// Basic capture runs first so it claims this bookmark, not a later one.
	const captured = "https://capture.example/page"
	createLink(t, s, Link{URL: captured})
	l, err := s.Next(ctx)
	if err != nil || l.URL != captured {
		t.Fatalf("capture claimed %q %v", l.URL, err)
	}
	if err = s.Finish(ctx, l, capture.Result{Title: "Captured title", Description: "Captured description", Content: "captured text", HTML: []byte("<p>captured</p>")}, nil); err != nil {
		t.Fatal(err)
	}

	const owner = "https://owner.example/page"
	createLink(t, s, Link{URL: owner, Title: "Owner title", Description: "Owner description", Notes: "personal notes"})

	const fallback = "https://fallback.example/page?token=secret"
	createLink(t, s, Link{URL: fallback})

	const uploaded = "https://upload.example/page"
	id := createLink(t, s, Link{URL: uploaded})
	if err = s.IndexDocument(ctx, id, uploaded, "Uploaded title", "Uploaded description", "uploaded body"); err != nil {
		t.Fatal(err)
	}

	// The owner replaces only the uploaded description.
	const edited = "https://edited.example/page"
	id = createLink(t, s, Link{URL: edited})
	if err = s.IndexDocument(ctx, id, edited, "Uploaded title", "Uploaded description", "uploaded body"); err != nil {
		t.Fatal(err)
	}
	l = getLink(t, s, id)
	l.Description = "Owner description"
	if err = s.Update(ctx, id, l); err != nil {
		t.Fatal(err)
	}

	const foreignJSON, exportJSON = "https://json.example/foreign", "https://json.example/export"
	if _, err = s.Import(ctx, strings.NewReader(`{"links":[{"url":"`+foreignJSON+`","title":"Imported title","description":"Imported description"}]}`)); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Import(ctx, strings.NewReader(`{"format":"pocketmark","version":1,"links":[{"url":"`+exportJSON+`","title":"Exported title","description":"Exported description"}]}`)); err != nil {
		t.Fatal(err)
	}
	const foreignHTML = "https://html.example/foreign"
	if _, err = s.ImportHTML(ctx, strings.NewReader(`<DL><DT><A HREF="`+foreignHTML+`">Imported title</A><DD>Imported description</DL>`)); err != nil {
		t.Fatal(err)
	}

	checkAIInputs(t, aiInputs(t, s), map[string]aiInput{
		captured:    {"Captured title", "Captured description", "captured text"},
		owner:       {"Owner title", "Owner description", ""},
		fallback:    {},
		uploaded:    {},
		edited:      {"", "Owner description", ""},
		foreignJSON: {"Imported title", "Imported description", ""},
		exportJSON:  {},
		foreignHTML: {"Imported title", "Imported description", ""},
	})
}

// Floccus sync records keep metadata private unless a marker says otherwise.
func TestAITagInputFollowsSyncMarker(t *testing.T) {
	s := testStore(t)
	const unmarked, marked = "https://sync.example/unmarked", "https://sync.example/marked"
	payload := `<xbel>` +
		`<bookmark href="` + unmarked + `"><title>Synced title</title><desc>Synced description</desc></bookmark>` +
		`<bookmark href="` + marked + `" pocketmark-ai-public="title"><title>Synced title</title><desc>Synced description</desc></bookmark>` +
		`</xbel>`
	if err := s.ApplyDAV(t.Context(), "client", strings.NewReader(payload), "", ""); err != nil {
		t.Fatal(err)
	}
	checkAIInputs(t, aiInputs(t, s), map[string]aiInput{
		unmarked: {},
		marked:   {"Synced title", "", ""},
	})
}
