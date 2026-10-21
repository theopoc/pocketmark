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
| Offline page | Manual passive server snapshot with bounded CSS/image/font embedding. Limits and omissions: [ARCHIVES.md](ARCHIVES.md). |
| JavaScript page | The included MV3 extension captures the page after JavaScript has run in the user's browser. It uploads passive rendered HTML. Cross-origin images/styles may be unavailable for embedding. |
| Screenshot | Default extension captures the visible tab as PNG. An explicitly installed advanced Chromium variant captures a full page, bounded to 16 megapixels and 16,384 pixels per axis, including Retina pixel density. |
| PDF | Advanced Chromium extension generates and uploads PDF from the current rendered page, using a bounded stream. The default extension/other browsers can use Print → Save as PDF followed by upload. No server PDF renderer. |
| Personal authentication | First-run creation of one personal account, username/password (PBKDF2-SHA256, 600,000 iterations), seven-day signed cookie. Changing password settings invalidates older cookies. No additional registration or multi-user accounts. No token-based browser login; existing administrative token retained for API recovery. |
| API keys | Up to 32 named keys, revealed once, stored hashed, individually revocable. Library access only; account/key management and full backups require the owner session or recovery token. |
| Backup | Manual, owner-only ZIP of a transactionally consistent SQLite snapshot, streamed from disk. Includes archives, attachments, annotations and credential hashes; excludes the recovery-token file. |
| Mobile web | Responsive installable manifest, minimal static-only service worker, share target. Installation/share support depends on browser/OS. Private pages and API data are never cached by the service worker. |
| Floccus | Native API backend and WebDAV/XBEL, verified with Floccus 5.11.1. DAV includes API-key authentication, lock/temp/MOVE, exact bytes, stable numeric IDs and ordering. No recurring server sync process. |
| Compatibility clients | Core API adapter based on inspected official client source: password session issuance, configuration, private collections/links/tags, search, dashboard, archives and highlights. Integration tests exercise request/response shapes. Actual official apps are not certified as fully compatible. Unsupported endpoints return errors. |

## Browser integration

The [extension](../extension/README.md) uses only the active tab, stores a named API key locally, and asks for access to the configured server origin. Saving, screenshots and HTML capture happen only on a user click. It does not run a background capture worker. Browser RAM belongs to the client, not the Go server budget. No extension is silently installed into an existing user profile.

PDF and full-page capture require the separate advanced Chromium package, built with `python3 extension/build_advanced.py /your/chosen/folder`. Chrome does not allow the `debugger` permission to be optional, so the default package excludes it entirely. The advanced package declares that permission and attaches only to the tab chosen for capture, then detaches before uploading. Install it only if you accept that broader browser permission. Actual Chrome tests verified PDF, full-page PNG, rendered HTML and recovery after a permission dialog closes the popup. See [runtime evidence and regression tests](REAL_CLIENTS.md).

For a compatible third-party client, use the Pocketmark server origin and the username/password created at first run or updated in Settings, or a named API token if the client offers token configuration. Successful credential login creates a revocable named key; revoke it from Pocketmark’s API keys menu. The adapter advertises `2.14.1-pocketmark-compat` for version-gated client shapes and `POCKETMARK_COMPAT:true`; this is a protocol compatibility level, not the server's product version. Billing, public collections, user administration, OAuth and NextAuth flows are not implemented.

## Floccus setup and data semantics

The native API backend also supports synchronization: enter the Pocketmark origin, a descriptive username and a dedicated API key as the access token. Choose a server collection and local bookmark folder. Real Floccus tests verified creation, bidirectional edits, nested folders, moves and deletion. This backend does not preserve bookmark ordering, as documented by Floccus.

Choose the WebDAV backend with **XBEL**, server URL `https://your-pocketmark/dav/`, file `bookmarks.xbel`. Leave Floccus file encryption disabled: Pocketmark needs readable XBEL to integrate the bookmark tree. Use any username plus a separate dedicated API key per client as the password. Personal account passwords are not accepted for WebDAV, avoiding password derivation on every request. HTTPS is required outside localhost. Set the server's exact `POCKETMARK_ORIGIN` for its web interface.

The XBEL file represents the website bookmark/collection metadata tree. Uploading it applies deletions as well as additions; first download/merge the existing server library in the client. Back up before the first synchronization. Standalone file records are omitted and survive synchronization. Existing URLs retain notes, tags, favorites, read flags, captures and annotations; an omitted description preserves its current value. A URL edit carrying a stable ID preserves personal metadata, attachments and annotations, clears the old captured page, and marks its annotations stale until they match new content. Exports use globally unique numeric IDs and retain Floccus's highest allocated ID and sibling order across native edits. Legacy `b-`/`c-` IDs remain accepted on import. Conflicting or repeated identities and duplicate URLs are rejected transactionally. XBEL is bounded to 8 MiB, 10,000 bookmarks, 2,000 collections and 64 folder levels.

The staged upload/MOVE sequence preserves exact uploaded bytes. Native changes during a locked synchronization and expired/reacquired leases without a fresh download reject stale writes with 412; competing client credentials receive 423. Floccus can then retry from the current library. Direct PUT remains available; use `If-Match` to prevent replacing a newer snapshot. See [protocol details](CLIENT_FLOCCUS_NOTES.md) and [real-client results](REAL_CLIENTS.md).

## Remaining qualification, not implemented guarantees

- No server-side Chromium or perfect arbitrary-site offline reproduction. Full-page/PDF generation uses the advanced extension in the user's browser.
- Real Chrome and third-party Android 1.4.4 emulator qualification cover the workflows in [REAL_CLIENTS.md](REAL_CLIENTS.md). Prolonged offline opening has a client cache limitation. iOS, physical phones, Firefox and Safari remain untested.
- Uploaded PDF/image bytes are preserved; PDF text extraction and image OCR are not provided.
- A server snapshot cannot log into websites; the user's browser can capture a page they have opened, subject to its permissions and resource restrictions.
- RAM measurements exclude the user's browser and Docker VM; see [BENCHMARK.md](BENCHMARK.md) for measured workloads rather than a universal memory guarantee.
