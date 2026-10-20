# Pocketmark

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Pocketmark is for its owner's strictly personal use. The owner saves, organizes, finds and reads their own bookmarks on desktop and mobile. A broader audience or team workflow is not a product requirement.

## Product Purpose

Provide a personal library for useful links and saved material, with collections, tags, search and reading tools. Success means being able to save material, retrieve it later and preserve the library while keeping server resource use low.

## Positioning

A self-hosted bookmark library built around one Go process, SQLite/FTS5 and an embedded dependency-free web interface. Rendering JavaScript pages, screenshots and PDFs belongs in the owner's existing browser rather than a resident server browser. Low server RAM is the primary architectural constraint, not a universal memory guarantee.

## Operating Context

- Use the web interface on desktop and mobile; installable mobile web and share-target support depend on the browser and OS.
- Save and capture pages through the companion browser extension when browser rendering is needed.
- Organize bookmarks in nested collections and tags, with an Inbox, favorites and read/unread status.
- Search bookmark metadata and captured text, read saved content, and add highlights and notes.
- Import existing legacy client or browser bookmark metadata; optionally synchronize with Floccus through the supported compatibility interfaces.
- Run locally or self-host behind a configured reverse proxy. Full backups and portable metadata exports serve different purposes.

## Capabilities and Constraints

- Preserve existing library data, stable identities, notes, archives and unrelated work.
- Retain Go, CGO-backed SQLite/FTS5 and the embedded HTML/CSS/JavaScript UI; no resident browser, database or search sidecars.
- Prefer standard-library solutions, bounded queues and disk-backed or streamed work. Justify dependencies and caches against the RAM goal.
- Keep origin checks, SSRF protections, request limits and archive boundaries intact.
- Collaboration, public sharing, SSO/OIDC, RSS, AI automation, scheduled recapture and automatic backups are outside scope.
- Client compatibility covers selected private-library operations; it is not complete compatibility with every endpoint or client.
- Metadata JSON/HTML exports do not contain the complete archive library. The owner-only full ZIP backup preserves the database and saved assets; the recovery token must be kept separately.
- The prolonged-offline cache limitation in the official Android client remains unresolved. Physical phones, iOS, Firefox and Safari are not established as qualified clients by the current evidence.

## Brand Commitments

The product name is Pocketmark. Keep the interface in English. Desktop and mobile are both supported usage contexts. No additional binding voice, aesthetic direction or accessibility requirement was established during initialization.

## Evidence on Hand

- `README.md`: product scope, operation, development and backup instructions.
- `docs/FEATURES.md`: capabilities, exclusions and compatibility boundaries.
- `docs/REAL_CLIENTS.md`: actual client observations and untested workflows; distinguish these from protocol tests.
- `docs/BENCHMARK.md`: measured resource workloads and exclusions; do not turn results into a universal RAM promise.
- `docs/API.md` and `docs/ARCHIVES.md`: security, request and capture boundaries.
- `internal/webui/static/`: existing interface, product copy and assets. An established interface exists; missing design documentation does not make it a blank slate.

## Product Principles

1. Serve the owner's personal library and workflows without adding team or public-product scope.
2. Keep server resource use low and move rendering work to the owner's browser.
3. Preserve the library and make data movement and recovery explicit.
4. Keep saving, finding and reading practical on desktop and mobile.
5. State capture and compatibility limits honestly, using tested evidence rather than implied guarantees.
