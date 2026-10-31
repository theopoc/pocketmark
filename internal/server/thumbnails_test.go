package server

import (
	"context"
	"encoding/base64"
	"fmt"
	"testing"

	"pocketmark/internal/store"
)

func TestThumbnailAuthenticationAndPrivateCache(t *testing.T) {
	a := newTestServer(t, "", false)
	ctx := context.Background()
	_, err := a.Store.Create(ctx, store.Link{URL: "https://example.com"})
	if err != nil {
		t.Fatal(err)
	}
	l, err := a.Store.Next(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err = a.Store.Finish(ctx, l, "title", "", "", nil, nil); err != nil {
		t.Fatal(err)
	}
	png, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6XcAAAAASUVORK5CYII=")
	if err = a.Store.SaveThumbnail(ctx, l, png); err != nil {
		t.Fatal(err)
	}
	path := fmt.Sprintf("/api/links/%d/thumbnail", l.ID)
	requireStatus(t, request(a, "GET", path, "", false, nil), 401)
	w := request(a, "GET", path, "", true, nil)
	requireStatus(t, w, 200)
	if w.Header().Get("Content-Type") != "image/png" || w.Header().Get("Cache-Control") != "private, no-cache" {
		t.Fatal(w.Header())
	}
	requireStatus(t, request(a, "GET", path, "", true, map[string]string{"If-None-Match": w.Header().Get("ETag")}), 304)
}
