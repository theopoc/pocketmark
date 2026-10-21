# Validation record

19 October 2026; macOS ARM64 with Go 1.27.1 (project supports Go 1.26+).

## Real clients

The later [real-client validation record](REAL_CLIENTS.md) supersedes the browser-installation limits below. It records actual Chrome extension execution, protocol traces, observed bugs and retests. The extension regression suite now has 16 passing tests. Final Go race tests (`-p 1`, `CGO_CFLAGS='-O2 -g0'`), `go vet`, UI syntax checks, native release compilation, Docker runtime and expanded RAM benchmark all passed. Initial parallel race-build disk failures were resolved with sequential builds and smaller C object files.

On 20 October, the unmodified third-party Android 1.4.4 APK was also operated in a disposable ARM64 Android emulator. Login, dashboard, URL creation, editing/pinning/moving/tagging, collection descriptions, tag detail, search, PNG banner and Readable/PDF/HTML views passed after adapter fixes. Metadata and PDF/PNG hashes survived a server restart. Immediate offline reading passed, but later offline opening can stall after individual-link metadata eviction in the client. iOS and physical-device behavior remain unqualified. See the [mobile runtime evidence](REAL_CLIENTS.md#official-android-application--20-october-2026). The complete Go race/static suite and 16 extension tests passed again after these fixes.

## Expanded personal-feature implementation

The older validation below describes the initial minimal build. The expanded build adds the features and limits recorded in [FEATURES.md](FEATURES.md).

- Final Go suite passed with the race detector, including atomic bulk changes, hierarchy cycles, HTML import/export, timestamp preservation, repeat imports, fuzzy search, anchored/stale annotations, standalone files, chunked uploads, full ZIP restoration, password/session/key revocation, and WebDAV conflict/rollback tests.
- XBEL URL edits preserve bookmark IDs, personal metadata, annotations and uploaded files; stale captured content is cleared. Standalone file records survive synchronization and are excluded from browser bookmark exports.
- `make check` passed (`go vet` and JavaScript syntax). Extension tests: 10 passed, covering ordinary saves, server-scoped permissions, tab identity, advanced PDF streaming, full-page raster limits and cleanup on failures. These use Chrome API doubles.
- In-app **@Browser**, local synthetic library on port 18091: collection creation/rename, bookmark capture, bulk move, sorting/fuzzy controls, rich-reader iframe, resource-embedded archive, account/settings display, and persisted highlight + annotation after closing/reopening the reader.
- **@Browser standalone upload passed**: a synthetic HTML file was uploaded without a URL, its reader displayed indexed content and a downloadable attachment, and inappropriate original-site/recapture controls were absent.
- Browser evidence: [reader/highlights](pocketmark-reader-preview.jpg), [file reader](pocketmark-file-preview.jpg), [library controls](pocketmark-features-preview.jpg).
- Default and advanced extension packages were built locally; neither was installed into a user's browser. Actual Chrome debugger rendering, third-party applications, Floccus and physical mobile PWA installation remain unqualified. Compatibility tests reproduce inspected client protocol shapes rather than claiming physical-client certification.

Docker extended workload results are recorded separately in [benchmark-features.json](benchmark-features.json) and [BENCHMARK.md](BENCHMARK.md), including the exact tested image and memory metrics.

## Initial minimal build: passed

- Native release build: `make build`.
- All Go tests with race detector: `make test`.
- Static checks: `make check` (`go vet` and Node JavaScript syntax check).
- Compose schema/configuration: `docker compose config --quiet`.
- Final Docker image build and Linux ARM64 runtime validation under the actual Compose 128 MiB / one-CPU limits. Image: `sha256:db8a17b60e21872475cb0e846c552039cf6f460a6596e97a790d891667b69309`.
- Container startup health, UID/GID 10001, read-only root filesystem, dropped capabilities, no-new-privileges, token mode/owner, API authentication and embedded UI.
- Six real HTTPS captures plus 200 concurrent API requests: all captures produced HTML and reader text, archive sandbox/download headers and metadata export passed, and the same token/library/archive hashes survived restart. Zero OOM or memory-limit events. [Raw results](benchmark-capture.json).
- Streaming-reader recovery for unclosed layout/navigation tags, with regression coverage preserving script/template/embedded-content exclusions. Native build, race tests and `go vet` passed after the fix.
- Reproducible 10,000-link import/search/export workload: [benchmark results](BENCHMARK.md).
- In-app @Browser against a local synthetic test library: token login, collection creation, tagged bookmark creation, live HTTPS capture of example.com, reader text, notes persistence, favorite toggle, title edit, read flag, full-text search matching captured text, JSON export download and retained data/session after restarting the final binary.
- Narrow browser panel visually inspected; screenshot: [Pocketmark preview](pocketmark-preview.png).

The automated suite covers public/private destination filtering, pinned DNS dialing, redirects, decompression/response limits, HTML extraction bounds, authentication/session expiry, login throttling, origin checks, request size limits, archive attachment headers, persistent storage, FTS updates/deletes, pagination, queue recovery and stale capture results, collection deletion, legacy JSON import, transaction rollback, metadata export/import and long-URL round trips.

## Initial minimal build: historical limits

- Browser tests exercised a small synthetic library. Browser file-upload import, destructive actions, and large-library UI behavior were not separately exercised; import/delete behavior is covered through HTTP/store tests.
- Docker's earlier OrbStack disconnection is resolved. The final image and isolated Compose deployment passed; AMD64 and other hosts were not tested. Benchmark containers, network and synthetic volume were removed afterward.
- Disk pressure interrupted the first race-test build. Task-created temporary caches were cleaned, and the complete final native build/race/static checks subsequently passed.
- No upstream service, full feature parity, percentage RAM reduction or production deployment is claimed. Linux runtime RSS and cgroup memory are measured for the documented six-page workload, not a worst-case stress test.
