package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"pocketmark/internal/store"
)

func TestStandaloneFileUploadEditAndExport(t *testing.T) {
	a := newTestServer(t, "", false)
	w := request(a, "POST", "/api/files?name=manual.pdf", "%PDF-1.7\nexample file body", true, map[string]string{"Content-Type": "application/pdf"})
	requireStatus(t, w, 201)
	var saved struct {
		Link  store.Link  `json:"link"`
		Asset store.Asset `json:"asset"`
	}
	if e := json.Unmarshal(w.Body.Bytes(), &saved); e != nil {
		t.Fatal(e)
	}
	if saved.Link.Type != "file" || saved.Link.Status != "ready" || !store.IsFileURL(saved.Link.URL) || saved.Asset.Kind != "pdf" {
		t.Fatal(w.Body.String())
	}
	if _, e := a.Store.Next(context.Background()); e == nil {
		t.Fatal("file queued for HTTP capture")
	}
	requireStatus(t, request(a, "POST", fmt.Sprintf("/api/links/%d/capture", saved.Link.ID), "", true, nil), 404)
	saved.Link.Title = "My manual"
	saved.Link.Tags = []string{"manual"}
	body, _ := json.Marshal(saved.Link)
	requireStatus(t, request(a, "PUT", fmt.Sprintf("/api/links/%d", saved.Link.ID), string(body), true, nil), 200)
	saved.Link.URL = "https://example.com"
	body, _ = json.Marshal(saved.Link)
	requireStatus(t, request(a, "PUT", fmt.Sprintf("/api/links/%d", saved.Link.ID), string(body), true, nil), 400)
	w = request(a, "GET", "/api/export/html", "", true, nil)
	requireStatus(t, w, 200)
	if strings.Contains(w.Body.String(), "pocketmark-file:") {
		t.Fatal("file exported as browser URL")
	}
	w = request(a, "GET", "/api/export", "", true, nil)
	requireStatus(t, w, 200)
	if !strings.Contains(w.Body.String(), `"type":"file"`) {
		t.Fatal("missing file metadata")
	}
	s, e := store.Open(t.TempDir() + "/roundtrip.db")
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	if _, e = s.Import(context.Background(), bytes.NewReader(w.Body.Bytes())); e != nil {
		t.Fatal(e)
	}
	p, _ := s.List(context.Background(), store.Filter{})
	if p.Total != 1 || p.Links[0].Type != "file" || p.Links[0].Status != "ready" {
		t.Fatalf("%+v", p)
	}

}
func TestStandaloneHTMLIndexedAndRejectedUploadLeavesNoRecord(t *testing.T) {
	a := newTestServer(t, "", false)
	requireStatus(t, request(a, "POST", "/api/files?name=bad.txt", "plain unrelated text", true, map[string]string{"Content-Type": "text/plain"}), 415)
	requireStatus(t, request(a, "POST", "/api/files?name=page.html", "<!doctype html><html><head><title>Title</title></head><body><article>Quicksilver unique text</article></body></html>", true, map[string]string{"Content-Type": "text/html"}), 201)
	p, e := a.Store.List(context.Background(), store.Filter{Query: "Quicksilver"})
	if e != nil || p.Total != 1 {
		t.Fatalf("%+v %v", p, e)
	}
	requireStatus(t, request(a, "GET", fmt.Sprintf("/api/links/%d/reader", p.Links[0].ID), "", true, nil), 200)
	stats, err := a.Store.Stats(context.Background())
	if err != nil || stats.Links != 1 {
		t.Fatal("invalid upload left record")
	}
}
