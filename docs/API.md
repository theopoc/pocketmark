# Pocketmark HTTP API

## Interactive API documentation

Open **API documentation** at the bottom of the library navigation, or visit
`/api-docs/` on your instance. Swagger UI lists the native HTTP API with request
schemas, filters, responses and errors. Search by tag or path, expand an operation,
then use **Try it out** to send a real request to your instance. Mutations affect
your library, including deletions.

Your existing owner session is sent automatically. Integrations can use
**Authorize** with a dedicated API key, without the `Bearer` prefix. Authorization
is held in tab memory and cleared on reload. Named keys retain their existing
restrictions: account settings, key management and full backups require an owner
session or recovery token. The documentation and specification are public static
files; API data still requires authentication.

Download the OpenAPI 3.0.3 specification from the page or
`/api-docs/openapi.json`. Its server URL is relative to the current instance, so it
works behind a reverse proxy without hard-coded hosts. Swagger UI is version-pinned
and embedded locally, with no CDN or external validator; it loads only on the docs
page. The library remains dependency-free. WebDAV `/dav/` uses a separate protocol
and is not included in the OpenAPI reference.

The canonical specification lives in
`internal/webui/static/api-docs/openapi.json`. When changing routes or payloads,
update it alongside this document. `make test` checks route coverage, local schema
references, security declarations and documentation delivery. Upstream asset
provenance and update instructions are in the adjacent `vendor/README.md`.

Base URL: `http://127.0.0.1:8090`. API endpoints require an owner session, recovery token or named API key unless explicitly public. First-run setup and login are public. `/healthz` is unauthenticated and returns `{"status":"ok"}` when SQLite is reachable. Named keys cannot access account/key management or full backups.

`GET /metrics` exposes Prometheus text metrics using the same session/bearer
authentication. Responses include a server-generated `X-Request-ID` for log
correlation. See [observability](OBSERVABILITY.md) for metrics, JSON log fields and
optional OpenTelemetry tracing; `/metrics` is operational and outside the native
JSON API specification.

For these examples, load your local token without putting its value directly in the command:

```sh
POCKETMARK_ACCESS_TOKEN="$(cat ./data/access-token)"
POCKETMARK_URL=http://127.0.0.1:8090
curl --fail-with-body -H "Authorization: Bearer $POCKETMARK_ACCESS_TOKEN" "$POCKETMARK_URL/api/stats"
```

For Docker, use `POCKETMARK_ACCESS_TOKEN="$(docker compose exec -T pocketmark cat /data/access-token)"` instead. JSON mutation requests use `Content-Type: application/json`. Responses use JSON except archive downloads; errors have the shape `{"error":"message"}`. Unknown JSON fields are rejected for normal create/update/login requests; migration accepts extra source fields.

## Endpoints

| Method and path | Request / result |
| --- | --- |
| `POST /api/login` | `{"username":"…","password":"…"}` → `{"authenticated":true}` and a seven-day HttpOnly, SameSite=Strict cookie. |
| `POST /api/logout` | Clears the session cookie; returns `{"ok":true}`. Does not revoke the access token. |
| `GET /api/session` | `{"authenticated":true}` or HTTP 401. |
| `GET /api/stats` | Counts: `links`, `collections`, `pending` (includes processing), `failed`. |
| `GET /api/tags` | Up to 200 `{"name":"go","count":3}` objects, ordered by count descending then name. |
| `GET /api/collections` | Array of collections with `id`, `name`, `parentId` and optional `description`. |
| `POST /api/collections` | `{"name":"Reading","parentId":null,"description":"Optional text"}` → collection, HTTP 201. Description: at most 8 KiB; JSON envelope: 64 KiB. |
| `DELETE /api/collections/{id}` | Moves direct bookmarks to the inbox and makes child collections roots; `{"ok":true}`. |
| `GET /api/links` | Paginated result; filters described below. |
| `POST /api/links` | Bookmark fields below → created record, HTTP 201. |
| `GET /api/links/{id}` | Bookmark record, including captured `content` when available. |
| `PUT /api/links/{id}` | Replaces editable fields → updated record. Send every field you want to retain. |
| `DELETE /api/links/{id}` | Deletes the bookmark and its capture; `{"ok":true}`. |
| `POST /api/links/{id}/capture` | Queues/retries capture; `{"ok":true}`, HTTP 202. A processing record returns 404. |
| `GET /api/links/{id}/archive` | Downloads original HTML as `page.html`; 404 if unavailable. |
| `POST /api/import` | Raw export JSON → `{"imported":12,"skipped":2}`. |
| `GET /api/export` | Downloads `pocketmark-export.json`. |

New and imported links start with `status:"pending"`. The worker advances them through `processing` to `ready` or `failed`. Capture requests still queue work when the worker is disabled; they do not run until capture is enabled. A URL change clears the old capture and queues the new URL. Editing other fields preserves the capture.

## Create and edit bookmarks

```sh
curl --fail-with-body -X POST "$POCKETMARK_URL/api/links" \
  -H "Authorization: Bearer $POCKETMARK_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"url":"https://go.dev/doc/","title":"Go documentation","description":"Language reference","notes":"Read the concurrency section","collectionId":null,"tags":["go","reference"],"favorite":true,"read":false}'
```

Editable fields are `url`, `title`, `description`, `notes`, `collectionId`, `tags`, `favorite`, `read`. `tags` is an array of strings. An empty title defaults to the URL. `collectionId:null` puts a bookmark in the inbox. IDs, timestamps, status, errors and capture fields are server-managed.

`PUT` uses the same body as `POST`; it is not a partial patch. For example, omitting tags clears them, omitting `favorite` makes it false, and omitting `url` rejects the request. Delete and retry requests need no JSON body:

```sh
curl --fail-with-body -X POST -H "Authorization: Bearer $POCKETMARK_ACCESS_TOKEN" "$POCKETMARK_URL/api/links/1/capture"
curl --fail-with-body -H "Authorization: Bearer $POCKETMARK_ACCESS_TOKEN" "$POCKETMARK_URL/api/links/1/archive" --output page.html
```

## Search and filters

```sh
curl --fail-with-body --get "$POCKETMARK_URL/api/links" \
  -H "Authorization: Bearer $POCKETMARK_ACCESS_TOKEN" \
  --data-urlencode 'q=concurrency go' --data-urlencode 'tag=reference' \
  --data-urlencode 'favorite=1' --data-urlencode 'unread=1' --data-urlencode 'page=1'
```

Query parameters combine with AND:

| Parameter | Meaning |
| --- | --- |
| `q` | Space-separated literal prefix terms; case/diacritic insensitive. Searches title, URL, description, notes, tags and captured text. |
| `collection` | Exact collection ID; `0` selects the inbox. Does not include descendant collections automatically. |
| `tag` | Exact tag string. |
| `favorite=1` | Favorites only. |
| `unread=1` | Unread only. |
| `page` | One-based page; omitted or nonpositive values become 1. |

The result is `{"links":[…],"total":123,"page":1,"pageSize":40}`. `sort=newest|oldest|title|title_desc|updated` selects ordering; default is newest. List records omit captured text to keep responses small. `fuzzy=1` enables edit-distance-one matching of metadata terms (plus prefix matches), using bounded row-by-row scanning; it does not fuzzy-scan captured bodies. `url=<exact URL>` performs an exact duplicate lookup and bypasses other filters.

## Import and export

Send the file itself, not multipart form data or a JSON envelope:

```sh
curl --fail-with-body -X POST "$POCKETMARK_URL/api/import" \
  -H "Authorization: Bearer $POCKETMARK_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' --data-binary @backup.json
curl --fail-with-body -H "Authorization: Bearer $POCKETMARK_ACCESS_TOKEN" \
  "$POCKETMARK_URL/api/export" --output pocketmark-export.json
```

Accepted inputs are legacy JSON exports (`collections[].links`, object tags, `parentId`, `pinnedLinks`) and Pocketmark exports (`format:"pocketmark"`, `version:1`, `collections`, top-level `links`). Duplicate URLs and unsupported uploaded-file types are skipped; other invalid records roll back the transaction. Matching collection names under the same parent are reused and IDs remapped. Valid RFC3339 source timestamps are preserved. Captured assets/text and annotations require a full backup rather than metadata JSON. Pocketmark exports preserve notes, read flags, favorites, tags and collection hierarchy; they do not use the compatibility API's exact format.

## Additional personal-library endpoints

| Method and path | Contract |
| --- | --- |
| `PUT /api/collections/{id}` | `{name,parentId,description?}`; rejects self-parenting and cycles. Omitted description is preserved; empty string clears it. Description: 8 KiB; JSON envelope: 64 KiB. |
| `POST /api/links/bulk` | `{ids:[...],action,collectionId,tags,value}`; max 500 IDs. Actions: `delete`, `move`, `tags` (replace), `favorite`, `read`, `capture`. Move uses nullable `collectionId`; flags use boolean `value`. One transaction; errors roll back all changes. |
| `GET /api/links/{id}/annotations` | Annotation array with quote, Unicode offsets, note, color and `stale`. |
| `POST /api/links/{id}/annotations` | `{quote,start,end,note,color}` → `{id}`. Offsets count Unicode code points, not UTF-16 code units. Quote must match the current content. |
| `PUT /api/links/{id}/annotations/{annotationId}` | Same fields; replaces the annotation. |
| `DELETE /api/links/{id}/annotations/{annotationId}` | Deletes one annotation. |
| `POST /api/import/html` | Raw Netscape bookmark HTML, max 8 MiB, transactional nested import. |
| `GET /api/export/html` | Browser bookmark HTML download. |
| `GET /api/links/{id}/assets` | List attachments. |
| `POST /api/files?name=filename&collection=id` | Raw PDF/image/HTML body → `{link,asset}`; optional collection, max 20 MiB. Creates a standalone file atomically, without a website URL. |
| `POST /api/links/{id}/assets?name=filename` | Raw PDF/image/HTML body, max 20 MiB and 32 attachments per bookmark. Content is sniffed. HTML is indexed for reading/search. |
| `GET /api/assets/{assetId}` | Streaming original-byte download, always an attachment with restrictive CSP. |
| `DELETE /api/assets/{assetId}` | Removes attachment chunks atomically. |
| `POST /api/links/{id}/preserve` | Manual resource-embedded passive HTML capture; returns `{asset,embedded,omitted}`. |
| `GET /api/links/{id}/reader?asset=id` | Sandboxed structural reader; optional HTML attachment ID, otherwise captured HTML. Max 2 MiB input, 1 MiB output. |
| `GET /api/backup` | Owner-only ZIP stream with consistent SQLite snapshot and restore instructions. |

Annotation colors: `yellow`, `green`, `blue`, `pink`. Each bookmark supports up to 200 annotations. After content changes, old anchors are reported stale rather than being silently moved. See [archive limits](ARCHIVES.md) for network and resource budgets.

## Account and client keys

`POST /api/login` accepts only `{username,password}`. Token-based browser login is not supported. Named API keys cannot log in as the owner. Password verification is serialized and uses PBKDF2-SHA256 with 600,000 iterations; login attempts are globally limited to ten per minute. Changing credential settings invalidates older cookies; named keys remain individually revocable.

| Endpoint | Contract |
| --- | --- |
| `GET /api/setup` | Public `{setupRequired,passwordEnabled}`; no account name or secret. |
| `POST /api/setup` | Public first-run `{username,password}` → 201 and an owner cookie. Only a new, empty instance can create its single account; later attempts return 409. Same password limits and shared login rate limit. |
| `GET /api/account` | Owner-only `{username,passwordEnabled}`. |
| `PUT /api/account` | Owner-only `{username,password}`. Password 12–1024 bytes, username 1–120 bytes. Empty passwords are rejected; password sign-in cannot be disabled. Issues a replacement owner cookie. |
| `GET /api/tokens` | Owner-only array `{id,name,createdAt,active,lastUsedAt}`; never returns secrets. |
| `POST /api/tokens` | Owner-only `{name}` → `{id,name,createdAt,active,lastUsedAt,token}`; raw key appears once. Max 32 keys. |
| `PATCH /api/tokens/{id}` | Owner-only `{active:boolean}` → `{ok:true}`. Disable temporarily or reactivate the same key; 404 for missing/revoked keys. |
| `DELETE /api/tokens/{id}` | Owner-only permanent, immediate revocation. |

Keys are active on creation. Disabling a key blocks subsequent API and WebDAV authentication without changing its secret; reactivation restores access. In-flight requests may finish. Disabled keys count toward the 32-key limit. `lastUsedAt` is a UTC RFC3339 timestamp recorded on successful credential authentication, even if the requested operation is later rejected. An empty string means no recorded use; activity before this feature was enabled cannot be recovered. Existing keys remain active when upgraded.

The included extension uses bearer authentication with narrowly recognized `chrome-extension://`/`moz-extension://` CORS origins; no credentialed cross-origin cookies are allowed. Ordinary cross-site browser mutations remain rejected. Extension-origin authentication uses dedicated bearer API keys.

### Existing installations and account recovery

Existing credentials and named API keys are preserved. An older installation without a password cannot be claimed through public setup, even if its library is empty. Configure a password before upgrading in Settings, or use the owner-only `PUT /api/account` endpoint with the existing administrative recovery token. The same endpoint allows recovery after a forgotten password. Named API keys cannot perform this operation.

On the server, prepare a private JSON file containing `{"username":"your-name","password":"your-new-password"}` with permissions `0600`, then use:

```sh
curl --fail-with-body -X PUT \
  -H "Authorization: Bearer $POCKETMARK_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @/private/path/account.json "$POCKETMARK_URL/api/account"
```

Use the local server address or HTTPS, delete the private JSON file afterward, and sign in normally with the new credentials. The server's `access-token` file / `POCKETMARK_TOKEN` remains an administrative API recovery credential and session-signing secret; it is never accepted by `/api/login`. Keep it private and preserve it with server backups. Ordinary integrations should use named keys from the signed-in **Settings → API keys** section.

## Compatibility and synchronization

Pocketmark exposes only its native `/api` endpoints and WebDAV. The Linkwarden
compatibility endpoints under `/api/v1/` and `/api/v2/` have been removed. This
also removes third-party Linkwarden extension/mobile access and Floccus's
Linkwarden API backend. Use the Pocketmark Chrome extension or Floccus WebDAV.
Existing bookmarks, collections, tags, notes, annotations and archives are kept.
Legacy compatibility metadata tables remain on disk so no destructive database
migration is needed; they no longer expose an HTTP interface.

WebDAV supports `OPTIONS`, `PROPFIND`, `GET`, `HEAD`, `PUT`, `DELETE` and `MOVE` for the fixed `/dav/` collection and its `bookmarks.xbel`, `bookmarks.xbel.temp` and `bookmarks.xbel.lock` resources. Resource-specific methods are restricted; primary XML deletion is not supported. Authenticate using Basic with any username and a dedicated API key/recovery token as password, or use bearer authentication. Extension-origin Basic authentication is accepted only after normal credential verification. ETag conditional `If-Match` writes and stale locked snapshots return 412; competing lock owners receive 423. Acquire a lock, GET the primary XML, upload the temporary resource, then MOVE it to the same server's primary XML. XML is limited to 8 MiB and persisted as bounded SQLite chunks. Uploads apply an authoritative bookmark tree including deletions and preserve personal fields for retained IDs/URLs. There is no scheduled server synchronizer. See [Floccus instructions](FEATURES.md#floccus-setup-and-data-semantics) and [protocol details](CLIENT_FLOCCUS_NOTES.md).

## Limits and failures

| Limit | Value |
| --- | --- |
| Bookmark create/update JSON | 100 KiB |
| URL | HTTP(S), no embedded credentials, at most 4096 bytes |
| Title / description / notes | 1 KiB / 8 KiB / 64 KiB |
| Tags | At most 32 input entries, each at most 80 bytes after trimming |
| Collection name | 1–120 bytes after trimming |
| Search query | 512 bytes; page must not exceed 1,000,000 |
| Import | 8 MiB, 10,000 links, 2,000 collections; one import at a time |
| Concurrent HTTP requests | Eight; excess requests receive 503 |
| Login attempts | Ten per minute across the instance; excess requests receive 429 |

Common errors: 400 for invalid JSON/limits/duplicate URLs or references, 401 for missing/invalid authentication, 403 for rejected browser origin, 404 for missing records or an already-processing capture, 409 for concurrent imports, 415 for a missing/wrong JSON content type, and 503 when busy. Oversized import bodies currently return 400. For a reverse proxy, set `POCKETMARK_ORIGIN` to the exact public origin; cross-site browser mutations are rejected.

## Tag directory

`GET /api/tags/browse?q=<substring>&page=1` lists all tags currently used by bookmarks, in alphabetical order. Returns `{tags:[{name,count,letter}],groups:[{letter,count}],total,page,pageSize}` with 40 tags per page and global bookmark counts. Groups contain the distinct tag count for each available initial across all matching pages (at most 27 groups). ASCII initials are grouped under A–Z; numbers, symbols and other scripts follow under `#`. Names within a group use SQLite's ASCII case-insensitive order, with exact name as a tie-breaker.

Optional `jump=A` (A–Z, case-insensitive, or URL-encoded `#`) resolves the page containing the first matching tag under that initial; the response's `page` reports the resolved page. If that initial has no matches, the requested page is retained. Search is a literal substring (ASCII case-insensitive); `%` and `_` have no wildcard meaning. `q` is limited to 512 bytes and page to 1–1,000,000; invalid values return 400. Authentication is required. The existing `/api/tags` array remains limited to the 200 most-used tags; the web sidebar shows the first 12 as frequent-tag shortcuts.
