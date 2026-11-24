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
- Persisted data or startup: `internal/store/` migrations (`Store.Open` owns initialization); add a
  legacy-database/restart test
- Auth, fetching, archives: [docs/API.md](docs/API.md), [docs/ARCHIVES.md](docs/ARCHIVES.md);
  keep origin checks, SSRF filtering, request limits, bounded queues, streamed asset I/O. Failures:
  [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md#investigating-an-incident)
- Clients and Floccus: [docs/FEATURES.md](docs/FEATURES.md), [docs/REAL_CLIENTS.md](docs/REAL_CLIENTS.md)
- UI, API docs, extension, branding: [DESIGN.md](DESIGN.md), [docs/FRONTEND.md](docs/FRONTEND.md),
  [design review](docs/CI.md#design-review). Reuse `internal/webui/static/icon.svg`. If the README
  library screenshot changes, refresh `docs/pocketmark-dark-preview.jpg` from disposable data and verify it matches.

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

1. Create a dedicated branch in its own git worktree (one worktree per task; never share one).
2. Edit the code, then (re)start the stack. Idempotent; prints the app URL:

   ```sh
   make up
   ```

3. Try the change in the browser at the printed URL.
4. For any code change, run all four checks. Integration tests need PostgreSQL 18 tools and
   `POCKETMARK_TEST_DATABASE_URL` (role with CREATEDB). Use `TEST_FLAGS` for focused runs.

   ```sh
   make check
   make test
   make test-extension
   make build
   ```

5. Review the full diff with a subagent (interface changes also need `design-reviewer`), scan for
   secrets, then commit with a Conventional Commit message.
6. Push the branch and open a PR to `main` with `gh pr create`.
7. Make sure CI is green; otherwise fix the failures, push again and iterate. Policy:
   [docs/CI.md](docs/CI.md#development-and-merge-policy).
8. Before removing the worktree, delete its stack and data. Idempotent:

   ```sh
   make down
   ```

### Parallel worktrees

Each worktree gets its own 10-port block (8000-8079, in `.env.worktree`, git-ignored), Compose
project and image tag, so stacks run in parallel.

- Use only `make up` / `make down`; never a bare `docker compose`, `docker run --name`, or another
  worktree's project.
- Never hard-code ports or container/volume/image names; use the URL `make up` prints.
- Not isolated: the test database (`POCKETMARK_TEST_DATABASE_URL`) and hand-numbered migrations in
  `internal/store/`.

Deploying: read [docs/GUIDE.md](docs/GUIDE.md) (binaries: also [docs/RELEASE_INSTALL.md](docs/RELEASE_INSTALL.md)).
Use a version-pinned GHCR image or release binary; keep `/data`, the server secret, loopback binding
and limits; set up account/MFA first; use HTTPS and the exact `POCKETMARK_ORIGIN`.
Optional RAM benchmarks: [docs/BENCHMARK.md](docs/BENCHMARK.md).
Releases: [docs/RELEASE.md](docs/RELEASE.md); merge version PRs or tag only on explicit request.
