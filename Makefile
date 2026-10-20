.PHONY: build test run check fmt-check test-extension package-extensions
GO_TAGS := sqlite_fts5 sqlite_omit_load_extension
LDFLAGS ?= -s -w
TEST_FLAGS ?= -race -p 1
export CGO_ENABLED := 1

build:
	go build -tags '$(GO_TAGS)' -trimpath -ldflags='$(LDFLAGS)' -o bin/pocketmark ./cmd/pocketmark
test:
	go test $(TEST_FLAGS) -tags '$(GO_TAGS)' ./...
test-extension:
	node --test extension/popup.test.cjs
fmt-check:
	@test -z "$$(gofmt -l cmd internal)" || { gofmt -l cmd internal; exit 1; }
check: fmt-check
	go vet -tags '$(GO_TAGS)' ./...
	node --check internal/webui/static/app.js
	node --check internal/webui/static/sw.js
	node --check extension/popup.js
	python3 -m py_compile scripts/*.py extension/build_advanced.py
package-extensions:
	python3 scripts/package_release.py extensions --output dist
run: build
	./bin/pocketmark
