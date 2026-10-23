package server

import "testing"

func TestHTTPConstructionDoesNotInitializePersistence(t *testing.T) {
	a := newTestServer(t, "", false)
	if err := a.Store.Close(); err != nil {
		t.Fatal(err)
	}
	// Building routes must perform no schema work, even on an unavailable store.
	// Storage failure is reported by Open or by the request, never a DDL panic.
	b := New(a.Store, testToken, "", false)
	requireStatus(t, request(b, "GET", "/healthz", "", false, nil), 503)
	requireStatus(t, request(b, "GET", "/api-docs/", "", false, nil), 200)
}
