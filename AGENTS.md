# Pocketmark contributor instructions

Pocketmark: personal bookmark manager built for low server RAM. One Go process (stdlib HTTP,
pgx/PostgreSQL), embedded React + shadcn/ui frontend (Vite), Chrome capture extension,
Floccus/WebDAV sync. Out of scope: collaboration, public sharing, SSO/OIDC; server-side page
rendering; automations beyond owner-enabled AI tagging.

Rules: read the owning code and tests before editing; preserve user data and unrelated changes;
prefer stdlib and bounded, disk-backed work; justify any new process, dependency or in-memory cache
against the RAM goal.

## Where to look

- Cross-module changes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Persisted data or startup: `internal/store/` migrations; add a legacy-database/restart test
- Auth, fetching, archives: [docs/API.md](docs/API.md), [docs/ARCHIVES.md](docs/ARCHIVES.md);
  keep origin checks, SSRF filtering, request limits, bounded queues. Failures:
  [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md#investigating-an-incident)
- Clients and Floccus: [docs/FEATURES.md](docs/FEATURES.md), [docs/REAL_CLIENTS.md](docs/REAL_CLIENTS.md)
- UI, API docs, extension, branding: [DESIGN.md](DESIGN.md), [docs/FRONTEND.md](docs/FRONTEND.md),
  [design review](docs/CI.md#design-review). Reuse `internal/webui/static/icon.svg`. If the README
  library screenshot changes, refresh `docs/pocketmark-dark-preview.jpg` from disposable data.

## Hygiene

- Use disposable data and profiles. Never commit secrets, personal databases, `.env`, raw logs,
  tool sessions, downloaded clients or binaries.
- Generated evidence (reports, audits, benchmarks, screenshots, traces) goes outside the repo or in
  ignored `reports/` / `artifacts/`, never `docs/`. Check staged paths before committing.
- Do not commit `docs/adr/` files; keep ADRs local and untracked via `.git/info/exclude`.

## Development workflow

Develop and test locally, against a Docker image built from your working tree. Needs Go (see
`go.mod`), a C compiler, Make, Node.js 24, Python 3 and Docker. Setup problems:
[docs/CI.md](docs/CI.md#local-preflight-and-failure-records).

1. Create a dedicated branch.
2. Edit the code. Format and sync shared assets when needed:

   ```sh
   gofmt -w cmd internal
   python3 scripts/sync_ui_assets.py --write
   ```

3. Build the image and start the stack (app on <http://127.0.0.1:8091>, PostgreSQL included,
   throwaway data in Docker volumes). Re-run after each change:

   ```sh
   make up
   ```

4. Try the change in the browser. Stop the stack, and add `-v` to the command to also delete its data:

   ```sh
   docker compose -f compose.dev.yaml down
   ```

5. Run the checks before opening a PR. Integration tests need PostgreSQL 18 tools and
   `POCKETMARK_TEST_DATABASE_URL` (role with CREATEDB). Use `TEST_FLAGS` for focused runs.

   ```sh
   make check
   make test
   make test-extension
   make build
   ```

6. For Dockerfile or container changes, smoke-test the image:

   ```sh
   docker build -t pocketmark:ci .
   python3 scripts/smoke_docker.py --image pocketmark:ci
   ```

7. Review the full diff with a subagent (interface changes also need `design-reviewer`), scan for
   secrets, then commit with a Conventional Commit message.
8. Open a PR to `main`, wait for green CI, squash-merge. Policy:
   [docs/CI.md](docs/CI.md#development-and-merge-policy).

Deploying: read [docs/GUIDE.md](docs/GUIDE.md) (binaries: also [docs/RELEASE_INSTALL.md](docs/RELEASE_INSTALL.md)).
Releases: [docs/RELEASE.md](docs/RELEASE.md); merge version PRs or tag only on explicit request.
