# Pocketmark contributor instructions

Pocketmark is a personal bookmark manager whose primary constraint is low server RAM. Keep one Go process, SQLite/FTS5 and the embedded dependency-free UI. Page rendering belongs in the user's browser. Collaboration, public sharing, SSO/OIDC and product automations are outside the supported scope.

## Before changing behavior

- Read the owning implementation and nearby tests. Preserve existing library data and unrelated edits.
- For storage changes, read `internal/store/` migrations and add a legacy-database/restart regression. SQLite runs through CGO with the build tags defined in `Makefile`; a plain `CGO_ENABLED=0` build is unsupported.
- For authentication, network fetching or archives, read [API limits](docs/API.md) and [archive boundaries](docs/ARCHIVES.md). Preserve origin checks, SSRF filtering, request limits, bounded queues and streamed asset I/O.
- For client compatibility or Floccus changes, consult [feature coverage](docs/FEATURES.md) and [actual client evidence](docs/REAL_CLIENTS.md). Distinguish protocol tests, real-client observations and untested clients; Android's prolonged-offline cache limitation is unresolved upstream.
- Prefer standard-library solutions and bounded disk-backed work. Justify any new resident process, in-memory index, cache or dependency against the RAM goal.

## Verification and delivery

Run `make check`, `make test`, `make test-extension` and `make build` for code changes. Use `TEST_FLAGS` to narrow development runs, then complete the relevant full suite before delivery. With limited local disk, `CGO_CFLAGS='-O2 -g0'` reduces build intermediates. For container changes, run `python3 scripts/smoke_docker.py --image <built-image>`. Live-network RAM benchmarks are optional, separate from deterministic CI; follow [measurement boundaries](docs/BENCHMARK.md).

Use disposable data and browser/device profiles for integration work. Keep access tokens, personal databases, `.env` files, raw request logs, tool sessions, downloaded clients and generated binaries outside commits. Curated synthetic screenshots and benchmark summaries in `docs/` are maintained evidence, not application data. Review staged paths and run a redacted secret scan before pushing.

Keep commits focused and use Conventional Commits. [CI and release instructions](docs/CI.md) define the required checks and tag-based release process. Releases must use the artifacts tested by CI and publish only after every gate passes. A version tag is an explicit publication action; create one only when requested.
