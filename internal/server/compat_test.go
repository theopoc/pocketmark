package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http/httptest"
	"strings"
	"testing"

	"pocketmark/internal/store"
)

func TestLibraryHTTPBulkAndHTML(t *testing.T) {
	a := newTestServer(t, "", false)
	c, e := a.Store.AddCollection(context.Background(), store.Collection{Name: "Before"})
	if e != nil {
		t.Fatal(e)
	}
	requireStatus(t, request(a, "PUT", fmt.Sprintf("/api/collections/%d", c), `{"name":"After","parentId":null}`, true, nil), 200)
	fixture := `<DL><DT><A HREF="https://example.com">Bookmark</A></DL>`
	requireStatus(t, request(a, "POST", "/api/import/html", fixture, true, nil), 200)
	p, _ := a.Store.List(context.Background(), store.Filter{})
	id := p.Links[0].ID
	requireStatus(t, request(a, "POST", "/api/links/bulk", fmt.Sprintf(`{"ids":[%d],"action":"favorite","value":true}`, id), true, nil), 200)
	requireStatus(t, request(a, "GET", "/api/export/html", "", true, nil), 200)
	_, _ = a.Store.DB.Exec("UPDATE links SET content='Sample text' WHERE id=?", id)
	requireStatus(t, request(a, "POST", fmt.Sprintf("/api/links/%d/annotations", id), `{"quote":"Sample","start":0,"end":6,"note":"Useful","color":"blue"}`, true, nil), 200)
	w := request(a, "GET", fmt.Sprintf("/api/links/%d/annotations", id), "", true, nil)
	requireStatus(t, w, 200)
	if !strings.Contains(w.Body.String(), `"quote":"Sample"`) {
		t.Fatal(w.Body.String())
	}
}
func TestCompatibilityExtensionAndMobileShapes(t *testing.T) {
	a := newTestServer(t, "", false)
	requireStatus(t, request(a, "GET", "/api/v1/config", "", false, nil), 200)
	requireStatus(t, request(a, "GET", "/api/v1/logins", "", false, nil), 200)
	requireStatus(t, request(a, "GET", "/api/v1/users/me", "", false, nil), 401)
	// The browser extension posts collection/tag objects and a screenshot hint.
	body := `{"url":"https://example.com/docs","name":"Extension bookmark","description":"Useful","collection":{"name":"References"},"tags":[{"name":"docs"}],"image":"png"}`
	w := request(a, "POST", "/api/v1/links", body, true, nil)
	requireStatus(t, w, 200)
	var created struct {
		Response struct {
			ID   int64  `json:"id"`
			Name string `json:"name"`
			Tags []struct {
				ID   int64  `json:"id"`
				Name string `json:"name"`
			} `json:"tags"`
		} `json:"response"`
	}
	if e := json.Unmarshal(w.Body.Bytes(), &created); e != nil {
		t.Fatal(e)
	}
	if created.Response.Name != "Extension bookmark" || len(created.Response.Tags) != 1 {
		t.Fatal(w.Body.String())
	}
	id := created.Response.ID
	w = request(a, "GET", "/api/v1/search?sort=0&searchQueryString=url%3Ahttps%3A%2F%2Fexample.com%2Fdocs", "", true, nil)
	requireStatus(t, w, 200)
	if !strings.Contains(w.Body.String(), `"links":[{`) || !strings.Contains(w.Body.String(), `"nextCursor":null`) {
		t.Fatal(w.Body.String())
	}
	requireStatus(t, request(a, "PUT", fmt.Sprintf("/api/v1/links/%d", id), `{"pinnedBy":[{"id":1}],"name":"Edited","tags":[{"name":"docs"}]}`, true, nil), 200)
	w = request(a, "GET", "/api/v2/dashboard", "", true, nil)
	requireStatus(t, w, 200)
	if !strings.Contains(w.Body.String(), `"numberOfPinnedLinks":1`) {
		t.Fatal(w.Body.String())
	}
	w = request(a, "GET", "/api/v1/tags?cursor=0&sort=2&search=doc", "", true, nil)
	requireStatus(t, w, 200)
	if !strings.Contains(w.Body.String(), `"tags":[{`) {
		t.Fatal(w.Body.String())
	}
	requireStatus(t, request(a, "PUT", fmt.Sprintf("/api/v1/tags/%d", created.Response.Tags[0].ID), `{"name":"manual"}`, true, nil), 200)
	l, _ := a.Store.Get(context.Background(), id)
	if len(l.Tags) != 1 || l.Tags[0] != "manual" || !l.Favorite {
		t.Fatalf("%+v", l)
	}
	requireStatus(t, request(a, "DELETE", fmt.Sprintf("/api/v1/tags/%d", created.Response.Tags[0].ID), "", true, nil), 200)
	requireStatus(t, request(a, "GET", "/api/v1/users/me", "", true, nil), 200)
	requireStatus(t, request(a, "GET", "/api/v1/unsupported", "", true, nil), 501)
}
func TestCompatPasswordSessionIsRevocableKey(t *testing.T) {
	a := newTestServer(t, "", false)
	requireStatus(t, request(a, "PUT", "/api/account", `{"username":"reader","password":"long-enough-password"}`, true, nil), 200)
	requireStatus(t, request(a, "POST", "/api/v1/session", `{"username":"reader","password":"incorrect","sessionName":"Mobile"}`, false, nil), 401)
	w := request(a, "POST", "/api/v1/session", `{"username":"reader","password":"long-enough-password","sessionName":"Mobile"}`, false, nil)
	requireStatus(t, w, 200)
	var v struct {
		Response struct {
			Token string `json:"token"`
		} `json:"response"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &v)
	if len(v.Response.Token) != 64 {
		t.Fatal("missing client token")
	}
	h := map[string]string{"Authorization": "Bearer " + v.Response.Token}
	requireStatus(t, request(a, "GET", "/api/v1/collections", "", false, h), 200)
	requireStatus(t, request(a, "GET", "/api/account", "", false, h), 403)
	var tokenID int64
	_ = a.Store.DB.QueryRow("SELECT id FROM api_tokens WHERE name='Mobile'").Scan(&tokenID)
	requireStatus(t, request(a, "DELETE", fmt.Sprintf("/api/tokens/%d", tokenID), "", true, nil), 200)
	requireStatus(t, request(a, "GET", "/api/v1/collections", "", false, h), 401)
}
func TestCompatScreenshotStreamingUpload(t *testing.T) {
	a := newTestServer(t, "", false)
	id, e := a.Store.Create(context.Background(), store.Link{URL: "https://example.com"})
	if e != nil {
		t.Fatal(e)
	}
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	part, _ := mw.CreateFormFile("file", "screenshot.png")
	png := append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 600)...)
	_, _ = part.Write(png)
	_ = mw.Close()
	req := httptest.NewRequest("POST", fmt.Sprintf("http://pocketmark.test/api/v1/archives/%d?format=0", id), &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+testToken)
	w := httptest.NewRecorder()
	a.ServeHTTP(w, req)
	requireStatus(t, w, 200)
	w = request(a, "GET", fmt.Sprintf("/api/v1/archives/%d?format=0", id), "", true, nil)
	requireStatus(t, w, 200)
	if !bytes.Equal(w.Body.Bytes(), png) {
		t.Fatal("archive bytes changed")
	}
}

func TestCompatReadableAndUTF16Highlights(t *testing.T) {
	a := newTestServer(t, "", false)
	id, _ := a.Store.Create(context.Background(), store.Link{URL: "https://example.com"})
	_, _ = a.Store.DB.Exec("UPDATE links SET content=?,status='ready' WHERE id=?", "A 😀 café article", id)
	w := request(a, "GET", fmt.Sprintf("/api/v1/archives/%d?format=3", id), "", true, nil)
	requireStatus(t, w, 200)
	var reader struct {
		Content string `json:"content"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &reader)
	if reader.Content != "<pre>A 😀 café article</pre>" {
		t.Fatal(w.Body.String())
	}
	w = request(a, "POST", "/api/v1/highlights", fmt.Sprintf(`{"linkId":%d,"text":"😀 café","startOffset":2,"endOffset":9,"comment":"Unicode","color":"red"}`, id), true, nil)
	requireStatus(t, w, 200)
	w = request(a, "GET", fmt.Sprintf("/api/v1/links/%d/highlights", id), "", true, nil)
	requireStatus(t, w, 200)
	if !strings.Contains(w.Body.String(), `"endOffset":9`) || !strings.Contains(w.Body.String(), `"color":"red"`) {
		t.Fatal(w.Body.String())
	}
}

func TestCompatSearchCursorFollowsServerNextCursor(t *testing.T) {
	a := newTestServer(t, "", false)
	for i := 0; i < 85; i++ {
		_, e := a.Store.Create(context.Background(), store.Link{URL: fmt.Sprintf("https://example.com/%d", i)})
		if e != nil {
			t.Fatal(e)
		}
	}
	// The official router feeds the returned nextCursor back as pageParam.
	cursor := 0
	seen := map[int64]bool{}
	for page := 0; page < 4; page++ {
		w := request(a, "GET", fmt.Sprintf("/api/v1/search?cursor=%d&sort=0", cursor), "", true, nil)
		requireStatus(t, w, 200)
		var payload struct {
			Data struct {
				Links []struct {
					ID int64 `json:"id"`
				} `json:"links"`
				Next *int `json:"nextCursor"`
			} `json:"data"`
		}
		if e := json.Unmarshal(w.Body.Bytes(), &payload); e != nil {
			t.Fatal(e)
		}
		for _, l := range payload.Data.Links {
			if seen[l.ID] {
				t.Fatal("duplicate across pages")
			}
			seen[l.ID] = true
		}
		if payload.Data.Next == nil {
			break
		}
		cursor = *payload.Data.Next
	}
	if len(seen) != 85 {
		t.Fatalf("got %d records", len(seen))
	}
}
