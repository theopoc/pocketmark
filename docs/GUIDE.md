# Pocketmark guide

A personal bookmark manager built for low RAM usage: one Go executable, SQLite and a small embedded web interface. Save links, organize collections and tags, search captured text, and import an existing bookmark library.

Pocketmark uses one process for storage and capture. Public HTML capture runs on the server; JavaScript-rendered capture and screenshots run in your existing browser through the included extension. The personal Chrome extension uses the native API; Floccus synchronizes through WebDAV.

## Start locally

Requirements: Go as declared in `go.mod` (1.26.10 or a newer patched toolchain), a C compiler and `make`. SQLite is compiled through CGO; `make build` enables FTS5. No Node.js runtime or external database is required.

```sh
make build
./bin/pocketmark
```

Open [http://127.0.0.1:8090](http://127.0.0.1:8090) and create your personal account. On later visits, sign in with your username and password. Once signed in, open **Settings → API keys** to create or revoke a key for each extension or client.

Existing installations keep their credentials and keys. If no password was configured before upgrading, follow [account recovery](API.md#existing-installations-and-account-recovery); public account creation cannot claim an existing library.

The default data directory is `./data`, containing `pocketmark.db` and the private `access-token` file (mode `0600`). This file remains an administrative API recovery credential and session-signing secret; it is not a browser login method. Stop with Ctrl+C. To run without fetching bookmarked pages:

```sh
./bin/pocketmark -no-capture
```

## Docker Compose

```sh
docker compose up --build -d
```

Open the same local URL. Compose stores data in a named volume and publishes port 8090 on host loopback only. The image runs as UID/GID `10001:10001`; a custom bind-mounted data directory must be writable by that user.

Tagged releases also publish a private multiarchitecture image at `ghcr.io/theopoc/pocketmark:vMAJOR.MINOR.PATCH` for Linux AMD64/ARM64. After authenticating Docker with read access to the package, use that image in place of `build: .` in your Compose configuration. Keep the same volume, port binding and resource/security settings. See [GHCR publication and verification](CI.md#ghcr-images).

The supplied Compose configuration sets a **128 MiB container memory limit** and one CPU. This is a deployment limit, not a guarantee that every workload completes within it. See [benchmark methodology and results](BENCHMARK.md) for measured behavior.

## What is included

- Bookmarks with descriptions, personal notes, favorite/read flags and tags.
- Nested collections, an inbox, filtering and 40-item paginated lists.
- SQLite FTS5 search across title, URL, description, notes, tags and captured text. Search terms are combined with AND and match token prefixes; matching ignores case and common diacritics.
- A persistent, sequential capture queue; failed captures can be retried. Interrupted jobs resume after restart.
- Plain-text reading and downloadable original HTML for public HTML pages.
- Legacy JSON import, Pocketmark JSON export/import and an authenticated [HTTP API](API.md).
- Rename/move collections, atomic bulk actions, sorting and optional typo-tolerant metadata search.
- Anchored highlights and annotations, with stale highlights identified after a page changes; a separate structural reader preserves headings, lists, code and tables.
- Browser bookmarks HTML import/export and WebDAV/XBEL synchronization for Floccus.
- PDF, image and SingleFile/HTML files (standalone or attached) streamed in 64 KiB SQLite chunks; manual offline snapshots with embedded resources.
- Personal username/password login, named revocable API keys and an owner-only full ZIP backup while the app runs.
- Installable mobile web interface, share target, and a small [browser extension](../extension/README.md). The Linkwarden compatibility API and third-party extension/mobile integration have been removed.

Default capture fetches one HTML response, with a 20-second timeout, at most five redirects, a 2 MiB response/decompressed-body limit and up to 256 KiB of extracted text. Choose **Save with resources** for bounded resource embedding, or use the extension for an already-rendered page and a visible-tab PNG screenshot. The same Chrome extension generates PDF and full-page screenshots on demand, using an explicit debugger permission; [installation and limits](../extension/README.md). Other browsers can use **Print / PDF**, then upload the file. No Chromium instance runs on the server. Private, loopback and reserved network destinations can be bookmarked, but server capture refuses them. See [archive limits](ARCHIVES.md).

Collaboration/public sharing, SSO/OIDC, RSS, AI automation, scheduled recapture and automatic backups are intentionally excluded. Screenshots and PDF rendering consume memory in the user's browser; their memory is not included in server measurements. Historical Chrome and third-party client observations are preserved in the [real-client validation record](REAL_CLIENTS.md). The supported integration paths are the Pocketmark Chrome extension and Floccus WebDAV; older Linkwarden client observations do not qualify the new extension.

The unmodified third-party Android app (1.4.4) was also tested in an ARM64 emulator: sign-in, bookmarks, collections/descriptions, tags, search, banners and archive views work for the exercised flows. Prolonged offline opening has an identified client-cache limitation; iOS and physical phones remain untested. See [mobile results and corrections](REAL_CLIENTS.md#official-android-application--20-october-2026).

## Configuration

| Setting | Default | Purpose |
| --- | --- | --- |
| `POCKETMARK_DATA` / `-data` | `./data` | Database and generated token directory. |
| `POCKETMARK_LISTEN` / `-listen` | `127.0.0.1:8090` | HTTP bind address; Docker uses `0.0.0.0:8090` internally. |
| `POCKETMARK_TOKEN` | Generated token file | Override the administrative API recovery/session-signing secret; at least 24 characters. |
| `POCKETMARK_ORIGIN` | Request origin | Public origin such as `https://bookmarks.example.com`, without a path. |
| `POCKETMARK_SECURE_COOKIE` | `false` | Set `true` for HTTPS session cookies; an HTTPS origin enables this automatically. |
| `POCKETMARK_CAPTURE` / `-no-capture` | Capture enabled | Set the environment variable to `false`, or pass the flag, to disable capture. |
| `GOMEMLIMIT` | `32MiB` | Soft Go runtime memory budget; native SQLite allocations and total RSS are outside this budget. |

Explicit flags override their environment defaults. For access through an HTTPS reverse proxy, configure `POCKETMARK_ORIGIN` to the exact public origin. Forward requests to the HTTP listener; browser mutation requests are checked against the configured origin. The app does not terminate TLS itself.

## Import a bookmark library

1. Export your existing library as a supported JSON file, such as `backup.json`.
2. In Pocketmark, choose **Import** and select that JSON file, or use the [import API](API.md#import-and-export).
3. Check the imported/skipped counts. Captures run afterward unless disabled.

The importer accepts the legacy JSON export object, including flat collections with `parentId`, tag objects and pinned links. It retains bookmark names, URLs, descriptions, collection hierarchy, tag names and pins. Pocketmark exports additionally retain personal notes and read flags. Valid source RFC3339 timestamps are preserved; absent timestamps use the import time. Browser HTML bookmark files can also be selected with **Import**.

Imports are limited to **8 MiB**, **10,000 links** and **2,000 collections** per file. Existing duplicate URLs and unsupported uploaded-file record types are skipped. Invalid URL records, broken collection references or cyclic hierarchies roll back the entire import. Existing collections with the same name and parent are reused on repeat imports. Transfer original uploaded files separately through the attachment upload.

JSON import/export does not include captured HTML, extracted text or other archived assets. Source accounts, permissions, RSS subscriptions, highlights and settings are not migrated. Pocketmark's export uses its own versioned JSON format.

## Back up everything

Choose **Settings → Full backup** to download a consistent ZIP while Pocketmark runs. It contains a SQLite snapshot including captures, uploaded files, highlights, account settings and hashed API keys. Keep your existing `access-token` file or `POCKETMARK_TOKEN` separately. The ZIP includes restore instructions; restore only while stopped into an empty data directory so stale WAL files cannot overwrite restored data. The operation uses temporary disk space approximately equal to the database size, not an in-memory copy.

Alternatively, stop Pocketmark before copying its data directory. Preserve the complete directory, including any SQLite WAL files and the access token; a live copy of only `pocketmark.db` can miss committed data.

For a local process, stop it with Ctrl+C, copy `./data` to your backup location, then restart. For the Compose deployment:

```sh
docker compose stop pocketmark
docker compose run --rm --no-deps --entrypoint tar pocketmark -C /data -cf - . > pocketmark-backup.tar
docker compose start pocketmark
```

To restore, stop the application, restore the complete backup into its data directory with the correct ownership, then restart. JSON export is useful for portable bookmark metadata; the database backup also preserves captures.

## Development and verification

```sh
make build
make test
make check
```

`make test` runs Go tests with the race detector. `make check` runs `go vet` and JavaScript syntax checking, which requires Node.js as a development tool. Build and runtime do not require Node.js. See `python3 scripts/benchmark.py --help` and the [benchmark report](BENCHMARK.md) for the reproducible memory workload.

GitHub Actions also checks formatting, dependency integrity, secrets, reachable vulnerabilities, extension tests and release packaging. Native Linux AMD64/ARM64 jobs run race tests, build static binaries and validate the hardened Docker/Compose runtime. GoReleaser OSS packages the tested binaries and extensions, generates SHA-256 checksums and publishes version tags; manual release runs exercise packaging and verification without publishing. See [CI and release](CI.md) and [contributor instructions](../AGENTS.md).

For capture-enabled Docker validation, run `docker build -t pocketmark:validation .`, then `python3 scripts/benchmark_capture.py`. It captures six public documentation pages, measures process/container memory, checks restart persistence, and removes its isolated test deployment.

For the extended feature workload, use `python3 scripts/benchmark_capture.py --features --image pocketmark:mobile --output docs/benchmark-mobile.json` after `docker build -t pocketmark:mobile .`. It also exercises a 19 MiB upload/download, offline resource capture, annotations, bulk editing, HTML/XBEL round-trips, the staged Floccus DAV protocol and a full backup. The final ARM64 run measured **10.52 MiB idle RSS**, **23.59 MiB peak application RSS** and **95.37 MiB peak whole-container memory**, including filesystem cache. No OOM or limit events occurred. Client rendering, the Android emulator and the Docker VM are excluded; see the [benchmark report](BENCHMARK.md) for workload boundaries.

| Path | Contents |
| --- | --- |
| `cmd/pocketmark/` | Configuration, lifecycle and capture worker. |
| `internal/capture/` | Bounded HTTP fetch, network checks and HTML text extraction. |
| `internal/server/` | Authentication and HTTP API. |
| `internal/store/` | SQLite persistence, schema upgrades, full-text search and bookmark import/export. |
| `internal/webui/` | Embedded interface assets. |

Within `internal/store/`, files are grouped by responsibility and import format; all remain in the same Go package.

| Files | Responsibility |
| --- | --- |
| [schema.go](../internal/store/schema.go), `schema*_test.go` | Atomic schema initialization and legacy-database upgrades, including restart regressions. |
| [import_json.go](../internal/store/import_json.go), `import_json_test.go` | JSON metadata import/export, hierarchy merging and rollback. |
| [import_html.go](../internal/store/import_html.go), `import_html_test.go` | Netscape HTML bookmark import/export and format round-trip regressions. |

| Documentation | Purpose |
| --- | --- |
| [API](API.md) | Endpoints, curl examples and request limits. |
| [Benchmarks](BENCHMARK.md) | Reproducible measurements and their limits. |

## Further reading

- [Architecture and module ownership](ARCHITECTURE.md)

- [Release installation](RELEASE_INSTALL.md) · [Container images](CI.md#ghcr-images)
- [Archive limits](ARCHIVES.md) · [Feature coverage](FEATURES.md)
- [Client compatibility](REAL_CLIENTS.md)
