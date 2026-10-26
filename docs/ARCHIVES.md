# Archives, attachments and manual backup

Pocketmark keeps the lightweight automatic HTML/text capture. Manual offline
preservation adds a passive HTML snapshot with embedded CSS, raster images and
fonts. It follows the same public-address DNS pinning as the basic capturer,
including redirects and every resource request. Resources are fetched one at a
time, with no browser process and no in-memory resource cache.

The automatic capture accepts HTML responses up to 2 MiB, with individual tokens
bounded to that same limit. Large inline scripts, styles and data attributes do
not prevent text extraction within this budget; scripts and styles are excluded
from indexed text. This server capture is separate from the browser extension's
attachments: a failed automatic capture does not remove successful HTML, image
or PDF uploads.

Limits are deliberate: 45 seconds per snapshot, 25 HTTP resource requests
including the main document, 2 MiB per response, 12 MiB total downloaded bytes,
and 20 MiB final HTML. Scripts, frames, embedded media, SVG and CSS `@import`
rules are omitted. The result includes `embedded` and `omitted` counters for
fetched resources; the counters do not enumerate structurally excluded elements.
Snapshots contain an offline CSP. Missing or oversized resources therefore stay
missing instead of loading from the network when the file is opened. Normal
links remain links to the original website. Interactive/JavaScript applications
need an HTML snapshot from the user's browser.

Each bookmark supports up to 32 attachments, each at most 20 MiB: PDF, PNG, JPEG,
GIF, WebP or HTML/SingleFile. Uploads are staged in the data directory and then
stored transactionally as 64 KiB SQLite chunks. A failed upload rolls back; deleting
a bookmark or attachment cascades to its chunks. Downloads release the SQLite
connection between chunks so slow clients do not monopolize it. Uploaded HTML is
indexed for search with a 256 KiB extracted-text limit and a 2 MiB individual HTML
token limit; a failed extraction leaves the original download intact and returns
an `X-Pocketmark-Warning` header. PDF/image OCR is not performed.

The library's **Upload file** action also creates a standalone document without
a website URL. Its opaque `pocketmark-file:` identifier is never fetched over the
network. Metadata and payload are committed together; interrupted uploads leave
no empty record. Full backups preserve standalone bytes; JSON preserves metadata
only, and HTML/XBEL browser exports exclude these records.

The structured reader retains headings, paragraphs, lists, tables, code and
safe links. It removes scripts, forms, styles and remote images, and is protected
by an HTTP CSP sandbox. Uploaded HTML is preferred over a basic network capture.
The reader currently accepts HTML archives up to 2 MiB, with at most 1 MiB of
rendered markup. Larger files remain downloadable.

| Endpoint | Behavior |
| --- | --- |
| `GET /api/links/{id}/assets` | List attachment metadata |
| `POST /api/files?name=document.pdf&collection=123` | Create standalone file and payload atomically; optional collection |
| `POST /api/links/{id}/assets?name=page.html` | Raw binary body with its MIME Content-Type; returns attachment metadata |
| `GET /api/assets/{assetId}` | Force-download original bytes |
| `GET /api/assets/{assetId}/view` | Inline image/PDF; HTML payload fetched by the isolated UI viewer, direct navigation downloads |
| `DELETE /api/assets/{assetId}` | Delete metadata and all chunks |
| `POST /api/links/{id}/preserve` | Create offline HTML; returns `{asset, embedded, omitted}` |
| `GET /api/links/{id}/reader?asset=123` | Sandboxed reader; `asset` is optional |
| `GET /api/backup` | Owner-only ZIP containing a consistent complete SQLite database and restore instructions |

Native attachment uploads, manual preservation, rich-reader generation and backup
share one work slot; standalone uploads share the import slot.
A competing operation on the same slot receives HTTP 409. Original downloads always use attachment disposition. The **View** action in
**Reader → Files** opens an integrated viewer for raster images, PDFs and HTML,
including standalone files. Its selector switches between saved attachments;
**Download original** remains available. PDF display uses the browser's native
viewer and may depend on browser settings.

HTML previews retain saved styles and embedded images/fonts up to the full
20 MiB attachment limit, independently of the structural reader's 2 MiB limit.
They use an opaque CSP sandbox with scripts, forms, frames and network resources
blocked. The parent shell’s `frame-src blob:` policy blocks network navigation from the nested frame, including HTML parsing contexts missed by lexical filtering. Direct HTML `/view` responses use attachment disposition: rendering requires the integrated viewer. Missing resources
stay missing; this preserves the saved appearance, not live-site interactivity.
Preparation uses bounded tokenization and temporary disk files in the existing
single work slot; no browser process or resident cache is added. Closing the
viewer unloads its content. Untrusted HTML never gains the application's origin. The API does not upload to a third-party service.

Backup uses SQLite's online backup API to include committed WAL data in a
consistent snapshot. A temporary read-only connection pins the source version;
a temporary destination connection copies at most 1 MiB per step. Both have 2 MiB
page-cache targets and disabled mmap, and close when copying finishes. The normal
application connection remains available to reads and writes. Spilled destination
pages are synced every 8 MiB to limit dirty filesystem-cache pressure in small
containers. The snapshot is
written in the data directory, then streamed into an uncompressed ZIP with
constant-size copy buffers. Unlike a vacuum, this preserves free database pages
instead of compacting the file. It requires free disk space approximately equal
to the database size, plus any WAL growth while the read view is pinned.
Preparation and download have a five-minute overall deadline; network writes
have a renewable 30-second deadline so a progressing large download can exceed
the normal 60-second HTTP write limit. It contains all archive bytes, uploads and
account records; treat it as sensitive. Browser sessions are removed from the
snapshot only; live sessions remain valid, and restoring requires signing in
again. Preserve the existing `access-token` file or
`POCKETMARK_TOKEN` separately. Restore with the service stopped into an empty data
directory, never alongside an old WAL/SHM file. For older backups or raw database copies, rotate the recovery secret to invalidate restored cookies and API keys. Review restored API keys because a rollback can restore keys revoked after the backup. No scheduled backup is enabled.

HTML token filtering removes ordinary `href`/SVG `xlink:href` destinations as defense in depth; it is not a complete HTML5 sanitizer. The nested viewer and attachment disposition are mandatory security boundaries. Downloaded originals remain untrusted files; opening them outside Pocketmark is outside this boundary.
