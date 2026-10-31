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

## Development workflow

1. Work on a dedicated branch, read the relevant implementation and tests, and make focused changes.
2. At the end of every development task, including documentation changes, fetch `origin/main`, then launch a code-review subagent against the complete task diff from its merge-base with `origin/main`, including committed, staged and unstaged changes and newly added files. Give it the request, relevant repository instructions and validation results; have it check correctness, regressions and compliance with the request. Apply its recommendations, rerun affected checks, and have it review the corrections until no actionable findings remain. Document any recommendation rejected with a concrete rationale in the PR.
3. Run the applicable local checks above, review the diff and staged paths, and complete the redacted secret scan before committing.
4. Commit with a Conventional Commit message and push the branch to the remote.
5. Create a pull request targeting `main` (or update the existing PR for the branch). Describe the resulting behavior, subagent review outcome and validation performed.
6. Keep the branch up to date with `origin/main`. Resolve merge conflicts yourself by reading both sides and preserving the intended behavior and unrelated changes; verify that no conflict markers remain. After conflict resolution or subsequent development changes, repeat the subagent review and applicable local checks before pushing.
7. Monitor CI for the latest pushed commit. Fix failures, rerun the relevant local checks, and push corrections until every required check, including `CI passed`, is green. Pending, failed, cancelled or skipped required checks do not satisfy this gate.
8. Once every required check passes and the subagent review is complete, verify that the PR is conflict-free and its head matches the validated commit, then squash-merge the development PR automatically without asking for confirmation. Preserve the validated PR title and respect branch protection; if the head changes, repeat the review, validation and CI gates for the new commit. Release Please version PRs still require an explicit publication request before merging.
9. Before reporting completion, verify that the PR is merged and provide the PR link, subagent review outcome and CI result. If review, conflict resolution, CI or merging is blocked, report the blocker explicitly.
