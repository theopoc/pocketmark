# Pocketmark contributor instructions

## Project rules

Pocketmark is a personal bookmark manager built for low server RAM: one Go process
with standard-library HTTP routing, PostgreSQL through pgx, an embedded React + shadcn/ui frontend compiled
with Vite, a Chrome capture extension and
Floccus/WebDAV sync. Deploy with Docker Compose or a standalone Linux binary.
Keep page rendering in the user's browser;
collaboration, public sharing, SSO/OIDC and product automations are out of scope.

Read the owning implementation and nearby tests before editing. Preserve library
data and unrelated changes. Prefer the standard library and bounded, disk-backed
work; justify new processes, dependencies, caches and in-memory indexes against
the RAM goal.

## Read before changing

- For changes spanning modules, start with the [ownership map and tests](docs/ARCHITECTURE.md).
- For persisted data, initialization or restart behavior, inspect `internal/store/`
  migrations and add a legacy-database/restart regression. `Store.Open` owns
  initialization. For other store edits, identify the affected behavior and its tests.
- For authentication, fetching or archives, read [API limits](docs/API.md) and
  [archive boundaries](docs/ARCHIVES.md). Preserve origin checks, SSRF filtering,
  request limits, bounded queues and streamed asset I/O. For failed requests or
  capture diagnostics, use the [incident guide](docs/OBSERVABILITY.md#investigating-an-incident).
- For client compatibility or Floccus, read [feature coverage](docs/FEATURES.md)
  and [dated client evidence](docs/REAL_CLIENTS.md).
- For interface changes to the web app, rendered API docs or extension, follow
  [DESIGN.md](DESIGN.md). Written API reference edits use [the API guide](docs/API.md).
  If the library page shown in the README changes, refresh
  `docs/pocketmark-dark-preview.jpg` from the rendered page with disposable data
  and verify it matches. Follow the [design and branding review](docs/CI.md#design-review)
  requirements.
- Branding: reuse the canonical `internal/webui/static/icon.svg` and synchronize
  shared UI assets with the command below.

## Verification and delivery

Requirements: Go from `go.mod`, a C compiler, Make, Node.js 24 with npm and Python 3.
Frontend architecture, dependency updates and development: [frontend guide](docs/FRONTEND.md).
Make installs locked frontend dependencies and compiles assets before Go checks, tests and builds.
Integration tests require PostgreSQL 18 client tools and a disposable cluster. Set POCKETMARK_TEST_DATABASE_URL to a database URI for a role with CREATEDB. The race detector requires a C compiler.

For code changes, run all four commands:

```sh
make check           # Check formatting, vet, syntax and shared assets
make test            # Go race tests and embedded UI regressions
make test-extension  # Chrome extension regressions
make build           # Build bin/pocketmark
```

When needed:

```sh
gofmt -w cmd internal                     # Fix Go formatting
python3 scripts/sync_ui_assets.py --write # Synchronize shared UI assets

# Container changes
docker build -t pocketmark:ci .
python3 scripts/smoke_docker.py --image pocketmark:ci
```

For environment failures, see [local preflight and failure records](docs/CI.md#local-preflight-and-failure-records).
Use `TEST_FLAGS` for focused runs, then run the relevant full suite.
For CI/release tooling changes, run the applicable [additional checks](docs/CI.md#reproduce-locally).
Live-network RAM benchmarks are optional; follow [measurement boundaries](docs/BENCHMARK.md).

Use disposable data and browser/device profiles. Keep secrets, personal databases,
`.env` files, raw request logs, tool sessions, downloaded clients and binaries out
of commits. Store generated evidence (reports, audits, research notes, benchmark
results, validation records, screenshots, traces and profiles) outside the repo or
in ignored `reports/` or `artifacts/`, never under `docs/`. Maintained guides,
benchmark scripts, regression fixtures and documentation illustrations belong in
version control.
Review the diff and staged paths for generated evidence before committing.

## Development workflow

Local investigations end with their report in ignored `reports/` or outside the repo.
For every tracked change, including documentation, follow the
[development and merge policy](docs/CI.md#development-and-merge-policy): dedicated
branch, complete-diff subagent review, applicable checks and redacted secret scan,
Conventional Commit, PR to `main`, and required CI passing at the latest reviewed
head. Interface changes also require the project-local design reviewer. Resolve
conflicts, re-review corrections, squash-merge automatically with the validated PR
title, and verify the merged state. Report the PR link, review outcome, CI result
and any blocker.

## Deployment and releases

Before deployment, read [configuration and backups](docs/GUIDE.md); for binaries,
also read [Linux installation](docs/RELEASE_INSTALL.md). Use a version-pinned private GHCR
image with authenticated pulls, or a release binary. Preserve `/data`, the server
secret, loopback binding, resource limits and security settings. Complete account/MFA
setup before exposure; use HTTPS and the exact public `POCKETMARK_ORIGIN`.

Before changing or publishing releases, read [release instructions](docs/RELEASE.md).
Merge version PRs or create version tags only on an explicit publication request.
Workflows publish artifacts; server deployment is manual.
