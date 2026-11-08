.PHONY: preflight build frontend test run check fmt-check test-extension release-check release-snapshot
GO_TAGS := sqlite_fts5 sqlite_omit_load_extension
LDFLAGS ?= -s -w
TEST_FLAGS ?= -race -p 1
export CGO_ENABLED := 1

frontend/node_modules/.package-lock.json: frontend/package.json frontend/package-lock.json
	npm ci --prefix frontend --ignore-scripts --no-audit --no-fund
frontend: frontend/node_modules/.package-lock.json
	npm run build --prefix frontend
build: frontend
	go build -tags '$(GO_TAGS)' -trimpath -ldflags='$(LDFLAGS)' -o bin/pocketmark ./cmd/pocketmark
test: frontend
	go test $(TEST_FLAGS) -tags '$(GO_TAGS)' ./...
	node --test internal/webui/*.test.cjs
	npm test --prefix frontend
preflight:
	python3 scripts/preflight.py
test-extension:
	node --test extension/*.test.cjs
fmt-check:
	@test -z "$$(gofmt -l cmd internal)" || { gofmt -l cmd internal; exit 1; }
check: frontend fmt-check
	npm run check --prefix frontend
	python3 scripts/sync_ui_assets.py
	go vet -tags '$(GO_TAGS)' ./...
	node --check internal/webui/static/name-limit.js
	node --check internal/webui/static/theme-switch.js
	node --check internal/webui/static/theme.js
	node --check internal/webui/static/asset-preview.js
	node --check internal/webui/static/select.js
	node --check internal/webui/static/sw.js
	node --check internal/webui/static/api-docs/docs.js
	node --check e2e/selection.mjs
	node --check e2e/selectors.mjs
	node --check e2e/extension-selectors.mjs
	node --check e2e/navigation.mjs
	node --check e2e/fidelity.mjs
	node --check e2e/polish.mjs
	node --check e2e/browser.mjs
	node --check e2e/react.mjs
	node --check e2e/security.mjs
	node --check e2e/settings.mjs
	@for source in extension/*.js; do node --check "$$source" || exit; done
	python3 -m py_compile scripts/*.py extension/package.py
release-check:
	goreleaser check --config .goreleaser.yaml
	goreleaser check --config .goreleaser-publish.yaml
release-snapshot:
	goreleaser release --snapshot --clean --config .goreleaser.yaml
run: build
	./bin/pocketmark
