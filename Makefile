.PHONY: build test run check fmt-check test-extension release-check release-snapshot
GO_TAGS := sqlite_fts5 sqlite_omit_load_extension
LDFLAGS ?= -s -w
TEST_FLAGS ?= -race -p 1
export CGO_ENABLED := 1

build:
	go build -tags '$(GO_TAGS)' -trimpath -ldflags='$(LDFLAGS)' -o bin/pocketmark ./cmd/pocketmark
test:
	go test $(TEST_FLAGS) -tags '$(GO_TAGS)' ./...
	node --test internal/webui/*.test.cjs
test-extension:
	node --test extension/*.test.cjs
fmt-check:
	@test -z "$$(gofmt -l cmd internal)" || { gofmt -l cmd internal; exit 1; }
check: fmt-check
	go vet -tags '$(GO_TAGS)' ./...
	node --check internal/webui/static/theme.js
	node --check internal/webui/static/workspace.js
	node --check internal/webui/static/reader.js
	node --check internal/webui/static/bulk.js
	node --check internal/webui/static/app.js
	node --check internal/webui/static/sw.js
	node --check internal/webui/static/api-docs/docs.js
	@for source in extension/*.js; do node --check "$$source" || exit; done
	python3 -m py_compile scripts/*.py extension/package.py
release-check:
	goreleaser check --config .goreleaser.yaml
	goreleaser check --config .goreleaser-publish.yaml
release-snapshot:
	goreleaser release --snapshot --clean --config .goreleaser.yaml
run: build
	./bin/pocketmark
