# Memory measurements

## Final mobile compatibility build

Measured 20 October 2026 at 08:19 UTC, Linux ARM64/OrbStack. Image `pocketmark:mobile`, SHA-256 `ad750f95840315d7ed7bbe059abb90f8b4d4d8ea7a1f93e134bdc6ae3600af76`, 17.59 MiB storage. [Raw measurements](benchmark-mobile.json).

The complete extended workload passed with the mobile adapter fixes: six public-page captures, 200 search/list requests, a resource-embedded snapshot, 19 MiB upload/download, collection/bulk/annotation operations, HTML/XBEL round-trips, staged Floccus WebDAV, a 24.43 MiB full backup and restart persistence. The container retained its 128 MiB hard limit, one CPU and 32 MiB Go soft budget. There were zero memory-limit or OOM events.

| Measurement | Result |
| --- | ---: |
| Empty idle process RSS, sampled maximum | **10.52 MiB** |
| Process RSS, kernel lifetime peak | **23.59 MiB** |
| Whole-container memory, kernel lifetime peak | **95.37 MiB** |
| Process RSS after workload, sampled maximum | 17.17 MiB |
| Whole-container memory after workload, sampled maximum | 69.20 MiB |

Whole-container accounting includes filesystem cache, health checks and the small sampler; it is not Go heap size. This run's container peak is higher than the earlier client build, while the process peak is similar; these separate bounded runs do not establish a causal regression or a worst-case bound. Client rendering, the Android emulator, host and Docker VM RAM are excluded. The actual Android UI tests were separate from this server benchmark. No matching upstream legacy client RAM baseline was measured.

```sh
docker build -t pocketmark:mobile .
python3 scripts/benchmark_capture.py --features --image pocketmark:mobile --output docs/benchmark-mobile.json
```

## Final client compatibility build

Measured 19 October 2026 at 22:05 UTC (20 October in Europe/Paris), Linux ARM64/OrbStack, image `sha256:4f2ceb38f842edd6ed5e1e3c6b159601bb6e07bb0ed7cf51c34b5be2cfc93b60`, 17.59 MiB storage. [Raw results](benchmark-clients.json).

The extended workload below was repeated with the corrected client adapter and an additional Floccus Basic-authenticated lock → GET → temporary PUT → PROPFIND → MOVE → unlock sequence. Exact XML bytes survived restart, along with the library and captured pages. All six live captures, 200 search/list requests, the 19 MiB upload/download and 24.43 MiB full backup succeeded under the normal 128 MiB limit. No memory-limit or OOM events occurred.

| Measurement | Result |
| --- | ---: |
| Empty idle process RSS, sampled maximum | **10.47 MiB** |
| Process RSS, kernel lifetime peak | **22.93 MiB** |
| Whole container, kernel lifetime peak | **84.04 MiB** |
| Process RSS after workload, sampled maximum | 18.10 MiB |
| Whole container after workload, sampled maximum | 57.73 MiB |

The container figure includes filesystem cache, health checks and the sampler. Its accounting differs from process RSS; do not subtract the two or treat the container figure as Go heap size. Browser rendering and the Docker VM remain excluded. Actual browser client workflows were also tested separately, as recorded in [REAL_CLIENTS.md](REAL_CLIENTS.md). Their RAM was not measured. These are bounded sample workloads, without an upstream legacy client baseline.

```sh
docker build -t pocketmark:clients .
python3 scripts/benchmark_capture.py --features --image pocketmark:clients --output docs/benchmark-clients.json
```

## Expanded features: final Docker validation

Measured 19 October 2026 at 21:35 UTC, Linux ARM64/OrbStack, image `sha256:e97b7b805119ca62961b1885addbbfd62c078ebb2c97b4783547480e090c9b8f` (17.53 MiB storage). [Raw results](benchmark-features.json) retain the binary SHA, captures, phases, checks and memory events.

This run kept the normal **128 MiB container limit**, one CPU and `GOMEMLIMIT=32MiB`. It exercised all six live page captures with 200 concurrent search/list requests, then a resource-embedded snapshot, a **19 MiB upload and byte-for-byte download**, a standalone HTML file, collection rename/bulk moves, annotation persistence, HTML import/export, conditional WebDAV synchronization and a **24.28 MiB complete backup ZIP**. The backup archive integrity and post-restart library/original-capture hashes passed. Full backup restoration and uploaded-byte integrity are also covered by the Go integration tests.

| Measurement | Result |
| --- | ---: |
| Empty idle application RSS, sampled maximum | **10.38 MiB** |
| Overall application RSS, kernel high-water mark | **23.21 MiB** |
| Overall container memory, kernel high-water mark | **80.87 MiB** |
| Application RSS after workload, sampled maximum | 17.03 MiB |
| Container memory after workload, sampled maximum | 54.72 MiB |
| OOM / memory limit events | **0 / 0** |

The larger container peak occurred during backup after the large file upload; it includes reclaimable filesystem cache, temporary disk-file cache, health checks and the sampler. It is not an 80 MiB Go heap. Process RSS and cgroup charging use different accounting, particularly for shared file-backed pages, so they must not be subtracted or treated as interchangeable. The kernel high-water marks capture short spikes missed by the 151 samples at approximately 100 ms intervals.

All six network captures succeeded; the offline Go documentation snapshot was 637,820 bytes with four embedded resources and 33 omitted resource references. The resource snapshot is bounded and intentionally not a claim of perfect site reproduction. Seven records remained (six URLs and one standalone file), none pending or failed. Resource limits, authentication, non-root execution, read-only root, capability dropping and restart persistence passed. Temporary benchmark containers/network/volume were removed.

```sh
docker build -t pocketmark:features .
python3 scripts/benchmark_capture.py --features --image pocketmark:features --output docs/benchmark-features.json
```

Client browser RAM, PDF/PNG browser rendering and the Docker VM are **excluded**. PDF/full-page screenshot extension tests use Chrome API doubles; their real browser memory has not been measured. This is a small real-page workload plus a large synthetic upload, not a 10,000-captured-page or worst-case guarantee. No upstream legacy client runtime comparison was performed.

## Earlier minimal build: Docker with page capture enabled

Validated on 19 October 2026, Linux ARM64 under OrbStack on this Mac. The normal Compose configuration was used with a fresh isolated data volume and randomly assigned loopback port: **128 MiB hard container limit**, one CPU, 32 MiB soft Go budget, and one capture worker. [Raw capture results](benchmark-capture.json) record the exact image/binary identities, URLs, archive hashes, memory events and validation checks.

Six live HTTPS documentation pages were captured while 200 search/list/stats requests ran at concurrency four. All six succeeded with nonempty reader text and **zero failed/pending captures**. Their HTML archives totaled **3.51 MiB**; the largest page was **1.94 MiB**, close to the 2 MiB response limit. RFC 9110's reader text reached the configured 256 KiB truncation limit. Capture and concurrent requests completed in 3.081 seconds in this run; external content and timings can change.

| Measurement | Application process | Whole container |
| --- | ---: | ---: |
| Empty idle, sampled maximum | 9.43 MiB RSS | 13.38 MiB cgroup memory |
| Capture + concurrent requests, sampled maximum | 20.54 MiB RSS | 31.40 MiB cgroup memory |
| Kernel lifetime peak recorded through capture/search | 22.23 MiB RSS | 32.80 MiB cgroup memory |
| Kernel lifetime peak including archive verification/export | **22.34 MiB RSS** | **36.05 MiB cgroup memory** |
| Five seconds idle after capture/verification, sampled maximum | 17.77 MiB RSS | 32.23 MiB cgroup memory |

`VmRSS`/`VmHWM` measure application PID 1. `memory.current`/`memory.peak` measure the container cgroup and include SQLite/file cache, health checks and the small shell/sleep sampling process. Current values are sampled about every 100 ms; kernel-maintained lifetime peaks catch spikes between samples and are cumulative, not isolated per-phase peaks. Archive verification finished between samples, but its memory use is covered by the kernel peaks subsequently read. Docker VM, host and browser memory are excluded. No cgroup limit hits or OOM events occurred.

The runtime image is 16.78 MiB (storage size, not RAM). Startup health, non-root user, read-only root filesystem, dropped capabilities, token file permissions, authentication, archive download headers, export, and data/token/archive persistence after restart all passed. The benchmark's temporary containers, network and volume were removed.

```sh
docker build -t pocketmark:validation .
python3 scripts/benchmark_capture.py --image pocketmark:validation --output docs/benchmark-capture.json
```

This is a six-page live capture workload, **not a 10,000-page capture benchmark or a worst-case memory guarantee**. The addresses are listed in the script and raw results; public-network checks remain enabled. A regression found during validation was fixed: malformed, unclosed navigation in Go documentation no longer hides its main article from the streaming reader. Tests ensure this recovery does not expose template/script/embedded-asset text.

## Native metadata-only baseline

Measured on 19 October 2026, macOS 26.6.2, Apple ARM64. The native release executable is 8.57 MiB. [Raw results](benchmark-native.json) include its SHA-256 and the platform identity.

This earlier baseline predates the reader recovery fix and uses a different OS/workload from the Docker capture run. It is retained as a separate measurement, not a like-for-like comparison.

| Workload phase | Sampled peak process RSS |
| --- | ---: |
| Empty library, idle | 14.19 MiB |
| Import 10,000 bookmarks | 29.94 MiB |
| 200 search/list requests, concurrency 4 | 30.58 MiB |
| Export 10,000 bookmarks | Completed between RSS samples |
| Loaded library, idle immediately afterward | 30.64 MiB |

Import took 0.311 seconds; the 200 requests took 0.230 seconds. Overall sampled peak was 30.64 MiB. These are local synthetic-workload measurements, not service latency guarantees. The Go runtime retains some committed memory after load, so loaded idle RSS differs from a fresh process. The final build pins go-sqlite3 v1.14.52 and golang.org/x/net v0.61.0.

## Reproduce

```sh
make build
python3 scripts/benchmark.py --links 10000 --output docs/benchmark-native.json
```

The script starts a temporary, isolated server on a free loopback port, generates 10,000 bookmarks containing titles, descriptions, notes and tags, imports them, performs four concurrent search/filter/list streams, and exports the library. It samples the child process RSS using `ps` about every 50 ms, including startup. It stops the server and removes its temporary data afterward. It never touches an existing library. Python 3 and permission to bind localhost/read process RSS are needed.

Capture is **disabled** in this benchmark. It does not fetch example URLs, render pages, or include a browser UI. No screenshots, PDFs, captured HTML or extracted article bodies are present in this fixture. Sampling can miss short spikes. Process RSS excludes Docker/VM overhead, the browser and filesystem cache accounted outside the process. A larger collection of captured articles and real long-running use need separate measurement.

## Memory controls

- One application process and SQLite, no PostgreSQL, Meilisearch, Node server or Chromium.
- One SQLite connection, a 2 MiB page-cache target, disabled mmap, disk-backed temporary tables.
- Go runtime soft memory budget of 32 MiB by default, GC target 50%. Native SQLite allocations are outside that Go budget.
- One persistent capture worker, 20-second fetch timeout and 2 MiB wire/decompressed input limits; one import at a time and eight active HTTP handlers maximum.
- Lists contain at most 40 records; export streams records. Import is bounded at 8 MiB / 10,000 links but parses the selected file in memory.
- Compose provides a 128 MiB cgroup limit. The capture workload above passed within it; it is not a measured worst-case requirement or a promise against OOM under every input.

## Comparison boundary


Capture architecture differs: bounded passive server snapshots embed resources, while rendered HTML/PDF/screenshots use the user's browser through the extension. These capabilities and their limits are documented in [FEATURES.md](FEATURES.md). Low server RAM is partly achieved by placing browser rendering on the client; it does not eliminate that browser's memory cost.
