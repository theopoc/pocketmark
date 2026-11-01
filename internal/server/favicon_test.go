package server

import (
	"context"
	"fmt"
	"testing"

	"pocketmark/internal/store"
)

func TestSiteIconRequiresAuthenticationAndRejectsPrivateDestinations(t *testing.T) {
	a := newTestServer(t, "", false)
	link, err := a.Store.Create(context.Background(), store.Link{URL: "http://127.0.0.1/private"})
	if err != nil {
		t.Fatal(err)
	}
	path := fmt.Sprintf("/api/links/%d/favicon", link)
	requireStatus(t, request(a, "GET", path, "", false, nil), 401)
	requireStatus(t, request(a, "GET", path, "", true, nil), 404)
}
