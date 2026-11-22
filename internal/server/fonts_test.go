package server

import "testing"

func TestEmbeddedFontsAreServedAndCacheable(t *testing.T) {
	a := newTestServer(t, "", false)
	w := request(a, "GET", "/fonts/figtree-latin.woff2", "", false, nil)
	requireStatus(t, w, 200)
	if got := w.Header().Get("Content-Type"); got != "font/woff2" {
		t.Fatalf("font content type = %q", got)
	}
	if got := w.Header().Get("Cache-Control"); got != "public, max-age=86400" {
		t.Fatalf("font cache control = %q", got)
	}
	api := request(a, "GET", "/api/stats", "", false, nil)
	if got := api.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("API cache control = %q", got)
	}
}
