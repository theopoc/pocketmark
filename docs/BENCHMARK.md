# Memory measurement methodology

Pocketmark uses one Go process and SQLite. Compose sets a 128 MiB container
limit and the Go runtime defaults to a 32 MiB soft memory budget. These are
configuration limits, not a measured worst-case requirement or a guarantee
against OOM for every input. Native SQLite allocations and filesystem cache
are outside the Go heap budget.

## Metadata-only workload

```sh
make build
mkdir -p reports
python3 scripts/benchmark.py --links 10000 --output reports/benchmark-native.json
```

The script starts a temporary server on a free loopback port with capture
disabled. It imports 10,000 synthetic bookmarks, performs 200 search/list
requests at concurrency four, and exports the library. It samples child-process
RSS using `ps` about every 50 ms, then stops the server and removes its temporary
data. It never touches an existing library or fetches the bookmark URLs.

Python 3, localhost binding and permission to read process RSS are required.
Sampling can miss short spikes. This fixture contains no captured articles,
screenshots or PDFs and does not measure browser, Docker or VM memory.

## Live capture and extended features

```sh
docker build -t pocketmark:validation .
python3 scripts/benchmark_capture.py --image pocketmark:validation
# Optional extended workload:
python3 scripts/benchmark_capture.py --features --image pocketmark:validation \
  --output reports/benchmark-features.json
```

The capture script requires Docker Compose and public-network access. It creates
a randomly named project with a disposable volume and loopback port, preserving
Compose's resource and security settings. It captures six public documentation
pages while making 200 requests at concurrency four, verifies archives and
restart persistence, and removes its test deployment. Remote content and timings
can change; live-network runs are optional and separate from deterministic CI.

`--features` also exercises a resource-embedded snapshot, a 19 MiB upload/download,
collections, bulk edits, annotations, HTML/XBEL round-trips, staged WebDAV and a
full backup. See [archive boundaries](ARCHIVES.md) for resource and deadline limits.

The default output is ignored `reports/benchmark-capture.json`. Keep all results,
reports, screenshots and profiles outside version control, including summaries.
Record the workload, source revision, platform, toolchain, image/binary identity,
results and limitations in the PR, as required by [AGENTS.md](../AGENTS.md).

## Interpret measurements

- `VmRSS` and `VmHWM` describe application PID 1. `memory.current` and
  `memory.peak` describe the whole container, including filesystem cache,
  health checks and the sampler. They are different accounting systems; do
  not subtract them or treat container memory as Go heap size.
- Current-memory samples are taken about every 100 ms. Kernel high-water marks
  capture spikes between samples but are lifetime values, not per-phase peaks.
- Browser rendering, host and Docker VM memory are excluded. The Chrome
  extension renders HTML, PDF and screenshots in the user's browser; low server
  RAM does not eliminate that client memory cost.
- A small live-page or metadata-only workload does not establish large captured
  library behavior, long-running stability or a worst-case bound. Compare fresh
  processes with the same workload, platform, toolchain and limits before drawing
  conclusions about a regression or another bookmark manager.
