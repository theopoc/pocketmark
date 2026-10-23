# CI and release

GitHub Actions runs on pushes to `main`, pull requests targeting `main`, and manual dispatch. Release Please also runs on pushes to `main`, preparing a version PR or handing a merged version PR to the release pipeline. A release calls the same CI at the tagged commit. Every gate must pass; failed, skipped or cancelled prerequisite jobs fail the final `CI passed` check.

| Gate | Checks and outputs |
| --- | --- |
| Quality | Go formatting/vet, module checksums and tidy drift, JavaScript/Python syntax, extension regression tests, workflow/shell validation with actionlint, release-verification tests and both GoReleaser configurations. |
| Security | Gitleaks scans the complete checked-out Git history with redacted output. Govulncheck checks reachable Go dependency/standard-library vulnerabilities using the application's SQLite tags. |
| Test/build, AMD64 and ARM64 | Native Linux runners execute all Go race tests with coverage; musl builds static executables; the exact executables and build metadata become packaging inputs. |
| Docker, both architectures | Builds the normal Dockerfile natively and tests the actual hardened Compose configuration: health, authentication, FTS5, enabled capture rejecting a loopback destination, backup integrity, restart persistence and zero OOM/limit events. Each run owns and cleans its synthetic volume/network/container. |
| Artifacts | Native executables, coverage and sanitized Docker evidence are retained for seven days. Release runs additionally retain the six verified publication assets. |

Actions use full commit SHAs; tool modules, pre-commit hooks and the Gitleaks engine are version-pinned. Gitleaks uses the official action rather than a custom installer. Review and update these pins deliberately. CI has read-only repository permissions, timeouts and cancellation of superseded branch runs. It executes pull-request code without publication credentials and uses no `pull_request_target`. Release Please receives `contents:write` and `pull-requests:write` to maintain version PRs and draft releases, plus `actions:write` to dispatch CI on the bot PR's branch. GitHub release publication separately receives `contents:write`; GHCR build/index jobs receive `packages:write`. No personal access token, external registry secret or paid security service is required for publication.

The compiler baseline is Go 1.26.10, matching the Docker builder. An initial local security scan on Go 1.27.1 found standard-library advisories; builds must use a patched toolchain. A numerically newer Go minor version does not imply its patch level contains every fix. Govulncheck remains blocking rather than suppressing standard-library reports.

The deterministic container smoke test does not depend on public websites. The separate live-page workload in [BENCHMARK.md](BENCHMARK.md) measures RAM and external capture behavior; CI smoke checks are not performance measurements or native mobile UI tests. Repository runtime data, tool sessions, downloaded clients, build output and raw HTTP traces are ignored. Maintained synthetic screenshots and summarized benchmark evidence remain in `docs/`.

## Local pre-commit hooks

Install [pre-commit](https://pre-commit.com/#install), then enable the checked-in configuration:

```sh
pre-commit install
pre-commit run --all-files
```

Hooks run on staged files before each commit. The first run creates isolated hook environments; the Gitleaks hook builds its pinned engine using Go, without a separate global Gitleaks installation. Go and Node.js must be on PATH. Formatting hooks update files; review and stage their changes before retrying the commit.

| Hook | Reason |
| --- | --- |
| Large files (1 MiB for newly added files) | Catch accidental binaries and data exports; existing curated screenshots remain valid. |
| Merge and case conflicts | Reject unresolved merges and paths that collide on macOS/Linux. |
| JSON, YAML and TOML syntax | Validate manifests, workflows and tooling configuration without reformatting them. |
| Final newline and trailing whitespace | Keep diffs readable; preserve Markdown hard line breaks. |
| Gofmt and JavaScript syntax | Fast checks for the Go server, embedded UI and extension, without new frontend dependencies. |
| Gitleaks | Scan the staged diff for secrets with redacted output before they enter history. |

Full Go vet/race tests, extension tests, builds, actionlint and container tests stay in CI to keep commits fast and avoid requiring Docker or release tools for every edit. Hooks complement those gates and do not replace them. Run `pre-commit autoupdate` deliberately and review version changes.

CI uses the [official Gitleaks action](https://github.com/gitleaks/gitleaks-action), pinned to a full commit SHA, with engine version 8.30.1. It selects the action's `workflow_dispatch` scan mode explicitly for every caller, scanning the complete checked-out history at the selected ref rather than the event's PR/push range. This also supports release callers whose original event is unsupported by the action. Comments, SARIF uploads and summaries are disabled; output remains redacted and repository permissions remain read-only. Personal-account repositories do not require a Gitleaks action license; organization-owned repositories require `GITLEAKS_LICENSE`.

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

Enable **Settings → Actions → General → Workflow permissions → Allow GitHub Actions to create and approve pull requests** for Release Please to open its version PRs. The workflow never approves or merges PRs. The built-in `GITHUB_TOKEN` does not trigger `pull_request` workflows for bot changes, so the Release Please job explicitly dispatches the read-only CI workflow on the PR branch after creating/updating it. These checks run at the PR head revision and satisfy the normal CI requirement without a PAT.

If verification fails, the release stays a draft and the container is not published. Rerun the failed jobs after resolving the failure. If publication partially uploaded files, inspect and remove those draft assets before retrying; the guard deliberately rejects non-empty drafts. For a failure after GitHub publication, rerun the container jobs or use the backfill dispatch below.

Expected assets are Linux AMD64/ARM64 `.tar.gz` files, their `.buildinfo.txt` files, the Chrome extension ZIP, and `SHA256SUMS`. Binary archives are static; extensions are unpacked/loaded manually. [Binary installation instructions](RELEASE_INSTALL.md).

Manually dispatching **Release** performs the complete verification and assembly as a **dry run**, on a commit belonging to `main`. Both GoReleaser configurations are exercised in snapshot mode, which disables publication. Its `verified-release` artifact contains the same asset set and checksums. GitHub and container publication stay skipped even when a manual run targets a tag. No product version is published merely by committing or pushing `main`.

## GHCR images

After each successful tagged GoReleaser release, `container-release.yml` publishes `ghcr.io/theopoc/pocketmark:vMAJOR.MINOR.PATCH` for **Linux AMD64 and ARM64**. Release calls this reusable workflow directly: a release created with `GITHUB_TOKEN` does not trigger another workflow's `release:published` event ([GitHub documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)).

The workflow requires a published stable release, its immutable tag on `main`, and a successful complete release CI check at that revision. It checks out that exact source revision separately from the pipeline helpers. Each platform builds natively with the release's existing Dockerfile; SQLite/CGO, the non-root runtime and RAM settings are preserved.

Images first reach GHCR by digest, without a product version tag. Native runners pull those exact registry digests and run the hardened Compose smoke test, also checking architecture and OCI source/version labels. Only after both platforms succeed does an index assign the version tag to those two tested digests. An existing tag is accepted only if it already contains the exact same digests; differing content is never replaced. No `latest` or moving minor-version alias is published.

Fresh runners then pull the published version tag, verify its index digest, and repeat the full smoke test natively on both architectures. An unauthenticated registry probe must then deny anonymous pull. Reports retain platform digests, source revision and sanitized test evidence for seven days. Untagged intermediate registry versions can remain after interrupted or failed builds. Build attestations are disabled so the version index contains exactly the two runnable platform manifests; this pipeline does not claim signed provenance or an SBOM.

GHCR authentication uses the repository's short-lived `GITHUB_TOKEN`; the source label links the package to this private repository. New GHCR packages default to private. Package visibility is managed separately from repository visibility: do not change it to public. Consumers need authenticated read access to this private package.

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
