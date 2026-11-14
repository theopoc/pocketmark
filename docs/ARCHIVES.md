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
stored transactionally as 64 KiB PostgreSQL binary chunks. A failed upload rolls back; deleting
a bookmark or attachment cascades to its chunks. Downloads release the database
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
| `GET /api/backup` | Owner-only ZIP (recent password confirmation for browser sessions) containing a consistent PostgreSQL dump and restore instructions |

Native attachment uploads, manual preservation, rich-reader generation and backup
share one work slot; standalone uploads share the import slot.
A competing operation on the same slot receives HTTP 409. Original downloads
always use attachment disposition. Bookmarks open on **Saved formats**, with
labeled HTML, Screenshot and PDF icons and explicit availability states. No article
or description is displayed automatically. A shortcut opens the newest attachment
of its format, with earlier copies available in the selector; Screenshot also
includes saved raster images. When no HTML attachment exists, the basic archive
opens as a simplified sandboxed page. Its source remains downloadable under
Reading options when attachments exist. The **View** action in
**Saved formats → Manage files** also opens the integrated viewer for raster images, PDFs and HTML,
including standalone files. Its selector switches between saved attachments;
**Download original** remains available. PDF display uses the browser's native
viewer and may depend on browser settings.

HTML previews retain saved styles and embedded images/fonts up to the full
20 MiB attachment limit, independently of the structural reader's 2 MiB limit.
They use an opaque CSP sandbox with scripts, forms, frames and network resources
blocked. The parent shell’s `frame-src blob:` policy blocks network navigation from the nested frame, including navigation initiated by saved markup. Direct HTML `/view` responses use attachment disposition: rendering requires the integrated viewer. Missing resources
stay missing; this preserves the saved appearance, not live-site interactivity.
Preparation uses bounded byte copying and temporary disk files in the existing
single work slot; no browser process or resident cache is added. Closing the
viewer unloads its content. Untrusted HTML never gains the application's origin. The API does not upload to a third-party service.

Backup runs PostgreSQL's pg_dump against a consistent snapshot. The temporary SQL file lives in the application work directory. Reserve space for the dump including hex-encoded binary data. The ZIP contains uploaded originals, archives, metadata, account and API-key records and restore instructions. Sessions and recovery codes are excluded. Restore into an empty dedicated database while all application instances are stopped, preserve the server secret, then sign in and regenerate recovery codes. See the [backup guide](GUIDE.md) for commands.

HTML preview preparation deliberately does not parse or sanitize saved markup.
It copies at most 20 MiB through a bounded buffer to avoid memory amplification
from adversarial tags with many attributes. The nested opaque sandbox, parent
CSP and attachment disposition are mandatory security boundaries. Navigation,
scripts, forms and network resources remain blocked in the integrated viewer.
Downloaded originals remain untrusted files; opening them outside Pocketmark is
outside this boundary.

## Card thumbnails

Automatic HTML capture also tries the page's first `og:image` (falling back to
`twitter:image`). Relative URLs use the final page URL after redirects. The
optional image uses the same public-address DNS pinning and redirect filtering,
with a five-second deadline, a 512 KiB response limit and at most one million
pixels. JPEG and PNG are accepted; animated PNG, SVG and other formats are
omitted. Only image headers are decoded on the server. Image failure does not
fail HTML capture. Existing bookmarks obtain an image on their next capture.

Thumbnail bytes are a persistent PostgreSQL cache, committed with capture status.
There is no resident image map or background renderer. Recapture replaces the
cache; changing the URL or deleting the bookmark removes it. Full database
backups preserve it; metadata exports omit it. Disk use is at most 512 KiB per
cached bookmark (plus database overhead). This is optional preview metadata, not
an archive attachment.

Grid cards load thumbnails lazily from the authenticated
`GET /api/links/{id}/thumbnail` endpoint. List view does not initiate image loads.
Private HTTP caching uses ETag revalidation, so a recapture cannot leave a stale
image cached indefinitely. Missing or failed images leave the original card
layout. The original page remains the source of the preview's appearance.

## Bookmark site icons

When a wide list is visible, Pocketmark requests icons for its displayed bookmarks. The server reads the icon link from the saved HTML when available, falling back to `/favicon.ico` at the bookmark origin. It contacts the icon host named by the saved page, or the bookmark origin as a fallback, without using an icon lookup service; this reveals the server IP to that host. Fetches share capture’s public-address and redirect checks, have a five-second total deadline, a 128 KiB limit and at most two concurrent requests. PNG, JPEG, GIF and ICO are supported; SVG and unsupported or oversized images fall back to a neutral icon. Icons are not stored on the server; the authenticated browser caches successful responses privately for one hour. Files and narrow or grid views do not trigger icon requests. A failed request is retried once; later attempts occur when the list is refreshed.
