# Archives, attachments and manual backup

Pocketmark keeps the lightweight automatic HTML/text capture. Manual offline
preservation adds a passive HTML snapshot with embedded CSS, raster images and
fonts. It follows the same public-address DNS pinning as the basic capturer,
including redirects and every resource request. Resources are fetched one at a
time, with no browser process and no in-memory resource cache.

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
| `DELETE /api/assets/{assetId}` | Delete metadata and all chunks |
| `POST /api/links/{id}/preserve` | Create offline HTML; returns `{asset, embedded, omitted}` |
| `GET /api/links/{id}/reader?asset=123` | Sandboxed reader; `asset` is optional |
| `GET /api/backup` | Owner-only ZIP containing a consistent complete SQLite database and restore instructions |

Native attachment uploads, manual preservation, rich-reader generation and backup
share one work slot; standalone uploads share the import slot.
A competing operation on the same slot receives HTTP 409. Untrusted archives
are always downloaded as attachments and never rendered on the application's
origin. The API does not upload to a third-party service.

Backup uses SQLite `VACUUM INTO` to include committed WAL data in a consistent
snapshot. The temporary snapshot is written in the data directory, then streamed
into an uncompressed ZIP with constant-size copy buffers. It requires free disk
space approximately equal to the database size and briefly occupies the single
database connection. It contains all archive bytes, uploads and account records;
treat it as sensitive. Preserve the existing `access-token` file or
`POCKETMARK_TOKEN` separately. Restore with the service stopped into an empty data
directory, never alongside an old WAL/SHM file. No scheduled backup is enabled.
