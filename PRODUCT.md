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
- Search bookmark metadata and captured text. Open bookmarks on a choice of saved formats, showing only available HTML, Screenshot and PDF copies; never auto-open extracted text. Keep notes and existing highlights as optional secondary tools.
- Import existing JSON or browser bookmark metadata; optionally synchronize with Floccus through WebDAV.
- Run locally or self-host behind a configured reverse proxy. Full backups and portable metadata exports serve different purposes.

## Capabilities and Constraints

- Preserve existing library data, stable identities, notes, archives and unrelated work.
- Retain Go, CGO-backed SQLite/FTS5 and the embedded HTML/CSS/JavaScript UI; no resident browser, database or search sidecars.
- Prefer standard-library solutions, bounded queues and disk-backed or streamed work. Justify dependencies and caches against the RAM goal.
- Keep origin checks, SSRF protections, request limits and archive boundaries intact.
- Collaboration, public sharing, SSO/OIDC, RSS, AI automation, scheduled recapture and automatic backups are outside scope.
- The personal Chrome extension uses the native API. Linkwarden compatibility endpoints and third-party client integration are removed; Floccus WebDAV remains.
- Metadata JSON/HTML exports do not contain the complete archive library. The owner-only full ZIP backup preserves the database and saved assets; the server secret must be kept separately.
- Third-party Android/iOS clients are outside the supported scope. Physical phones, Firefox and Safari are not established as qualified clients by the current evidence.

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

## Saved-format journey

The owner chose a saved-format-first journey on 31 October 2026. Clicking a bookmark opens its title, source and only the saved formats that are available. Choosing a format opens its newest saved copy, with earlier copies accessible in the viewer. When no copy exists, explain how to save or attach one and keep Open original available for website bookmarks. Loading and failed checks must remain distinct from an empty archive. Extracted text and existing annotations remain secondary tools and never become the default opening destination.

The library keeps a direct Settings destination. Import explains accepted metadata files before file selection and retains its result. Single-key shortcuts are optional in this browser and apply only while browsing the library. The product remains strictly personal, dependency-free and in English.
