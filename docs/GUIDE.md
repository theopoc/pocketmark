# Pocketmark guide

A personal bookmark manager built for low RAM usage: one Go executable, PostgreSQL and a small embedded web interface. Save links, organize collections and tags, search captured text, and import an existing bookmark library.

PostgreSQL stores the library. The Go process serves requests and handles capture. Public HTML capture runs on the server; JavaScript-rendered capture and screenshots run in your existing browser through the included extension. The personal Chrome extension uses the native API; Floccus synchronizes through WebDAV.

## Start locally

Requirements include Go from `go.mod`, Node.js 24, npm and Make. Start PostgreSQL 18 with a dedicated empty database owned by the application role. Its installation must provide the trusted extensions `unaccent` and `fuzzystrmatch`. Install PostgreSQL 18 client tools for native backup and restore. For the packaged database and client use the Compose quick start in the README.

```sh
export POCKETMARK_DATABASE_URL='postgresql://pocketmark@localhost/pocketmark'
# Configure the password in a private libpq password file.
make build
./bin/pocketmark
```

Open [http://127.0.0.1:8090](http://127.0.0.1:8090) and create your personal account. Register an authenticator app with the local QR code or setup key, verify a code and save the single-use recovery codes. On later visits, sign in with your username, password and an authentication or recovery code. Once signed in, open **Settings → API keys** to create or revoke a key for each extension or client.

Existing installations keep their credentials and keys. Existing MFA and browser sessions remain valid when the original server secret is preserved. Legacy administrator bearer access is removed; create named API keys and update integrations before upgrading to avoid interruption. If no password was configured before upgrading, follow [account recovery](API.md#existing-installations-and-account-recovery); public account creation cannot claim an existing library.

The default data directory is `./data`, containing temporary working files and the automatically generated private `server-secret` file (mode `0600`). Existing installations continue to use their original `access-token` file or `POCKETMARK_TOKEN` as the internal secret. It protects TOTP and session digests, is never entered in the browser and is not an API credential. Preserve it separately with backups. Restrict access to an empty instance until account and MFA setup are complete. Stop with Ctrl+C. To run without fetching bookmarked pages:

```sh
./bin/pocketmark -no-capture
```

## Docker Compose

Set the database password as described in the [quick start](../README.md#quick-start).

```sh
docker compose up --build -d
```

Open the same local URL. Compose stores the database and server secret in separate named volumes and publishes port 8090 on host loopback only. The image runs as UID/GID `10001:10001`; a custom bind-mounted data directory must be writable by that user.

Tagged releases also publish a private multiarchitecture image at `ghcr.io/theopoc/pocketmark:vMAJOR.MINOR.PATCH` for Linux AMD64/ARM64. After authenticating Docker with read access to the package, use that image in place of `build: .` in your Compose configuration. Keep the same volume, port binding and resource/security settings. See [GHCR publication and verification](RELEASE.md#ghcr-images).

The supplied Compose configuration sets a **128 MiB application container memory limit** and one CPU. This is a deployment limit, not a guarantee that every workload completes within it. See [memory measurement methodology](BENCHMARK.md) for workload boundaries.

PostgreSQL provides shared durable storage. The current server keeps pending MFA challenges and request limits in memory per process. Use one application instance for the documented authentication behavior. A PostgreSQL migration by itself does not qualify a multi-replica rollout.

## What is included

- Bookmarks with descriptions, personal notes, favorite/read flags and tags.
- Nested collections, an inbox, filtering and 40-item paginated lists.
- PostgreSQL full-text search across title, URL, description, notes, tags and captured text. Search terms are combined with AND and match token prefixes; matching ignores case and common diacritics.
- A persistent, sequential capture queue; failed captures can be retried. Interrupted jobs resume after restart.
- Plain-text reading and downloadable original HTML for public HTML pages.
- Legacy JSON import, Pocketmark JSON export/import and an authenticated [HTTP API](API.md).
- Rename/move collections, atomic bulk actions, sorting and automatic typo-tolerant metadata matches alongside full-text search.
- Anchored highlights and annotations, with stale highlights identified after a page changes; a separate structural reader preserves headings, lists, code and tables.
- Browser bookmarks HTML import/export and WebDAV/XBEL synchronization for Floccus.
- PDF, image and SingleFile/HTML files (standalone or attached) streamed in 64 KiB PostgreSQL chunks; manual offline snapshots with embedded resources.
- Personal password and TOTP login, named revocable API keys and an owner-only full ZIP backup while the app runs.
- Installable mobile web interface, share target, and a small [browser extension](../extension/README.md). The Linkwarden compatibility API and third-party extension/mobile integration have been removed.

Default capture fetches one HTML response, with a 20-second timeout, at most five redirects, a 2 MiB response/decompressed-body limit and up to 256 KiB of extracted text. When adding or editing a bookmark, select **Save an HTML copy** for bounded resource embedding, or use the extension for an already-rendered page and a visible-tab PNG screenshot. The same Chrome extension generates PDF and full-page screenshots on demand, using an explicit debugger permission; [installation and limits](../extension/README.md). Existing PDF, image and HTML files can be attached under **Saved formats → Manage files**. No Chromium instance runs on the server. Private, loopback and reserved network destinations can be bookmarked, but server capture refuses them. See [archive limits](ARCHIVES.md).

Collaboration/public sharing, SSO/OIDC, RSS, AI automation, scheduled recapture and automatic backups are intentionally excluded. Screenshots and PDF rendering consume memory in the user's browser; their memory is not included in server measurements. See [client compatibility and verification](REAL_CLIENTS.md) for observed workflows and qualification limits. The supported integration paths are the Pocketmark Chrome extension and Floccus WebDAV; older Linkwarden client observations do not qualify the new extension.

## Configuration

| Setting | Default | Purpose |
| --- | --- | --- |
| `POCKETMARK_DATABASE_URL` | Required | PostgreSQL connection URI for a dedicated database. |
| `POCKETMARK_DATA` / `-data` | `./data` | Private work and server secret directory. |
| `POCKETMARK_LISTEN` / `-listen` | `127.0.0.1:8090` | HTTP bind address; Docker uses `0.0.0.0:8090` internally. |
| `POCKETMARK_TOKEN` | Generated server secret | Legacy override for the internal TOTP/session secret; at least 24 characters, never an API credential. |
| `POCKETMARK_ORIGIN` | Request origin | Public origin such as `https://bookmarks.example.com`, without a path. |
| `POCKETMARK_TRUSTED_PROXIES` | Empty | Comma-separated trusted proxy CIDRs for HTTP and login client limits; see [HTTPS deployment](API.md#public-https-deployment). |
| `POCKETMARK_RATE_LIMIT` | `10` | HTTP requests per second per client IP (1–1000); [rate limiting](API.md#http-rate-limiting). |
| `POCKETMARK_RATE_BURST` | `100` | Per-client HTTP burst capacity (1–10000). Zero and invalid values prevent startup. |
| `POCKETMARK_SECURE_COOKIE` | `false` | Set `true` for HTTPS session cookies; an HTTPS origin enables this automatically. |
| `POCKETMARK_CAPTURE` / `-no-capture` | Capture enabled | Set the environment variable to `false`, or pass the flag, to disable capture. |
| `GOMEMLIMIT` | `32MiB` | Soft Go runtime memory budget; PostgreSQL memory and total process RSS are outside this budget. |

Explicit flags override their environment defaults. For access through an HTTPS reverse proxy, configure `POCKETMARK_ORIGIN` to the exact public origin. Forward requests to the HTTP listener; browser mutation requests are checked against the configured origin. The app does not terminate TLS itself.

## Import a bookmark library

1. Export your existing library as a supported JSON file, such as `backup.json`.
2. In Pocketmark, choose **Import** and select that JSON file, or use the [import API](API.md#import-and-export).
3. Check the imported/skipped counts. Captures run afterward unless disabled.

The importer accepts the legacy JSON export object, including flat collections with `parentId`, tag objects and pinned links. It retains bookmark names, URLs, descriptions, collection hierarchy, tag names and pins. Pocketmark exports additionally retain personal notes and read flags. Valid source RFC3339 timestamps are preserved; absent timestamps use the import time. Browser HTML bookmark files can also be selected with **Import**.

Imports are limited to **8 MiB**, **10,000 links** and **2,000 collections** per file. Existing duplicate URLs and unsupported uploaded-file record types are skipped. Invalid URL records, broken collection references or cyclic hierarchies roll back the entire import. Existing collections with the same name and parent are reused on repeat imports. Transfer original uploaded files separately through the attachment upload.

JSON import/export does not include captured HTML, extracted text or other archived assets. Source accounts, permissions, RSS subscriptions, highlights and settings are not migrated. Pocketmark's export uses its own versioned JSON format.

## Back up everything

Choose **Settings → Backup & restore → Download full backup**. Pocketmark uses `pg_dump` to write a consistent snapshot to its private work directory and streams it as a ZIP. Provision enough space for the logical SQL dump, which encodes binary data. Store the ZIP and original server secret securely. Restore `pocketmark.sql` into an empty dedicated database with Pocketmark stopped:

```sh
psql -X --single-transaction -v ON_ERROR_STOP=1 -d "$POCKETMARK_DATABASE_URL" -f pocketmark.sql
```

Restore the original server secret before startup. Sign in again and generate new recovery codes. The snapshot excludes browser sessions and recovery codes. To upgrade a SQLite library, follow the [migration procedure](MIGRATION_POSTGRESQL.md).

## Development and verification

Use the [contributor checklist](../AGENTS.md#verification-and-delivery) for local checks and the [architecture map](ARCHITECTURE.md) to find the implementation and its tests. Native CI runs race tests and builds Linux AMD64 and ARM64 binaries. The [release workflow](RELEASE.md#ghcr-images) qualifies the container images. For optional RAM measurements, use the [benchmark workloads](BENCHMARK.md).

## Further reading

- [Architecture and module ownership](ARCHITECTURE.md)

- [Release installation](RELEASE_INSTALL.md) · [Container images](RELEASE.md#ghcr-images)
- [Archive limits](ARCHIVES.md) · [Feature coverage](FEATURES.md)
- [Client compatibility](REAL_CLIENTS.md)
