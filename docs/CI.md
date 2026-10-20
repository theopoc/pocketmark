# CI and release

GitHub Actions runs on pushes to `main`, pull requests targeting `main`, and manual dispatch. A tag release calls the same CI at the tagged commit. Every gate must pass; failed, skipped or cancelled prerequisite jobs fail the final `CI passed` check.

| Gate | Checks and outputs |
| --- | --- |
| Quality | Go formatting/vet, module checksums and tidy drift, JavaScript/Python syntax, 16 extension tests, workflow/shell validation with actionlint, release-packaging tests. |
| Security | Gitleaks scans the complete checked-out Git history with redacted output. Govulncheck checks reachable Go dependency/standard-library vulnerabilities using the application's SQLite tags. |
| Test/build, AMD64 and ARM64 | Native Linux runners execute all Go race tests with coverage; musl builds static executables; allowlisted archives retain executable permissions and build metadata. |
| Docker, both architectures | Builds the normal Dockerfile natively and tests the actual hardened Compose configuration: health, authentication, FTS5, enabled capture rejecting a loopback destination, backup integrity, restart persistence and zero OOM/limit events. Each run owns and cleans its synthetic volume/network/container. |
| Artifacts | Architecture packages, default/advanced extension ZIPs, coverage and sanitized Docker evidence are retained for seven days. |

Actions use full commit SHAs; tool modules and the downloaded Gitleaks archive are version-pinned, with SHA-256 verification for the archive. Review and update these pins deliberately. CI has read-only repository permissions, timeouts and cancellation of superseded branch runs. It executes pull-request code without publication credentials and uses no `pull_request_target`. Only the final tagged publication job receives `contents:write`; no personal access token, external registry secret or paid security service is required.

The compiler baseline is Go 1.26.10, matching the Docker builder. An initial local security scan on Go 1.27.1 found standard-library advisories; builds must use a patched toolchain. A numerically newer Go minor version does not imply its patch level contains every fix. Govulncheck remains blocking rather than suppressing standard-library reports.

The deterministic container smoke test does not depend on public websites. The separate live-page workload in [BENCHMARK.md](BENCHMARK.md) measures RAM and external capture behavior; CI smoke checks are not performance measurements or native mobile UI tests. Repository runtime data, tool sessions, downloaded clients, build output and raw HTTP traces are ignored. Maintained synthetic screenshots and summarized benchmark evidence remain in `docs/`.

## Reproduce locally

Requirements: Go as declared by `go.mod`, a C compiler, Node.js 24, Python 3, `make`, and Docker Compose for the container test.

```sh
make check
make test
make test-extension
python3 -m unittest discover -s scripts -p 'test_*.py' -v
make build
make package-extensions
docker build -t pocketmark:ci .
python3 scripts/smoke_docker.py --image pocketmark:ci
```

Linux binary packages require `musl-gcc` and matching native architecture. The packager checks the ELF architecture and includes only the executable and installation instructions. Extension ZIPs contain only five explicitly named production files; the advanced package alone declares `debugger` access. Tests and local data are never globbed into release archives.

## Publish a version

After an explicit release request, create a new immutable `vMAJOR.MINOR.PATCH` tag on a commit already in `main` and push that tag. The Release workflow validates the tag and ancestry, reruns every CI gate at that commit, downloads its tested artifacts with digest validation, checks the exact asset set and writes `SHA256SUMS`. Only then does it create the private repository's GitHub release with those files. It does not rebuild packages during publication, move tags, overwrite an existing release or publish a container registry package.

Expected assets are Linux AMD64/ARM64 `.tar.gz` files, their `.buildinfo.txt` files, default and advanced extension ZIPs, and `SHA256SUMS`. Binary archives are static; extensions are unpacked/loaded manually. [Binary installation instructions](RELEASE_INSTALL.md).

Manually dispatching **Release** performs the complete verification and assembly as a **dry run**, on a commit belonging to `main`. Its `verified-release` artifact contains the same asset set and checksums. The publication job stays skipped even when a manual run targets a tag. No product version is published merely by committing or pushing `main`.
