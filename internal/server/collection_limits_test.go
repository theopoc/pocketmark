package server

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestNativeCollectionAllowsFullDescriptionAndPreservesOnRename(t *testing.T) {
	a := newTestServer(t, "", false)
	description := strings.Repeat("x", 8192)
	encode := func(name, description string) string {
		t.Helper()
		body, err := json.Marshal(map[string]string{"name": name, "description": description})
		if err != nil {
			t.Fatal(err)
		}
		return string(body)
	}
	w := request(a, "POST", "/api/collections", encode("Full description", description), true, nil)
	requireStatus(t, w, 201)
	var created struct {
		ID          int64  `json:"id"`
		Description string `json:"description"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.ID <= 0 || created.Description != description {
		t.Fatal("native creation discarded full 8 KiB description")
	}
	path := fmt.Sprintf("/api/collections/%d", created.ID)
	// An 8 KiB value may require more bytes in JSON because of escaping.
	description = strings.Repeat("\"", 8192)
	requireStatus(t, request(a, "PUT", path, encode("Updated", description), true, nil), 200)
	requireStatus(t, request(a, "PUT", path, `{"name":"Renamed","parentId":null}`, true, nil), 200)
	w = request(a, "GET", "/api/collections", "", true, nil)
	requireStatus(t, w, 200)
	var collections []struct {
		Name        string `json:"name"`
		Description string `json:"description"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &collections); err != nil {
		t.Fatal(err)
	}
	if len(collections) != 1 || collections[0].Name != "Renamed" || collections[0].Description != description {
		t.Fatal("native update/rename discarded full 8 KiB description")
	}
	// Raising the transport envelope does not relax the stored field bound.
	requireStatus(t, request(a, "PUT", path, encode("Rejected", description+"x"), true, nil), 400)
	w = request(a, "GET", "/api/collections", "", true, nil)
	requireStatus(t, w, 200)
	if err := json.Unmarshal(w.Body.Bytes(), &collections); err != nil {
		t.Fatal(err)
	}
	if len(collections) != 1 || collections[0].Name != "Renamed" || collections[0].Description != description {
		t.Fatal("oversized update partially modified collection")
	}

}
