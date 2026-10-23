# CI and release

GitHub Actions runs on pushes to `main`, pull requests targeting `main` (including title edits), manual dispatch, and every Monday at 05:23 UTC. The weekly run uses the complete suite to detect new vulnerability advisories and runner/tool drift without a source change; it never calls the release workflow. Scheduled runs start only after this configuration reaches the default branch; GitHub can delay them or disable them after 60 days of inactivity in a public repository. Release Please also runs on pushes to `main`, preparing a version PR or handing a merged version PR to the release pipeline. A release calls the same CI at the tagged commit. Every gate must pass; failed, skipped or cancelled prerequisite jobs fail the final `CI passed` check.

| Gate | Checks and outputs |
| --- | --- |
| Quality | Conventional Commit PR title, Go formatting/vet, module checksums and tidy drift, JavaScript/Python syntax, extension regression tests, workflow/shell validation with actionlint, release-verification tests, actual release expressions evaluated with the pinned GitHub Actions expressions library, and both GoReleaser configurations. |
| Security | Gitleaks scans the complete checked-out Git history with redacted output. Govulncheck checks reachable Go dependency/standard-library vulnerabilities using the application's SQLite tags. |
| Test/build, AMD64 and ARM64 | Native Linux runners execute all Go race tests with coverage; musl builds static executables; the exact executables and build metadata become packaging inputs. |
| Docker, both architectures | Builds the normal Dockerfile natively and tests the actual hardened Compose configuration: health, authentication, FTS5, enabled capture rejecting a loopback destination, backup integrity, restart persistence and zero OOM/limit events. Each run owns and cleans its synthetic volume/network/container. |
| Artifacts | Native executables, coverage and sanitized Docker evidence are retained for seven days. Release runs additionally retain the six verified publication assets. |

Actions use full commit SHAs; tool modules and the downloaded Gitleaks archive are version-pinned, with SHA-256 verification for the archive. Review and update these pins deliberately. CI has read-only repository permissions, timeouts and cancellation of superseded branch runs. It executes pull-request code without publication credentials and uses no `pull_request_target`. Release Please receives `contents:write` and `pull-requests:write` to maintain version PRs and draft releases, plus `actions:write` to dispatch CI on the bot PR's branch. GitHub release publication separately receives `contents:write`; GHCR build/index jobs receive `packages:write`. No personal access token, external registry secret or paid security service is required for publication.

The compiler baseline is Go 1.26.10, matching the Docker builder. An initial local security scan on Go 1.27.1 found standard-library advisories; builds must use a patched toolchain. A numerically newer Go minor version does not imply its patch level contains every fix. Govulncheck remains blocking rather than suppressing standard-library reports.

The deterministic container smoke test does not depend on public websites. The separate live-page workload in [BENCHMARK.md](BENCHMARK.md) measures RAM and external capture behavior; CI smoke checks are not performance measurements or native mobile UI tests. Repository runtime data, tool sessions, downloaded clients, build output and raw HTTP traces are ignored. Maintained synthetic screenshots and summarized benchmark evidence remain in `docs/`.

## Development and merge policy

Use short-lived branches from current `main`, one focused PR per change, and a Conventional Commit title such as `fix(api): reject invalid tokens`. CI validates the title on PR creation, new commits, reopening and metadata edits. The squash commit drives Release Please, so preserve that validated title when merging. A `!` requests a breaking release. Avoid long-lived `develop` or release branches for this single-maintainer project.

The repository settings observed on 2026-10-23 allow only squash merges and delete merged branches. This audit set `squash_merge_commit_title` to `PR_TITLE`, so GitHub proposes the validated PR title even for a one-commit PR; the maintainer can still edit it at merge time. The active **Protect main** ruleset requires a PR, resolved review threads, linear history, and `CI passed` from the GitHub Actions app (integration ID 15368), with the branch up to date. It blocks deletion and force pushes, with no bypass actors. Zero required human approvals is intentional for personal maintenance; review the diff and evidence before merging. A repository setting, rather than workflow YAML, enforces this policy. Do not merge on an earlier commit's green checks. [GitHub required-check semantics](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks).

Merging remains an explicit maintainer action. The PR template records resulting behavior, compatibility impact, checks and secret scanning. For a normal PR, merging updates `main` and may update a Release Please PR. Merging the generated version PR authorizes publication: review its version and notes before doing so. Release tags matching `v*` cannot be updated or deleted under the separate active tag ruleset.

Dependabot checks Actions, Go modules and Docker base images weekly, with at most two open **version-update** PRs per ecosystem (security-update limits are separate). Actions are grouped; Go/Docker minor and patch updates are grouped, with major updates separate. Every update remains subject to the complete CI and manual merge; no auto-merge is configured. Keep Actions pinned to full SHAs. Align changes to the Go directive and Docker compiler tag manually, and review the pinned tool versions embedded in `go run`, action inputs and download URLs: these are not all covered by Dependabot. A Docker update passing syntax checks alone is insufficient. [Dependabot options](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference).

The title check uses PR-event metadata. Dispatch, push, scheduled and reusable release CI runs validate source rather than a PR title; these runs cannot attest to PR metadata. Metadata edits currently rerun the complete CI so the required aggregate reflects the new title. For a future busy repository, consider an independent required metadata check and `merge_group` support before enabling a merge queue.

See [the sourced pipeline research](CI_RESEARCH.md) and [the scored audit](CI_AUDIT.md) for rationale, evidence and remaining limitations.

## Reproduce locally

Requirements: Go as declared by `go.mod`, a C compiler, Node.js 24, Python 3, `make`, and Docker Compose for the container test.

```sh
make check
make test
make test-extension
python3 -m unittest discover -s scripts -p 'test_*.py' -v
make build
make release-check
docker build -t pocketmark:ci .
python3 scripts/smoke_docker.py --image pocketmark:ci
```

The release expression regression checks use `@actions/expressions` only as a temporary CI/test tool; it is not an application or frontend dependency. They read the expression directly from the workflow and cover missing/empty PR outputs after a version PR is merged, ordinary opened PRs, and malformed output. Reproduce them locally with:

```sh
npm install --prefix /tmp/pocketmark-release-expressions --no-save --no-package-lock \
  --ignore-scripts --no-audit --no-fund @actions/expressions@0.3.61
ACTIONS_EXPRESSIONS_PATH=/tmp/pocketmark-release-expressions/node_modules/@actions/expressions/dist/index.js \
  node --test scripts/test_release_expressions.mjs
```

Release tooling uses **GoReleaser OSS 2.18.3**, pinned in Actions. No Pro license or additional secret is required. Linux binaries require `musl-gcc` and matching native architecture because SQLite uses CGO. The native CI jobs compile and test them; GoReleaser's OSS `meta` archives then package those exact binaries with installation instructions. It generates the extension ZIPs and `SHA256SUMS` too. The single extension ZIP contains nine explicitly named production files, including its background worker, and declares `debugger` access. Tests and local data are never globbed into release archives.

For a local packaging rehearsal, download the `linux-amd64` and `linux-arm64` CI artifacts into `artifacts/linux-amd64/` and `artifacts/linux-arm64/`, retaining their executable and `.buildinfo.txt` files. With GoReleaser 2.18.3 installed, run:

```sh
make release-snapshot
python3 scripts/verify_release.py --directory dist --metadata artifacts \
  --commit "$(git rev-parse HEAD)" --output artifacts/verified
goreleaser release --snapshot --skip=archive --clean --config .goreleaser-publish.yaml
```

Use artifacts built from the current clean commit; verification rejects another revision. The output directory must be new. `artifacts/verified/` contains only the six approved assets, separate from GoReleaser's temporary metadata in `dist/`.

## Publish a version

The normal release entry point is **merging the Release Please version PR**. On each push to `main`, Release Please reads Conventional Commits and opens or updates a PR containing `CHANGELOG.md`, `version.txt` and `.release-please-manifest.json`. `feat:` requests a minor bump, `fix:` a patch bump, and `!` or a `BREAKING CHANGE:` footer a major bump. Commits such as `docs:` and `ci:` alone do not request a release. With no previous published tags/releases, the first version is `0.1.0`. The Chrome extension keeps its independent manifest version.

Review and squash-merge the version PR when ready to publish; keep its generated title and release metadata. Release Please creates an immutable `vMAJOR.MINOR.PATCH` tag and a **draft** GitHub release. The remaining jobs run directly in the same Release workflow: they do not rely on the tag/release events suppressed by `GITHUB_TOKEN`. The workflow validates the tag and ancestry, reruns every CI gate at that exact commit, downloads its tested executables with digest validation, and runs `.goreleaser.yaml` to package them. Verification checks checksums, archive contents, executable permissions, ELF architecture, clean source revision and extension permissions before retaining the publication bundle.

Only then does the write-enabled job recheck that bundle and require a missing release or an empty stable draft targeting the verified commit. It runs `.goreleaser-publish.yaml` to upload those same files and publish the release, retaining Release Please's notes. This separate configuration disables builds and checksums; `--skip=archive` also prevents repackaging. GitHub assets are not rebuilt during publication, tags are not moved and published releases are not overwritten. After GitHub publication succeeds, the workflow calls the container workflow below. An explicitly requested manual tag push still follows the same validation/publication path.

Enable **Settings → Actions → General → Workflow permissions → Allow GitHub Actions to create and approve pull requests** for Release Please to open its version PRs. The workflow never approves or merges PRs. The Release Please job explicitly dispatches read-only CI on the PR branch after creating/updating it. This avoids depending on automatic PR-event execution or an approval-required bot run; `workflow_dispatch` is an explicit exception to the usual `GITHUB_TOKEN` event restrictions ([GitHub documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)). These checks run at the PR head revision and satisfy the normal CI requirement without a PAT.

If verification fails, the release stays a draft and the container is not published. Rerun the failed jobs after resolving the failure. If the workflow itself needed a fix, use the corrected workflow to resume the existing immutable tag:

```sh
gh workflow run release.yml --repo theopoc/pocketmark --ref main -f tag=v0.1.0 -F publish=true
```

This reruns the complete CI and packaging at the tag's exact revision before publishing. It does not move the tag or package the corrected workflow's current source. To rehearse that recovery without publication, omit `publish=true`. If publication partially uploaded files, inspect and remove those draft assets before retrying; the guard deliberately rejects non-empty drafts. For a failure after GitHub publication, rerun the container jobs or use the backfill dispatch below.

Expected assets are Linux AMD64/ARM64 `.tar.gz` files, their `.buildinfo.txt` files, the Chrome extension ZIP, and `SHA256SUMS`. Binary archives are static; extensions are unpacked/loaded manually. [Binary installation instructions](RELEASE_INSTALL.md).

Manually dispatching **Release** defaults to complete verification and assembly as a **dry run**, on a commit belonging to `main`. Both GoReleaser configurations are exercised in snapshot mode, which disables publication. Its `verified-release` artifact contains the same asset set and checksums. GitHub and container publication stay skipped even when a manual run targets a tag, unless the explicit `publish` input is enabled with a stable tag. No product version is published merely by committing or pushing `main`.

## GHCR images

After each successful tagged GoReleaser release, `container-release.yml` publishes `ghcr.io/theopoc/pocketmark:vMAJOR.MINOR.PATCH` for **Linux AMD64 and ARM64**. Release calls this reusable workflow directly: a release created with `GITHUB_TOKEN` does not trigger another workflow's `release:published` event ([GitHub documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)).

The workflow requires a published stable release, its immutable tag on `main`, and a successful complete CI check at that revision, from either ordinary CI or the reusable release CI. Both run the same suite; accepting ordinary CI also permits recovery from a corrected workflow whose check runs belong to a newer workflow revision. It checks out that exact source revision separately from the pipeline helpers. Each platform builds natively with the release's existing Dockerfile; SQLite/CGO, the non-root runtime and RAM settings are preserved.

Images first reach GHCR by digest, without a product version tag. Native runners pull those exact registry digests and run the hardened Compose smoke test, also checking architecture and OCI source/version labels. Only after both platforms succeed does an index assign the version tag to those two tested digests. An existing tag is accepted only if it already contains the exact same digests; differing content is never replaced. No `latest` or moving minor-version alias is published.

Fresh runners then pull the published version tag, verify its index digest, and repeat the full smoke test natively on both architectures. An unauthenticated registry probe must then deny anonymous pull. Reports retain platform digests, source revision and sanitized test evidence for seven days. Untagged intermediate registry versions can remain after interrupted or failed builds. Build attestations are disabled so the version index contains exactly the two runnable platform manifests; this pipeline does not claim signed provenance or an SBOM.

GHCR authentication uses the repository's short-lived `GITHUB_TOKEN`; the source label links the package to this repository. The source repository is public; GHCR package visibility is a separate setting. New GHCR packages default to private. Package visibility is managed separately from repository visibility: do not change it to public. Consumers need authenticated read access to this private package.

To backfill an already published release without moving its Git tag or changing its six GitHub assets:

```sh
gh workflow run container-release.yml --repo theopoc/pocketmark --ref main -f tag=v0.1.0
```

Unlike the **Release** dry run, manually dispatching **Container release** publishes a real image. It uses the requested release tag's source, rather than the current `main` source. After publication, authenticated clients can use:

```sh
docker pull ghcr.io/theopoc/pocketmark:v0.1.0
python3 scripts/smoke_docker.py --image ghcr.io/theopoc/pocketmark:v0.1.0 \
  --platform linux/arm64 --revision 2681cc39243bd954c296698aff1fea8e9cdfa5bd --version v0.1.0
```

Choose `linux/amd64` on an AMD64 host. The smoke test uses disposable data and cleans only its own Compose project. Publication rebuilds the container from the release source, not from the downloadable binary archives; each resulting image is separately tested before tagging and after pulling the published tag.
