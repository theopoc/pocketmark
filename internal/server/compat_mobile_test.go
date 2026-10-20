package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http/httptest"
	"net/textproto"
	"strings"
	"testing"
	"time"

	"pocketmark/internal/store"
)

// AddTagSheet uses useUpsertTags with ArchivalTagOption labels, including
// options referring to an existing tag. The response is an array, not a tag.
func TestMobileTagUpsertOptions(t *testing.T) {
	a := newTestServer(t, "", false)
	w := request(a, "POST", "/api/v1/tags", `{"tags":[{"label":"mobile"},{"label":"reading"},{"label":"mobile"}]}`, true, nil)
	requireStatus(t, w, 200)
	var got struct {
		Response []struct {
			ID   int64  `json:"id"`
			Name string `json:"name"`
		} `json:"response"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Response) != 3 || got.Response[0].ID <= 0 || got.Response[1].ID <= 0 || got.Response[0].ID != got.Response[2].ID {
		t.Fatalf("expected stable identities for repeated tag options: %s", w.Body.String())
	}
	w = request(a, "POST", "/api/v1/tags", fmt.Sprintf(`{"tags":[{"value":%d,"label":"mobile"}]}`, got.Response[0].ID), true, nil)
	requireStatus(t, w, 200)
	var repeated struct {
		Response []struct {
			ID int64 `json:"id"`
		} `json:"response"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &repeated); err != nil {
		t.Fatal(err)
	}
	if len(repeated.Response) != 1 || repeated.Response[0].ID != got.Response[0].ID {
		t.Fatalf("upsert changed existing tag identity: %s", w.Body.String())
	}
}

func TestMobileTagUpsertRejectsInvalidBatchBeforeWriting(t *testing.T) {
	for _, body := range []string{
		`{"tags":[]}`,
		`{"tags":[{"label":"must-not-be-written"},{"label":" "}]}`,
		`{"tags":[` + strings.TrimSuffix(strings.Repeat(`{"label":"bounded"},`, 101), ",") + `]}`,
	} {
		a := newTestServer(t, "", false)
		requireStatus(t, request(a, "POST", "/api/v1/tags", body, true, nil), 400)
		var count int
		if err := a.Store.DB.QueryRow("SELECT count(*) FROM compat_tags").Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 0 {
			t.Fatal("invalid mobile tag batch partially persisted")
		}
	}
}

// The advertised 2.14.1 API causes useTag on the mobile tag page to fetch
// this endpoint instead of looking up the tag in a legacy list response.
func TestMobileTagDetailWithLinkCount(t *testing.T) {
	a := newTestServer(t, "", false)
	if _, err := a.Store.Create(context.Background(), store.Link{URL: "https://example.com/mobile", Tags: []string{"mobile"}}); err != nil {
		t.Fatal(err)
	}
	w := request(a, "GET", "/api/v1/tags?cursor=0&sort=2", "", true, nil)
	requireStatus(t, w, 200)
	var list struct {
		Data struct {
			Tags []struct {
				ID int64 `json:"id"`
			} `json:"tags"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil || len(list.Data.Tags) != 1 {
		t.Fatalf("tag list: %s (%v)", w.Body.String(), err)
	}
	w = request(a, "GET", fmt.Sprintf("/api/v1/tags/%d", list.Data.Tags[0].ID), "", true, nil)
	requireStatus(t, w, 200)
	var detail struct {
		Response struct {
			ID    int64  `json:"id"`
			Name  string `json:"name"`
			Count struct {
				Links int `json:"links"`
			} `json:"_count"`
		} `json:"response"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &detail); err != nil {
		t.Fatal(err)
	}
	if detail.Response.ID != list.Data.Tags[0].ID || detail.Response.Name != "mobile" || detail.Response.Count.Links != 1 {
		t.Fatalf("tag detail: %s", w.Body.String())
	}
	requireStatus(t, request(a, "GET", "/api/v1/tags/99999", "", true, nil), 404)
}

func TestMobileListingDatesRemainStableAfterEdits(t *testing.T) {
	a := newTestServer(t, "", false)
	ctx := context.Background()
	cid, err := a.Store.AddCollection(ctx, store.Collection{Name: "Native collection"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.Store.Create(ctx, store.Link{URL: "https://example.com/native", CollectionID: &cid, Tags: []string{"native-tag"}}); err != nil {
		t.Fatal(err)
	}
	// Use known persisted values to reject dates fabricated at response time.
	const fixed = "2001-01-01T00:00:00Z"
	for _, query := range []string{"UPDATE library_metadata SET created_at=?", "UPDATE collections SET created_at=?", "UPDATE compat_tags SET created_at=?"} {
		if _, err = a.Store.DB.Exec(query, fixed); err != nil {
			t.Fatal(err)
		}
	}
	var tid int64
	if err = a.Store.DB.QueryRow("SELECT id FROM compat_tags WHERE name='native-tag'").Scan(&tid); err != nil {
		t.Fatal(err)
	}
	requireStatus(t, request(a, "PUT", fmt.Sprintf("/api/v1/tags/%d", tid), `{"name":"renamed-tag"}`, true, nil), 200)
	requireStatus(t, request(a, "PUT", fmt.Sprintf("/api/v1/collections/%d", cid), `{"name":"Renamed collection"}`, true, nil), 200)
	w := request(a, "GET", "/api/v1/collections", "", true, nil)
	requireStatus(t, w, 200)
	var collections struct {
		Response []struct {
			CreatedAt string `json:"createdAt"`
		} `json:"response"`
	}
	if err = json.Unmarshal(w.Body.Bytes(), &collections); err != nil {
		t.Fatal(err)
	}
	if len(collections.Response) != 2 {
		t.Fatalf("missing Inbox/native collection: %s", w.Body.String())
	}
	for _, c := range collections.Response {
		if c.CreatedAt != fixed {
			t.Fatalf("collection creation date was reset or omitted: %s", w.Body.String())
		}
	}
	w = request(a, "GET", "/api/v1/tags?cursor=0", "", true, nil)
	requireStatus(t, w, 200)
	var tags struct {
		Data struct {
			Tags []struct {
				ID        int64  `json:"id"`
				CreatedAt string `json:"createdAt"`
			} `json:"tags"`
		} `json:"data"`
	}
	if err = json.Unmarshal(w.Body.Bytes(), &tags); err != nil {
		t.Fatal(err)
	}
	if len(tags.Data.Tags) != 1 || tags.Data.Tags[0].ID != tid || tags.Data.Tags[0].CreatedAt != fixed {
		t.Fatalf("tag edit changed creation date or identity: %s", w.Body.String())
	}
	w = request(a, "POST", "/api/v1/tags", `{"tags":[{"label":"mobile-tag"}]}`, true, nil)
	requireStatus(t, w, 200)
	var created struct {
		Response []struct {
			CreatedAt string `json:"createdAt"`
		} `json:"response"`
	}
	if err = json.Unmarshal(w.Body.Bytes(), &created); err != nil || len(created.Response) != 1 {
		t.Fatalf("mobile created tag: %s (%v)", w.Body.String(), err)
	}
	if _, err = time.Parse(time.RFC3339Nano, created.Response[0].CreatedAt); err != nil {
		t.Fatalf("mobile created tag has invalid date: %s", w.Body.String())
	}
}

// Mobile banner uploads are previews and must not replace a preserved image.
// The offline cache separately downloads image and preview based on these fields.
func TestMobileBannerPreservesArchivedImage(t *testing.T) {
	a := newTestServer(t, "", false)
	ctx := context.Background()
	lid, err := a.Store.Create(ctx, store.Link{URL: "https://example.com/mobile"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.Store.DB.Exec("UPDATE links SET updated_at='2020-01-01T00:00:00Z' WHERE id=?", lid); err != nil {
		t.Fatal(err)
	}
	archived := append([]byte{0xff, 0xd8, 0xff, 0xe0}, bytes.Repeat([]byte{0x20}, 600)...)
	if _, err = a.Store.SaveAsset(ctx, store.Asset{LinkID: lid, Name: "preserved.jpeg", MediaType: "image/jpeg", Kind: "image"}, bytes.NewReader(archived)); err != nil {
		t.Fatal(err)
	}
	preview := append([]byte{0xff, 0xd8, 0xff, 0xe0}, bytes.Repeat([]byte{0x30}, 600)...)
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	part, err := mw.CreateFormFile("file", "banner.jpg")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = part.Write(preview); err != nil {
		t.Fatal(err)
	}
	if err = mw.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("POST", fmt.Sprintf("http://pocketmark.test/api/v1/archives/%d?format=1&preview=true", lid), &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+testToken)
	w := httptest.NewRecorder()
	a.ServeHTTP(w, req)
	requireStatus(t, w, 200)
	w = request(a, "GET", fmt.Sprintf("/api/v1/archives/%d?format=1", lid), "", true, nil)
	requireStatus(t, w, 200)
	if !bytes.Equal(w.Body.Bytes(), archived) {
		t.Error("uploading a mobile banner replaced the preserved image")
	}
	w = request(a, "GET", fmt.Sprintf("/api/v1/archives/%d?format=1&preview=true", lid), "", true, nil)
	requireStatus(t, w, 200)
	if !bytes.Equal(w.Body.Bytes(), preview) {
		t.Error("mobile preview did not return uploaded banner")
	}
	w = request(a, "GET", fmt.Sprintf("/api/v1/links/%d", lid), "", true, nil)
	requireStatus(t, w, 200)
	var got struct {
		Response struct {
			Image, Preview *string
			UpdatedAt      string `json:"updatedAt"`
		} `json:"response"`
	}
	if err = json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Response.Image == nil || *got.Response.Image != "preserved.jpeg" || got.Response.Preview == nil || *got.Response.Preview == "" {
		t.Fatalf("mobile image/preview availability fields: %s", w.Body.String())
	}
	if got.Response.UpdatedAt == "2020-01-01T00:00:00Z" {
		t.Fatal("mobile cache freshness was not updated after banner upload")
	}
}

// useRemoveHighlight uses response as the numeric id when filtering its local
// query cache; an object response leaves the deleted highlight visible.
func TestMobileHighlightDeletionReturnsNumericID(t *testing.T) {
	a := newTestServer(t, "", false)
	lid, err := a.Store.Create(context.Background(), store.Link{URL: "https://example.com/mobile"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.Store.DB.Exec("UPDATE links SET content='Mobile reader' WHERE id=?", lid); err != nil {
		t.Fatal(err)
	}
	w := request(a, "POST", "/api/v1/highlights", fmt.Sprintf(`{"linkId":%d,"text":"Mobile","startOffset":0,"endOffset":6,"color":"yellow"}`, lid), true, nil)
	requireStatus(t, w, 200)
	var created struct {
		Response struct {
			ID int64 `json:"id"`
		} `json:"response"`
	}
	if err = json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	w = request(a, "DELETE", fmt.Sprintf("/api/v1/highlights/%d", created.Response.ID), "", true, nil)
	requireStatus(t, w, 200)
	var deleted struct {
		Response int64 `json:"response"`
	}
	if err = json.Unmarshal(w.Body.Bytes(), &deleted); err != nil {
		t.Fatalf("mobile expects a numeric deleted highlight id: %s (%v)", w.Body.String(), err)
	}
	if deleted.Response != created.Response.ID {
		t.Fatalf("wrong deleted highlight: %s", w.Body.String())
	}
	w = request(a, "GET", fmt.Sprintf("/api/v1/links/%d/highlights", lid), "", true, nil)
	requireStatus(t, w, 200)
	var remaining struct {
		Response []json.RawMessage `json:"response"`
	}
	if err = json.Unmarshal(w.Body.Bytes(), &remaining); err != nil || len(remaining.Response) != 0 {
		t.Fatalf("deleted highlight remains: %s (%v)", w.Body.String(), err)
	}
}

func TestMobilePreviewSpinnerStopsWhenPreservationFinishes(t *testing.T) {
	a := newTestServer(t, "", false)
	lid, err := a.Store.Create(context.Background(), store.Link{URL: "https://example.com/spinner"})
	if err != nil {
		t.Fatal(err)
	}
	for _, status := range []string{"pending", "processing", "ready", "failed"} {
		if _, err = a.Store.DB.Exec("UPDATE links SET status=? WHERE id=?", status, lid); err != nil {
			t.Fatal(err)
		}
		w := request(a, "GET", fmt.Sprintf("/api/v1/links/%d", lid), "", true, nil)
		requireStatus(t, w, 200)
		var got struct {
			Response struct {
				Preview *string `json:"preview"`
			} `json:"response"`
		}
		if err = json.Unmarshal(w.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if status == "pending" || status == "processing" {
			if got.Response.Preview != nil {
				t.Fatalf("pending preview should preserve mobile spinner: %s", w.Body.String())
			}
		} else if got.Response.Preview == nil || *got.Response.Preview != "unavailable" {
			t.Fatalf("terminal status %s keeps mobile spinner running: %s", status, w.Body.String())
		}
	}
}

func TestMobilePNGPreviewDeclaredAsJPEGStreamsOriginalBytes(t *testing.T) {
	a := newTestServer(t, "", false)
	ctx := context.Background()
	lid, err := a.Store.Create(ctx, store.Link{URL: "https://example.com/picker"})
	if err != nil {
		t.Fatal(err)
	}
	archived := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{0x40}, 600)...)
	if _, err = a.Store.SaveAsset(ctx, store.Asset{LinkID: lid, Name: "archived.png", MediaType: "image/png", Kind: "image"}, bytes.NewReader(archived)); err != nil {
		t.Fatal(err)
	}
	upload := func(format, suffix string, data []byte) *httptest.ResponseRecorder {
		t.Helper()
		var body bytes.Buffer
		mw := multipart.NewWriter(&body)
		// The actual mobile client hardcodes image/jpeg for PNG picker results.
		part, err := mw.CreatePart(textproto.MIMEHeader{
			"Content-Disposition": {`form-data; name="file"; filename="picker.png"`},
			"Content-Type":        {"image/jpeg"},
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err = part.Write(data); err != nil {
			t.Fatal(err)
		}
		if err = mw.Close(); err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest("POST", fmt.Sprintf("http://pocketmark.test/api/v1/archives/%d?format=%s%s", lid, format, suffix), &body)
		req.Header.Set("Content-Type", mw.FormDataContentType())
		req.Header.Set("Authorization", "Bearer "+testToken)
		w := httptest.NewRecorder()
		a.ServeHTTP(w, req)
		return w
	}
	var preview []byte
	for _, format := range []string{"0", "1"} {
		preview = append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte(format), 600)...)
		requireStatus(t, upload(format, "&preview=true", preview), 200)
		w := request(a, "GET", fmt.Sprintf("/api/v1/archives/%d?format=1&preview=true", lid), "", true, nil)
		requireStatus(t, w, 200)
		if w.Header().Get("Content-Type") != "image/png" || !bytes.Equal(w.Body.Bytes(), preview) {
			t.Fatalf("preview bytes/media did not match picker PNG: headers=%v", w.Header())
		}
	}
	// MIME mismatches remain invalid for ordinary archived images.
	requireStatus(t, upload("1", "", preview), 415)
	// Unsupported preview formats are rejected instead of being served as images.
	requireStatus(t, upload("1", "&preview=true", []byte("%PDF-1.7\nnot an image")), 415)
	w := request(a, "GET", fmt.Sprintf("/api/v1/archives/%d?format=1&preview=true", lid), "", true, nil)
	requireStatus(t, w, 200)
	if !bytes.Equal(w.Body.Bytes(), preview) {
		t.Fatal("rejected upload changed existing preview")
	}
	w = request(a, "GET", fmt.Sprintf("/api/v1/archives/%d?format=0", lid), "", true, nil)
	requireStatus(t, w, 200)
	if !bytes.Equal(w.Body.Bytes(), archived) {
		t.Fatal("PNG preview changed preserved image")
	}
}

func TestMobileCollectionDescriptionRoundTripsAfterNativeEdit(t *testing.T) {
	a := newTestServer(t, "", false)
	const description = "Synthetic collection description"
	w := request(a, "POST", "/api/v1/collections", `{"name":"Created on Android","description":"`+description+`"}`, true, nil)
	requireStatus(t, w, 200)
	var created struct {
		Response struct {
			ID          int64  `json:"id"`
			Description string `json:"description"`
		} `json:"response"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Response.ID <= 0 || created.Response.Description != description {
		t.Fatalf("mobile create discarded description: %s", w.Body.String())
	}
	cid := created.Response.ID
	requireStatus(t, request(a, "PUT", fmt.Sprintf("/api/collections/%d", cid), `{"name":"Renamed natively","parentId":null}`, true, nil), 200)
	lid, err := a.Store.Create(context.Background(), store.Link{URL: "https://example.com/collection", CollectionID: &cid})
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/v1/collections", fmt.Sprintf("/api/v1/collections/%d", cid), fmt.Sprintf("/api/v1/links/%d", lid)} {
		w = request(a, "GET", path, "", true, nil)
		requireStatus(t, w, 200)
		if !strings.Contains(w.Body.String(), `"description":"`+description+`"`) {
			t.Fatalf("description missing after native edit for %s: %s", path, w.Body.String())
		}
	}
	requireStatus(t, request(a, "PUT", fmt.Sprintf("/api/v1/collections/%d", cid), `{"name":"Cleared on Android","description":""}`, true, nil), 200)
	var cleared string
	if err = a.Store.DB.QueryRow("SELECT description FROM collections WHERE id=?", cid).Scan(&cleared); err != nil || cleared != "" {
		t.Fatalf("mobile description clear failed: %q (%v)", cleared, err)
	}
	oversized := `{"name":"Rejected","description":"` + strings.Repeat("x", 8193) + `"}`
	requireStatus(t, request(a, "POST", "/api/v1/collections", oversized, true, nil), 400)
	var count int
	if err = a.Store.DB.QueryRow("SELECT count(*) FROM collections").Scan(&count); err != nil || count != 1 {
		t.Fatalf("rejected description partially created collection: %d (%v)", count, err)
	}
}
