package server

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"pocketmark/internal/webui"
)

func openAPIDocument(t *testing.T) map[string]any {
	t.Helper()
	raw, err := webui.Files.ReadFile("static/api-docs/openapi.json")
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err = json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	return doc
}

// Route coverage fails when a native endpoint is added/removed without updating
// the reference. Scan route registrations, not a second hand-maintained list.
func TestOpenAPICoversNativeRoutes(t *testing.T) {
	doc := openAPIDocument(t)
	paths := doc["paths"].(map[string]any)
	routes := map[string]bool{}
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range files {
		if strings.HasSuffix(name, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(token.NewFileSet(), name, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(file, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok || len(call.Args) == 0 {
				return true
			}
			selector, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || selector.Sel.Name != "HandleFunc" {
				return true
			}
			literal, ok := call.Args[0].(*ast.BasicLit)
			if !ok || literal.Kind != token.STRING {
				return true
			}
			pattern, err := strconv.Unquote(literal.Value)
			if err != nil {
				t.Fatal(err)
			}
			method, path, ok := strings.Cut(pattern, " ")
			if !ok || path == "/api/" || !(strings.HasPrefix(path, "/api/") || path == "/healthz") {
				return true
			}
			routes[strings.ToLower(method)+" "+path] = true
			return true
		})
	}
	if len(routes) == 0 {
		t.Fatal("no route registrations found")
	}
	ids := map[string]bool{}
	for path, value := range paths {
		item := value.(map[string]any)
		for method, value := range item {
			if method == "parameters" {
				continue
			}
			pattern := method + " " + path
			if !routes[pattern] {
				t.Errorf("documented operation has no native route: %s", pattern)
			}
			delete(routes, pattern)
			op := value.(map[string]any)
			id, _ := op["operationId"].(string)
			if id == "" || ids[id] {
				t.Errorf("missing or duplicate operationId on %s", pattern)
			}
			ids[id] = true
			responses := op["responses"].(map[string]any)
			public := path == "/api/setup" || path == "/api/login" || path == "/healthz"
			security, override := op["security"]
			if public {
				if !override || len(security.([]any)) != 0 {
					t.Errorf("public operation must explicitly allow anonymous access: %s", pattern)
				}
			} else if override || responses["401"] == nil {
				t.Errorf("protected operation must inherit authentication and document 401: %s", pattern)
			}
			owner := path == "/api/account" || path == "/api/tokens" || path == "/api/tokens/{id}" || path == "/api/backup"
			if owner && (op["x-owner-only"] != true || responses["403"] == nil) {
				t.Errorf("owner-only operation must document its restriction: %s", pattern)
			}
			parameters, _ := item["parameters"].([]any)
			for _, name := range []string{"id", "assetId", "annotationId"} {
				if !strings.Contains(path, "{"+name+"}") {
					continue
				}
				found := false
				for _, value := range parameters {
					parameter := value.(map[string]any)
					if parameter["name"] == name && parameter["in"] == "path" && parameter["required"] == true {
						found = true
					}
				}
				if !found {
					t.Errorf("missing required path parameter %s on %s", name, path)
				}
			}
		}
	}
	for pattern := range routes {
		t.Errorf("native route missing from OpenAPI: %s", pattern)
	}
}

func TestOpenAPILocalReferencesAndServer(t *testing.T) {
	doc := openAPIDocument(t)
	if doc["openapi"] != "3.0.3" || doc["servers"].([]any)[0].(map[string]any)["url"] != "/" {
		t.Fatal("expected OpenAPI 3.0.3 on the current instance")
	}
	if len(doc["security"].([]any)) != 2 {
		t.Fatal("expected bearer and owner cookie authentication alternatives")
	}
	var walk func(any)
	walk = func(value any) {
		switch value := value.(type) {
		case map[string]any:
			if reference, ok := value["$ref"].(string); ok {
				if !strings.HasPrefix(reference, "#/components/") {
					t.Errorf("nonlocal reference: %s", reference)
					return
				}
				var resolved any = doc
				for _, part := range strings.Split(strings.TrimPrefix(reference, "#/"), "/") {
					object, _ := resolved.(map[string]any)
					resolved = object[part]
				}
				if resolved == nil {
					t.Errorf("unresolved reference: %s", reference)
				}
			}
			for _, child := range value {
				walk(child)
			}
		case []any:
			for _, child := range value {
				walk(child)
			}
		}
	}
	walk(doc)
}

func TestAPIDocumentationDeliveryAndAuthentication(t *testing.T) {
	a := newTestServer(t, "", false)
	assets, err := fs.Glob(webui.Files, "static/api-docs/vendor/*")
	if err != nil {
		t.Fatal(err)
	}
	paths := []string{"/api-docs/", "/api-docs/docs.js", "/api-docs/docs.css", "/api-docs/openapi.json"}
	for _, path := range assets {
		paths = append(paths, strings.TrimPrefix(path, "static"))
	}
	for _, path := range paths {
		w := request(a, "GET", path, "", false, nil)
		requireStatus(t, w, 200)
		if w.Body.Len() == 0 || w.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("empty asset or missing protection: %s", path)
		}
		csp := w.Header().Get("Content-Security-Policy")
		if strings.Contains(csp, "unsafe-inline") || strings.Contains(csp, "unsafe-eval") || !strings.Contains(csp, "script-src 'self'") {
			t.Errorf("documentation weakened CSP: %s", csp)
		}
	}
	w := request(a, "GET", "/api-docs/openapi.json", "", false, nil)
	if !strings.HasPrefix(w.Header().Get("Content-Type"), "application/json") || !json.Valid(w.Body.Bytes()) {
		t.Fatal("OpenAPI specification must be served as valid JSON")
	}
	requireStatus(t, request(a, "GET", "/api-docs/missing", "", false, nil), 404)
	requireStatus(t, request(a, "GET", "/api/stats", "", false, nil), 401)
	requireStatus(t, request(a, "GET", "/api/stats", "", true, nil), 200)
	requireStatus(t, request(a, "POST", "/api/links", `{"url":"https://example.com"}`, true, map[string]string{"Origin": "https://attacker.test"}), 403)
}

func TestOpenAPICreateExamples(t *testing.T) {
	doc := openAPIDocument(t)
	schemas := doc["components"].(map[string]any)["schemas"].(map[string]any)
	for _, example := range []struct{ schema, path string }{
		{"LinkInput", "/api/links"},
		{"CollectionInput", "/api/collections"},
	} {
		t.Run(example.schema, func(t *testing.T) {
			a := newTestServer(t, "", false)
			value := schemas[example.schema].(map[string]any)["example"]
			if value == nil {
				t.Fatal("missing runnable example")
			}
			body, err := json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			// Examples must work without an existing collection or bookmark.
			requireStatus(t, request(a, "POST", example.path, string(body), true, nil), 201)
		})
	}
}
