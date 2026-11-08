# Contributor workflow and CI

## Development and merge policy

Use short-lived branches from current `main`, one focused PR per change, and a Conventional Commit title such as `fix(api): reject invalid tokens`. CI validates the title on PR creation, new commits, reopening and metadata edits. The squash commit drives Release Please, so preserve that validated title when merging. A `!` requests a breaking release. Avoid long-lived `develop` or release branches for this single-maintainer project.

Repository settings observed on 2026-10-23 allowed only squash merges, used the PR title for the squash commit and deleted merged branches. Check live repository settings for enforcement and [the CI workflow](../.github/workflows/ci.yml) for job definitions. The project requires a PR, resolved review threads, linear history, and all nine [CI job results](#ci-jobs) from the GitHub Actions app (integration ID 15368), with the branch up to date. It blocks deletion and force pushes, with no bypass actors. Zero required human approvals is intentional for personal maintenance; review the diff and evidence before merging. A repository setting, rather than workflow YAML, enforces this policy. Do not merge on an earlier commit's green checks. [GitHub required-check semantics](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks).

For every tracked change, including documentation, use this delivery procedure:

1. Work on a dedicated branch with focused changes. Refresh `origin/main` and
   inspect the complete task diff:

   ```sh
   git fetch origin main
   git status --short
   base=$(git merge-base HEAD origin/main)
   git diff "$base"
   git diff --cached "$base"
   git ls-files --others --exclude-standard
   ```

   Compare both the working tree and index against the merge-base so staged
   changes remain visible even if undone only in the working tree.
   Read the contents of every relevant new file listed by `git ls-files` too.
2. Launch a code-review subagent with the request, repository instructions,
   merge-base, complete diff and validation results. Apply actionable findings,
   rerun affected checks and re-review corrections until none remain. Interface
   changes also require the [design review](#design-review) below.
3. Complete the [applicable local checks](../AGENTS.md#verification-and-delivery).
   Stage only intended files, inspect them for generated evidence and scan the
   staged changes for secrets with the pinned, redacted Gitleaks hook:

   ```sh
   git diff --cached
   git diff --cached --check
   pre-commit run gitleaks
   ```

   See [hook setup](#local-pre-commit-hooks) for prerequisites. Commit with a
   Conventional Commit message, push and create/update a PR to `main`. Record
   resulting behavior, compatibility impact, checks, secret scanning, review
   outcome and any rejected recommendation with its concrete rationale in the PR.
4. Keep the branch current with `origin/main`. Resolve conflicts autonomously,
   reading both sides to preserve intended behavior and unrelated changes; verify
   no conflict markers remain. Conflict resolutions, subsequent changes and CI
   fixes require renewed subagent review and applicable local checks before
   pushing, then CI on the latest pushed commit.
5. Once review is complete and every required check succeeds, verify the PR is
   conflict-free, up to date and still at the validated head. Squash-merge
   automatically without asking for confirmation, using the validated PR title
   and respecting branch protection. A changed head requires renewed review,
   local validation and CI; pending, failed, cancelled or skipped required checks
   do not authorize merge. Verify the merged state and report the PR link, review
   outcome, CI result and any blocker.

This procedure is an agent delivery responsibility, not a new GitHub Actions
merge workflow; eligible Dependabot PRs use the separate automation below.

For a normal PR, merging updates `main` and may update a Release Please PR. Release Please version PRs still require an explicit publication request before merging: merging one authorizes publication, so review its version and notes first. Release tags matching `v*` cannot be updated or deleted under the separate active tag ruleset.

### Design review

For interface changes, launch the project-local `design_reviewer` defined in
[.codex/agents/design_reviewer.toml](../.codex/agents/design_reviewer.toml). Supply
the request, merge-base, complete diff, validation results and a disposable preview
or before/after evidence. If named custom agents are unavailable, launch a subagent
with that file's `developer_instructions`. Apply actionable findings and re-review
corrections; record inspected surfaces, states and unverified coverage in the PR.
Current design rules belong to [DESIGN.md](../DESIGN.md); generated evidence stays
outside version control.

For branding changes, inventory and verify initialization, sign-in/MFA,
library/navigation, settings, API documentation, favicon/installable app, extension
and README in both themes and desktop/phone layouts where applicable. Verify
packaged assets and run `python3 scripts/sync_ui_assets.py` to check shared assets.

## Local preflight and failure records

Run `make preflight` when preparing validation or diagnosing an environment failure. It reports the configured tools, cache and temporary storage, loopback access and installed frontend/browser prerequisites. Run the applicable checks after resolving any missing prerequisite. The four local Make targets and the required CI jobs remain the delivery gates.

When a check fails, record one short entry in the PR validation section, or in ignored `reports/` for a local investigation. Include the revision and base, stage and host, brief error signature, expected and observed result, comparison on the unchanged base (or “untested”), disposition and next action. Use the first failing operation as well as the final exit. Distinguish a blocked environment, an expected probe result and a failed behavior assertion. Keep transcripts, request content and credentials out of the entry.

Example: `revision <head>, base <base> | Chromium on macOS | selection-count-timeout | expected one selected and reader closed, observed zero | reproduced on base | open | check native modifier`.

Review the next ten changes that exercise these checks. Count recurring signatures and how many failures could be classified from the first run. Use those counts to decide which recipes need improvement.

## CI jobs

One unfiltered `ci.yml` workflow runs on PR creation, source changes, reopening,
title edits and readiness changes; on every main push; on manual dispatch; and
on Mondays at 05:23 UTC. Every run executes the full suite, including
PRs that change only documentation or the extension. Independent jobs start in
parallel; there is no path-selection job or final aggregation job. Main runs
retain native binaries at the exact source revision. Scheduled runs never publish
a release.

| Phase | Checks and outputs |
| --- | --- |
| Quality | Commitlint validates the PR title; formatting/vet, module checksums/tidy, syntax, actionlint and GoReleaser config. |
| Security | Full-history redacted Gitleaks, reachable Go vulnerabilities, npm audits, vendored Swagger byte equality and Retire.js bundle scanning. High/critical vulnerabilities block. |
| SAST | Separate parallel CodeQL security-extended jobs for Go and JavaScript; unreviewed findings or missing/incremental results fail CI. |
| Tests, AMD64 and ARM64 | Native race tests and atomic coverage, with at most two packages built/tested concurrently. UI regressions remain on both; Python/release-expression regressions and Chromium selector checks run once on AMD64. |
| Extension | Syntax, regressions, Chromium selector checks and installable ZIP validation. |
| Build, AMD64 and ARM64 | Native musl static binaries and build metadata, retained for 90 days. |
| Docker release | Incorporate validated native executables; test candidate digests with Compose/Chromium before publishing and qualifying the tag. |

The project requires the **Protect main** ruleset to enforce all nine job results from GitHub Actions:
`Quality`, `Security`, `SAST (go)`, `SAST (javascript-typescript)`, `Tests (amd64)`,
`Tests (arm64)`, `Build (amd64)`, `Build (arm64)` and `Extension`. These jobs have no
job-level conditions or dependencies that could skip them. Matrices use
`fail-fast: false`. Keep the ruleset synchronized when renaming jobs or changing
matrix entries. The obsolete `CI passed` check is no longer required.

### Go caches and timings

The local `go-cache` action disables setup-go's combined automatic cache. Modules
use a dependency-hash cache. Compiled packages use distinct quality, security,
race/coverage and musl modes, keyed by OS, architecture, Go/C toolchain, dependencies,
Makefile and cache-action revision. Each source SHA can save an enriched cache;
compatible earlier entries are restored by prefix. GitHub scopes PR caches to
their refs and applies its cache quota/eviction policy; they are disposable
accelerators, never release artifacts. No cache hit skips tests: `-count=1` stays.
Watch cache sizes and restore/save overhead as well as hit rates.

Each native test job emits package execution times and the twenty slowest tests
to its Actions summary. These exclude compilation, and parent/subtest times
must not be added. Tests retain race, atomic coverage and both SQLite tags.
Route-only fixtures reuse a precalculated synthetic password hash, checked once
against the production KDF; actual authentication tests still use the real KDF.
Databases and session state remain disposable and independent per test.

Actions use full commit SHAs; tool modules, pre-commit hooks and the Gitleaks engine are version-pinned. PR/main CI has read-only permissions and never builds or publishes Docker images. Superseded branch runs are cancelled; main runs are retained because a release may need their binaries. Coverage, container evidence and release bundles are retained for seven days.

The separate Dependabot workflow only reads verified PR metadata before enabling auto-merge; it never executes PR code. Release Please can maintain version PRs/drafts and dispatch CI on its branch. GitHub publication receives `contents:write`; only release image build/index jobs receive `packages:write`. Publication uses the short-lived `GITHUB_TOKEN` and needs no personal token or additional registry secret.

The module toolchain baseline is declared in `go.mod`; the Docker builder version is declared separately in `Dockerfile`. Review their alignment when either changes and keep both toolchains patched. A numerically newer Go minor version does not imply its patch level contains every security fix. Govulncheck remains blocking rather than suppressing standard-library reports.

The deterministic container smoke test does not depend on public websites. The separate live-page workload in [BENCHMARK.md](BENCHMARK.md) measures RAM and external capture behavior; CI smoke checks are not performance measurements or native mobile UI tests. Keep runtime data, tool sessions, downloaded clients, build output and generated validation evidence out of commits, following [AGENTS.md](../AGENTS.md#verification-and-delivery). Record check results and evidence limits in the PR; use ignored `reports/` or `artifacts/` directories for local outputs.

## Security analysis boundaries

CodeQL actions are SHA-pinned and run the bundled `security-extended` queries for
Go and JavaScript. `CODEQL_ACTION_DIFF_INFORMED_QUERIES: 'false'` disables automatic
PR diff filtering so the pre-merge gate evaluates the same complete source as
main. Both language jobs run on every PR and are individually required by branch
protection. The SARIF gate also rejects reports declaring an
incremental mode, even if they have no findings. The Go build uses the production SQLite tags with compilation
forced for extraction. JavaScript excludes test harnesses and compiled application bundles and upstream minified
vendor assets; the latter are covered by dependency scanning. Reports stay in
short-lived artifacts, without uploading databases or requiring code-scanning
write permissions. `check_sarif.py` makes unreviewed findings and absent/failed
analyses blocking checks before merging.

One reviewed false positive is accepted: `go/weak-sensitive-data-hashing` at the
API-key SHA256 verifier in `internal/server/authorization.go`. WebDAV transports
the server-generated 256-bit random key in the Basic password field; it is not a
human password. The exception matches the exact rule, source path and CodeQL line
fingerprint, plus SHA256 digests of the reviewed authentication and key-generation
source files. Any change to that context requires review before updating those
digests; other findings, locations or suppressions still fail. There is no blanket
rule exclusion or generated baseline. Existing API-key verifiers stay compatible.
Human passwords continue to use PBKDF2-SHA256 with 600,000 iterations; their
fixed-length outputs are compared directly in constant time.

The CI-only npm inventory under `tools/security/` pins Retire.js and Swagger UI.
The lockfile is audited, and `check_swagger_vendor.py` compares all five vendored
files with that exact installed package. Update the inventory and shipped files
together. Retire.js reads current advisory data and checks embedded libraries
that npm's top-level Swagger package metadata does not expose. `npm audit` also
checks the `frontend/`, `e2e/` and `tools/quality/` lockfiles, including Commitlint. High/critical
findings and scanner errors block; lower severities remain visible for review.
Dependabot watches all four npm inventories.
Neither scanner tools nor their node_modules are embedded in the application.

Reproduce JavaScript SCA locally:

```sh
npm ci --prefix tools/security --ignore-scripts --no-audit --no-fund
npm audit --prefix tools/security --audit-level=high
npm audit --prefix frontend --audit-level=high
npm audit --prefix e2e --audit-level=high
npm audit --prefix tools/quality --audit-level=high
python3 scripts/check_swagger_vendor.py
tools/security/node_modules/.bin/retire --path internal/webui/static/api-docs/vendor --severity high
```

For local image SCA with Syft 1.55.0 and Grype 0.121.0, generate a CycloneDX JSON
SBOM with `syft pocketmark:ci -o cyclonedx-json=artifacts/image-sbom.json`, then run
`grype sbom:artifacts/image-sbom.json --fail-on high`. The release gate runs both
on each exact AMD64/ARM64 candidate digest. No version is published by these
local checks. SBOM generation is inventory evidence, not a signed attestation.

## Local pre-commit hooks

Install [pre-commit](https://pre-commit.com/#install), then enable the checked-in configuration:

```sh
pre-commit install
pre-commit run --all-files
```

Hooks run on staged files before each commit. The first run creates isolated hook environments; the Gitleaks hook builds its pinned engine using Go, without a separate global Gitleaks installation. Go and Node.js must be on PATH. Formatting hooks update files; review and stage their changes before retrying the commit.

| Hook | Reason |
| --- | --- |
| Large files (1 MiB for newly added files) | Catch accidental binaries and data exports. |
| Merge and case conflicts | Reject unresolved merges and paths that collide on macOS/Linux. |
| JSON, YAML and TOML syntax | Validate manifests, workflows and tooling configuration without reformatting them. |
| Final newline and trailing whitespace | Keep diffs readable; preserve Markdown hard line breaks. |
| Gofmt and JavaScript syntax | Go checks, compiled React/shadcn assets, frontend ESLint/formatting and extension syntax. |
| Gitleaks | Scan the staged diff for secrets with redacted output before they enter history. |

Full Go vet/race tests, extension tests, builds, actionlint and container tests stay outside the hooks to keep commits fast and avoid requiring Docker or release tools for every edit. Run the applicable local checks required by [AGENTS.md](../AGENTS.md#verification-and-delivery); hooks complement local validation and CI rather than replacing them. Run `pre-commit autoupdate` deliberately and review version changes.

CI uses the [official Gitleaks action](https://github.com/gitleaks/gitleaks-action), pinned to a full commit SHA, with engine version 8.30.1. It selects the action's `workflow_dispatch` scan mode explicitly for every caller, scanning the complete checked-out history at the selected ref rather than the event's PR/push range. Comments, SARIF uploads and summaries are disabled; output remains redacted and repository permissions remain read-only. Personal-account repositories do not require a Gitleaks action license; organization-owned repositories require `GITLEAKS_LICENSE`.

## Dependency updates and PR titles

Dependabot checks Actions, Go modules and Docker base images weekly, with at most two open **version-update** PRs per ecosystem (security-update limits are separate). Each ecosystem groups minor and patch updates; major updates remain separate and require manual merge. Keep Actions pinned to full SHAs. Align changes to the Go directive and Docker compiler tag manually, and review the pinned tool versions embedded in `go run`, action inputs and download URLs: these are not all covered by Dependabot. A Docker update passing syntax checks alone is insufficient. [Dependabot options](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference).

Enable the repository's **Allow auto-merge** setting while retaining the active **Protect main** ruleset above. `dependabot-auto-merge.yml` handles PR creation, new commits, reopening and readiness for review. It only accepts non-draft PRs opened by `dependabot[bot]` from this repository. The SHA-pinned official `dependabot/fetch-metadata` action verifies Dependabot's signed commits; verification is never disabled. Its `update-type` is the highest semver change across the PR, so any major update in a group prevents automatic merge. Only explicit `version-update:semver-minor` and `version-update:semver-patch` metadata enable squash auto-merge; unknown or missing metadata fails closed. [Fetch Metadata documentation](https://github.com/dependabot/fetch-metadata/tree/v3.1.0).

The workflow uses `gh pr merge --auto --squash --match-head-commit` with the event's head SHA. GitHub waits for all nine required CI checks, an up-to-date branch and resolved review threads; it has no ruleset bypass. Failed, skipped, cancelled or pending CI cannot authorize merge. Keep all nine CI job results required from the GitHub Actions app with strict branch updates and no bypass actors: the workflow relies on this server-side enforcement. Existing open PRs are evaluated on their next supported PR event after the workflow reaches `main`. As with other operations performed using `GITHUB_TOKEN`, the resulting merge does not trigger push-based CI or Release Please; subsequent eligible pushes to `main` pick up the dependency commits. The PR's complete CI still gates its merge. CI regression tests evaluate the actual eligibility expressions; the independent required jobs provide the merge gate.

Commitlint runs in Quality with the conventional configuration and a locked
CI-only dependency inventory under `tools/quality/`. PR titles reach the CLI via
a quoted environment variable and stdin, never as shell source. Default ignored
messages are disabled, so merge/revert/version-like titles still need the
Conventional Commit format. Subject casing allows proper names such as Go and
SQLite. Commitlint's other conventional defaults apply, including a 100-character
header limit. Only the title is checked because it becomes the squash commit;
intermediate commits are not checked. Dispatch, push and scheduled runs validate
source rather than PR metadata. Metadata edits rerun the full suite and title
validation together. For a future busy repository, consider an independent
required metadata check and `merge_group` support before enabling a merge queue.

## Reproduce locally

Requirements: Go as declared by `go.mod`, a C compiler, Node.js 24, Python 3, `make`, and Docker Compose for the container test.

```sh
npm ci --prefix tools/quality --ignore-scripts --no-audit --no-fund
printf '%s\n' 'ci: simplify checks' | tools/quality/node_modules/.bin/commitlint --strict
make check
make test
make test-extension
python3 -m unittest discover -s scripts -p 'test_*.py' -v
make build
make release-check
docker build -t pocketmark:ci .
npm ci --prefix e2e --ignore-scripts --no-audit --no-fund
./e2e/node_modules/.bin/playwright install --with-deps chromium
node e2e/selectors.mjs
node e2e/extension-selectors.mjs
python3 scripts/smoke_docker.py --image pocketmark:ci --browser
```

The browser dependency is pinned and locked under `e2e/`; it is test tooling only and is not copied into the application image. The browser runs on the CI runner, outside the server's 128 MiB container limit. Selector checks cover the web UI and extension at desktop and narrow viewport sizes in both themes; the separate container browser journey exercises the running server. The amd64 Build job also runs the complete browser journey against its actual compiled binary before uploading that binary. `python3 scripts/smoke_frontend.py --binary bin/pocketmark` reproduces that journey with disposable data. These Chromium checks do not qualify Firefox, Safari, native mobile clients or full accessibility.

Extension regressions run once in their independent job on every run. Main, manual and scheduled runs always include it for complete release evidence. Selector Chromium checks run in ordinary source CI; the container journey runs during release, and ordinary source CI does not build containers.

The release expression regression checks use `@actions/expressions` only as a temporary CI/test tool; it is not an application or frontend dependency. They read the expression directly from the workflow and cover missing/empty PR outputs after a version PR is merged, ordinary opened PRs, and malformed output. Reproduce them locally with:

```sh
npm install --prefix /tmp/pocketmark-release-expressions --no-save --no-package-lock \
  --ignore-scripts --no-audit --no-fund @actions/expressions@0.3.61
ACTIONS_EXPRESSIONS_PATH=/tmp/pocketmark-release-expressions/node_modules/@actions/expressions/dist/index.js \
  node --test scripts/test_release_expressions.mjs
```

For local release packaging, see the [release rehearsal](RELEASE.md#rehearse-packaging-locally).

## Publish a version

[Version publication and recovery](RELEASE.md#publish-a-version).

## GHCR images

[Container build, qualification and backfill](RELEASE.md#ghcr-images).

### Development and publication flow

[Development and publication diagram](RELEASE.md#development-and-publication-flow).
