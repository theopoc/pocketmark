# Personal feature coverage

This implementation retains Go + SQLite and no resident browser/database/search sidecars. Collaboration, public sharing, SSO/OIDC and automations (RSS/AI, recurring captures and scheduled backups) are excluded by request.

| Feature | Implementation and limits |
| --- | --- |
| Collection management | Create, rename, move, delete; optional 8 KiB description, stable creation date and cycle prevention. Deleting a collection retains bookmarks in Inbox. |
| Bulk operations | Up to 500 selected IDs per atomic request: move, replace tags, read/unread, favorite/unfavorite, recapture, delete. |
| Search and sorting | FTS5 full text; newest/oldest/title/updated sorting. Optional typo matching scans bounded metadata per row, rather than keeping a second search index in RAM. It is slower on a large library and does not fuzzy-scan archive bodies. |
| Highlights | Selected quote, Unicode position, color and note. A digest identifies stale anchors after recapture; stale quotes are retained without painting the wrong text. |
| Reader | Plain text with highlights; separate sandboxed structural HTML reader with tables/headings/code. No script execution or remote resources. |
| Browser import | Streaming Netscape HTML import/export, nested folders, transactional validation and duplicate URL skipping. |
| JSON migration | Pocketmark and legacy JSON metadata, nested collections, source timestamps, existing hierarchy reuse. Archives/annotations are preserved by full backup, not metadata JSON. |
| File archive | PDF/raster image/HTML/SingleFile uploads, standalone or attached to a bookmark, 20 MiB each, 32 per record. Original bytes stream in 64 KiB SQLite chunks. Upload HTML becomes searchable. Standalone files use internal opaque identifiers and never enter the network capture queue. |
| Capture viewer | Bookmarks open on HTML, Screenshot and PDF shortcuts with icons and saved/not-saved states, without automatic article text. Each shortcut opens the newest copy with earlier copies selectable and original download available. Images include uploaded images, not only screenshots. HTML attachments keep embedded styles/resources in an opaque sandbox; scripts and network resources are blocked. Basic HTML archives use the simplified sandboxed reader. |
| Offline page | Manual passive server snapshot with bounded CSS/image/font embedding. Limits and omissions: [ARCHIVES.md](ARCHIVES.md). |
| JavaScript page | The included MV3 extension captures the page after JavaScript has run in the user's browser. It uploads passive rendered HTML. Cross-origin images/styles may be unavailable for embedding. |
| Screenshot | The Chrome extension captures the visible area or a full page as PNG. Full-page output is bounded to 16 megapixels and 16,384 pixels per axis, including Retina pixel density. |
| PDF | The Chrome extension generates and uploads PDF from the current rendered page, using a bounded stream. Other browsers can use Print → Save as PDF followed by upload. No server PDF renderer. |
| Personal authentication | One account with mandatory password (PBKDF2-SHA256, 600,000 iterations) and TOTP or a single-use recovery code. Local QR enrollment; seven-day revocable cookie with configurable inactivity expiry. Initial enrollment and administrative recovery use the server's private key. API keys remain separate. |
| API keys | Up to 32 named keys, revealed once, stored hashed, individually revocable. Read/capture/sync/full permission profiles, optional expiry and rotation. Account/key/session management and full backups require the owner; sensitive browser actions require recent password confirmation. |
| Backup | Manual, owner-only ZIP of a transactionally consistent SQLite snapshot, streamed from disk. Includes archives, attachments, annotations and credential hashes; excludes the recovery-token file. |
| Mobile web | Responsive installable manifest, minimal static-only service worker, share target. Installation/share support depends on browser/OS. Private pages and API data are never cached by the service worker. |
| Floccus | WebDAV/XBEL; previously verified with Floccus 5.11.1. The Linkwarden API backend has been removed. DAV includes API-key authentication, lock/temp/MOVE, exact bytes, stable numeric IDs and ordering. No recurring server sync process. |

## Browser integration

The [personal Chrome extension](../extension/README.md) adds or edits the current page's title, collection and tags through the native API. Collections can be selected or created; new tags are saved with the bookmark. Exact URLs reuse the existing bookmark and preserve unrelated personal fields.

HTML, visible PNG, full-page PNG and PDF are independently selectable and off by default. One bounded background task continues after the popup closes. Captured files remain locally in IndexedDB until uploaded or explicitly discarded; failures require a manual retry. Earlier server attachments are retained. Chrome's `debugger` permission is declared at installation and used for the chosen source tab while capture/upload work runs. Rendering consumes client resources, not server RAM. See [installation and limits](../extension/README.md).

Linkwarden's `/api/v1/` and `/api/v2/` compatibility interfaces, third-party extension/mobile support and the Floccus Linkwarden API backend have been removed. WebDAV remains available, and no library data is deleted. Older client observations remain historical evidence in [REAL_CLIENTS.md](REAL_CLIENTS.md).

## Floccus setup and data semantics

Choose the WebDAV backend with **XBEL**, server URL `https://your-pocketmark/dav/`, file `bookmarks.xbel`. Leave Floccus file encryption disabled: Pocketmark needs readable XBEL to integrate the bookmark tree. Use any username plus a separate dedicated API key per client as the password. Personal account passwords are not accepted for WebDAV, avoiding password derivation on every request. HTTPS is required outside localhost. Set the server's exact `POCKETMARK_ORIGIN` for its web interface.

The XBEL file represents the website bookmark/collection metadata tree. Uploading it applies deletions as well as additions; first download/merge the existing server library in the client. Back up before the first synchronization. Standalone file records are omitted and survive synchronization. Existing URLs retain notes, tags, favorites, read flags, captures and annotations; an omitted description preserves its current value. A URL edit carrying a stable ID preserves personal metadata, attachments and annotations, clears the old captured page, and marks its annotations stale until they match new content. Exports use globally unique numeric IDs and retain Floccus's highest allocated ID and sibling order across native edits. Legacy `b-`/`c-` IDs remain accepted on import. Conflicting or repeated identities and duplicate URLs are rejected transactionally. XBEL is bounded to 8 MiB, 10,000 bookmarks, 2,000 collections and 64 folder levels.

The staged upload/MOVE sequence preserves exact uploaded bytes. Native changes during a locked synchronization and expired/reacquired leases without a fresh download reject stale writes with 412; competing client credentials receive 423. Floccus can then retry from the current library. Direct PUT remains available; use `If-Match` to prevent replacing a newer snapshot. See [protocol details](CLIENT_FLOCCUS_NOTES.md) and [real-client results](REAL_CLIENTS.md).

## Remaining qualification, not implemented guarantees

- No server-side Chromium or perfect arbitrary-site offline reproduction. Full-page/PDF generation uses the Chrome extension in the user's browser.
- Chrome runtime evidence is recorded in [REAL_CLIENTS.md](REAL_CLIENTS.md). Historical third-party Android and extension results no longer describe supported clients. iOS, physical phones, Firefox and Safari remain untested.
- Uploaded PDF/image bytes are preserved; PDF text extraction and image OCR are not provided.
- A server snapshot cannot log into websites; the user's browser can capture a page they have opened, subject to its permissions and resource restrictions.
- RAM measurements exclude the user's browser and Docker VM; see [BENCHMARK.md](BENCHMARK.md) for measured workloads rather than a universal memory guarantee.
