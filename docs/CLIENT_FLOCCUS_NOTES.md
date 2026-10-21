# Floccus 5.11.1 client preparation and protocol notes

Prepared from the [official v5.11.1 release](https://github.com/floccusaddon/floccus/releases/tag/v5.11.1), published 2026-10-02. These are source-derived expectations, not a claim that a browser synchronization has passed.

## Reproducible artifacts

- Chromium ZIP: `floccus-build-v5.11.1-chrome.zip`, 16,954,198 bytes.
- SHA-256: `00f2e6cbef9a5f06090890d2af4642841401d2d6edaf4f5aed8f3323c077a70e`, verified against the GitHub release asset digest.
- Release commit: `944fc3eadccc455c131dd06032f2d2ca17615c21`.
- Source tree: `501ff97b3b32387c0302485b55a6da7f5872d492`.
- Disposable unpacked extension: `/private/tmp/pocketmark-real-clients/floccus/chromium`.
- Original ZIP, release/commit metadata and selected source files: `/private/tmp/pocketmark-real-clients/floccus/`.
- Manifest V3; options page `dist/html/options.html`; service worker `dist/js/background-script.js`.

No dependency installation, source build or changes to the user's browser profile were performed during preparation.

## WebDAV protocol required by this release

The [WebDAV adapter](https://github.com/floccusaddon/floccus/blob/944fc3eadccc455c131dd06032f2d2ca17615c21/src/lib/adapters/WebDav.ts) uses a trailing-slash server URL and a relative filename, default `bookmarks.xbel`. Authentication is HTTP Basic on every request. The username can be arbitrary when Pocketmark's dedicated API key is supplied as the password. Do not configure a personal password or client-side encryption for Pocketmark's metadata-backed endpoint.

Actual browser sequence:

1. GET `bookmarks.xbel.lock`; if absent, PUT a small HTML lock document. A present lock needs `Last-Modified`; locks younger than 15 minutes block synchronization. Refresh interval is two minutes.
2. GET `bookmarks.xbel`, then PROPFIND that file with `Depth: 0`. The response's `getcontentlength` must equal the downloaded document's UTF-8 byte count.
3. When modified, PUT `bookmarks.xbel.temp`, then PROPFIND that temporary file to verify its exact uploaded byte count.
4. MOVE the temporary file to `bookmarks.xbel`, with an absolute `Destination` header and `Overwrite: T`.
5. PROPFIND the final file; its length must still equal the originally uploaded byte count. Reformatting XML during this operation fails validation.
6. DELETE the lock. Upload size mismatches are retried twice. A MOVE 409 makes the client attempt deletion of the destination before retrying.

The adapter does not send ETag preconditions for these writes. Safe implementation therefore needs atomic staging and lock handling; generic WebDAV GET/PUT coverage alone does not qualify this client. It sends Basic-authenticated extension requests, so extension-origin policy must cover DAV methods and headers if the browser supplies Origin/preflight.

## XBEL identity and ordering

The [XBEL serializer](https://github.com/floccusaddon/floccus/blob/944fc3eadccc455c131dd06032f2d2ca17615c21/src/lib/serializers/Xbel.ts) parses both bookmark and folder IDs with `parseInt`. Prefixes such as `b-1` and `c-1` become `NaN` and are incompatible. IDs must be unique numbers across both node kinds, with zero reserved for the root.

The [caching adapter](https://github.com/floccusaddon/floccus/blob/944fc3eadccc455c131dd06032f2d2ca17615c21/src/lib/adapters/Caching.ts) initializes its allocation counter to zero; the WebDAV adapter restores it from a `highestId` XML comment. New folders and bookmarks increment the same counter. The server must retain or regenerate a correct maximum so new IDs cannot collide. The serializer preserves child order and serializes only title, URL and ID; omitted descriptions must not silently erase Pocketmark-only metadata.

Floccus also requires the exact UTF-8 XML declaration produced by its serializer. Go's standard `xml.Header` matches this requirement. Original uploaded XML must remain retrievable unchanged through the immediate upload verification; later regenerated snapshots require stable numeric mappings and ordering.

## Historical Linkwarden API backend (removed)

This backend is no longer served by Pocketmark. The notes below describe the historical protocol inspection only; configure Floccus with WebDAV instead.

The former API adapter was separate from WebDAV. Its configuration used the Pocketmark origin, a dedicated API key in the password field, and a server folder such as `Floccus`. It sends Bearer authentication directly; it does not log in with a personal password.

It fetches `/api/v1/search?searchQueryString=` with cursor pagination, expecting `data.links` and `data.nextCursor`, then `/api/v1/collections`, expecting `response`. It creates a missing server folder, supports nested collection CRUD and link CRUD, and submits up to five concurrent requests. Bookmark updates read existing tags when tag synchronization is disabled. Its declared capabilities explicitly do not preserve custom ordering. Only HTTP(S) URLs should be used in Pocketmark validation; the client additionally accepts schemes Pocketmark intentionally rejects.

## Implemented protocol and regression coverage

Pocketmark supports the lock, temporary upload and MOVE sequence above. Temporary and committed XML are stored as bounded SQLite chunks; parsing and HTTP response staging use temporary files beside the database. The XML limit is 8 MiB. One heavy mutation runs at a time. No additional process or resident browser is introduced.

Each client should use its own API key. An active lease belongs to that credential, and a competing writer receives HTTP 423. A newly acquired or reacquired lease requires a fresh GET of the primary XML before uploading. Metadata edits made through Pocketmark during synchronization invalidate the client's snapshot; committing it receives HTTP 412. An expired lease remains a tombstone until reacquisition, so merely observing its absence cannot authorize a stale upload. The client must retry synchronization from a fresh server read.

Uploaded XML bytes, numeric IDs, the allocation watermark and sibling order survive a round trip. Native edits regenerate the XML while preserving mappings and the highest allocated ID, including previously deleted IDs. Omitted descriptions preserve the existing value; personal notes, flags, tags, annotations and attached files are not replaced by the browser's reduced bookmark metadata. Standalone uploaded files are omitted from browser XBEL and survive authoritative synchronization.

Go regressions cover authenticated extension requests, invalid credentials with a valid cookie, exact multibyte upload lengths, lock ownership, temporary resource visibility, MOVE destinations, snapshot invalidation, retained personal metadata, numeric identity, ordering, watermark retention and stale writers across lease expiration. The complete Go test suite passed on 2026-10-20. Browser runtime and memory measurements are recorded separately by the real-client validation workflow.

## Selected source checksums

| File | SHA-256 |
| --- | --- |
| `WebDav.ts` | `b5a767b18d17fe57c7c18af8926547e6063e11d44f6da5e8c0fefd73c1d09458` |
| `Xbel.ts` | `2c8dbe59a88070ef41bf602a12575c78f02bb19ae5dfadeed695a5d07df55a82` |
| `Caching.ts` | `1bdc3cbb459012be68fe1b664172895fa30f757529c6eeae40d79276a6229039` |
