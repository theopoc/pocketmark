# Pocketmark contributor instructions

## Project stack

Pocketmark is a personal bookmark manager built for low server RAM:

- One Go process with standard-library HTTP routing.
- SQLite/FTS5 through CGO; use the build tags in `Makefile`.
- Embedded HTML, CSS and vanilla JavaScript; no frontend build step.
- A Chrome extension for browser-side captures and Floccus sync over WebDAV.
- Docker Compose or a standalone Linux binary for self-hosting.

Keep page rendering in the user's browser. Collaboration, public sharing,
SSO/OIDC and product automations are outside the supported scope.

## Architectural conventions

| Location | Responsibility |
| --- | --- |
| `cmd/pocketmark/` | Configuration, process lifecycle and capture worker. |
| `internal/store/` | SQLite schema/migrations, queries and disk-backed work files. |
| `internal/server/` | HTTP API, authentication, WebDAV and asset delivery. |
| `internal/capture/` | Bounded page fetching, extraction and offline archives. |
| `internal/webui/` | Embedded browser UI and Node.js regression tests. |
| `internal/observability/` | Logs, metrics and optional tracing. |
| `extension/` | Chrome extension and its regression tests. |

Read the owning implementation and nearby tests before editing. Preserve existing
library data and unrelated changes. Prefer the standard library and bounded,
disk-backed work; justify new processes, dependencies, caches or in-memory indexes
against the RAM goal.

- Storage: read `internal/store/` migrations and add a legacy-database/restart
  regression. `Store.Open` owns persistence initialization; HTTP construction does not.
- Authentication, fetching or archives: read [API limits](docs/API.md) and
  [archive boundaries](docs/ARCHIVES.md). Preserve origin checks, SSRF filtering,
  request limits, bounded queues and streamed asset I/O.
- Client compatibility or Floccus: read [feature coverage](docs/FEATURES.md) and
  [real-client evidence](docs/REAL_CLIENTS.md). Distinguish protocol tests from
  observed and untested clients; Android's prolonged-offline cache issue remains upstream.
- Interface changes: read [DESIGN.md](DESIGN.md), the source of truth for current
  design rules, before editing the web UI, API documentation or extension UI.
  Dated UI validation reports record historical evidence, not additional design rules.

## Verification and delivery

Development requires Go (see `go.mod`), a C compiler, Make, Node.js and Python 3.
CGO is required; `CGO_ENABLED=0` builds are unsupported. For code changes, run:

```sh
make check           # Formatting, vet and syntax checks
make test            # Go race tests and embedded UI regressions
make test-extension  # Chrome extension regressions
make build           # Build bin/pocketmark with SQLite tags
```

Use `TEST_FLAGS` for focused development runs, then run the relevant full suite.
With limited disk, `CGO_CFLAGS='-O2 -g0'` reduces build intermediates.
For container changes, build an image and run
`python3 scripts/smoke_docker.py --image <built-image>`.
For CI/release tooling changes, use the additional checks in [CI](docs/CI.md#reproduce-locally).
Live-network RAM benchmarks are optional; follow [measurement boundaries](docs/BENCHMARK.md).

Use disposable data and browser/device profiles. Keep secrets, personal databases,
`.env` files, raw request logs, tool sessions, downloaded clients and binaries out
of commits. Curated synthetic screenshots and benchmark summaries belong in `docs/`.
Review the diff and staged paths and run a redacted secret scan before committing.

## Development workflow

For every task, including documentation, follow the detailed
[development and merge policy](docs/CI.md#development-and-merge-policy):

1. Work on a dedicated branch with focused changes.
2. Fetch `origin/main`; have a code-review subagent review the complete task diff
   from its merge-base, including committed, staged, unstaged and new files.
   Supply the request, repository instructions and validation results. Apply
   recommendations, rerun affected checks and re-review until no actionable findings remain.
3. For interface changes, also launch the project-local `design_reviewer` defined
   in [.codex/agents/design_reviewer.toml](.codex/agents/design_reviewer.toml).
   Supply the request, merge-base, complete diff, validation results and disposable
   preview or before/after evidence. If named custom agents are unavailable, launch
   a subagent with that file's `developer_instructions`. Apply actionable findings
   and re-review corrections; record coverage and anything unverified in the PR.
4. Complete applicable checks and secret scanning; commit with a Conventional
   Commit message, push and create/update a PR to `main`. Record behavior,
   validation, review outcome and concrete reasons for any rejected recommendations.
5. Keep the branch current and resolve conflicts while preserving both sides' intent.
   Repeat review and checks after corrections or conflict resolution; monitor CI
   until every required check, including `CI passed`, succeeds at the latest head.
6. Verify the reviewed head is current and conflict-free, then automatically
   squash-merge with the validated PR title, respecting branch protection.
   Verify the merged state and report the PR link, review outcome and CI result;
   report any blocker explicitly.

## Deployment and releases

- Deploy a version-pinned private GHCR image with authenticated pull access, or a
  [Linux release binary](docs/RELEASE_INSTALL.md). Keep Compose's persistent `/data`
  volume, loopback port binding, resource limits and security settings.
- Complete account/MFA setup before exposing the instance. Use an HTTPS reverse
  proxy and set `POCKETMARK_ORIGIN` to the exact public origin. Preserve the complete
  data directory and server secret; follow [configuration and backups](docs/GUIDE.md).
- Merging a development PR runs main CI and may update a Release Please version PR.
  Merge version PRs or create version tags only on an explicit publication request.
- Releases package the exact native AMD64/ARM64 binaries validated by main CI.
  After GitHub publication, containers reuse those binaries; Compose/Chromium tests
  gate image publication, then both published platforms are qualified.
  Workflows publish artifacts; server deployment is manual. Read
  [CI and release instructions](docs/CI.md) before changing or publishing releases.
