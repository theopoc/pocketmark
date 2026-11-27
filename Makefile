.PHONY: preflight build frontend test run up down check fmt-check test-extension release-check release-snapshot
LDFLAGS ?= -s -w
TEST_FLAGS ?= -race -p 1

frontend/node_modules/.package-lock.json: frontend/package.json frontend/package-lock.json
	npm ci --prefix frontend --ignore-scripts --no-audit --no-fund
frontend: frontend/node_modules/.package-lock.json
	npm run build --prefix frontend
build: frontend
	go build -trimpath -ldflags='$(LDFLAGS)' -o bin/pocketmark ./cmd/pocketmark
# With a `make up` stack, backup tests also run against its Garage bucket.
test: frontend
	@set -a; if [ -f .env.worktree ]; then eval "$$(grep '^POCKETMARK_TEST_S3_' .env.worktree)"; fi; set +a; \
	echo "go test $(TEST_FLAGS) ./... ($${POCKETMARK_TEST_S3_ENDPOINT:-no S3 endpoint})"; \
	go test $(TEST_FLAGS) ./...
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
	go vet ./...
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
	node --check e2e/reader-body.mjs
	node --check e2e/reader-code.mjs
	node --check e2e/reader-images.mjs
	node --check e2e/security.mjs
	node --check e2e/settings.mjs
	@for source in extension/*.js; do node --check "$$source" || exit; done
	python3 -m py_compile scripts/*.py extension/package.py
release-check:
	goreleaser check --config .goreleaser.yaml
release-snapshot:
	goreleaser release --snapshot --clean --config .goreleaser.yaml
run: build
	./bin/pocketmark
up:
	@scripts/dev_env.sh compose rm --stop --force dev-garage
	@scripts/dev_env.sh compose up --build --wait
	@scripts/dev_env.sh print | sed -n 's/^POCKETMARK_DEV_URL=/app: /p; s/^POCKETMARK_DEV_S3_URL=/s3:  /p'
down:
	@scripts/dev_clean.sh
