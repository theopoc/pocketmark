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
session. The documentation and specification are public static
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

Base URL: `http://127.0.0.1:8090`. API endpoints require an owner session or named API key unless explicitly public. First-run setup and login are public. `/healthz` is unauthenticated and returns `{"status":"ok"}` when SQLite is reachable. Named keys cannot access account/key/session management or full backups. Their profile also restricts library and WebDAV access; see Security controls below.

`GET /metrics` exposes Prometheus text metrics using the same session/bearer
authentication. Responses include a server-generated `X-Request-ID` for log
correlation. See [observability](OBSERVABILITY.md) for metrics, JSON log fields and
optional OpenTelemetry tracing; `/metrics` is operational and outside the native
JSON API specification.

Create a dedicated API key in **Settings → API keys** and keep it private. Set `POCKETMARK_ACCESS_TOKEN` from a secure source before running the examples:

```sh
POCKETMARK_URL=http://127.0.0.1:8090
curl --fail-with-body -H "Authorization: Bearer $POCKETMARK_ACCESS_TOKEN" "$POCKETMARK_URL/api/stats"
```

JSON mutation requests use `Content-Type: application/json`. Responses use JSON except archive downloads; errors have the shape `{"error":"message"}`. Unknown JSON fields are rejected for normal create/update/login requests; migration accepts extra source fields.

## Endpoints

| Method and path | Request / result |
| --- | --- |
| `POST /api/login` | `{"username":"…","password":"…"}` → a five-minute MFA challenge; verify the second factor before a browser session is issued. |
| `POST /api/logout` | Revokes the current session in SQLite (including after restart) and clears its cookie; returns `{"ok":true}`. Does not revoke the access token. |
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

The result is `{"links":[…],"total":123,"page":1,"pageSize":40}`. `sort=newest|oldest|title|title_desc|updated` selects ordering; default is newest. List records omit captured text to keep responses small. `fuzzy=1` adds edit-distance-one matches of metadata terms (plus prefix matches) to full-text results, using bounded row-by-row scanning. The web UI sends it automatically for searches; it does not fuzzy-scan captured bodies. `url=<exact URL>` performs an exact duplicate lookup and bypasses other filters.

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
| `GET /api/assets/{assetId}/view` | Authenticated inline image/PDF preview or HTML payload for the UI’s nested sandboxed blob viewer. Direct HTML navigation downloads (attachment disposition); fetch still returns the preview bytes. Preparation shares the archive work slot (409 if busy); 422 if HTML cannot be prepared. Original downloads are unchanged. |
| `DELETE /api/assets/{assetId}` | Removes attachment chunks atomically. |
| `POST /api/links/{id}/preserve` | Manual resource-embedded passive HTML capture; returns `{asset,embedded,omitted}`. |
| `GET /api/links/{id}/reader?asset=id` | Sandboxed structural reader; optional HTML attachment ID, otherwise captured HTML. Max 2 MiB input, 1 MiB output. |
| `GET /api/backup` | Owner-only ZIP stream with consistent SQLite snapshot and restore instructions. Five-minute overall deadline and renewable 30-second network-write deadline. |

Annotation colors: `yellow`, `green`, `blue`, `pink`. Each bookmark supports up to 200 annotations. After content changes, old anchors are reported stale rather than being silently moved. See [archive limits](ARCHIVES.md) for network and resource budgets.

## Account and client keys

`POST /api/login` accepts only `{username,password}` and creates a short-lived challenge, not a browser session. TOTP or a single-use recovery code is required to finish signing in. Named API keys cannot log in as the owner. Password verification is serialized and uses PBKDF2-SHA256 with 600,000 iterations; validly formed login attempts are limited to ten per minute per client address (IPv6 /64). At most 256 source windows are tracked; additional sources receive 429 until a window expires. MFA verification permits five attempts per challenge per minute and ten attempts account-wide per minute, with at most 32 pending challenges. Busy password derivations return 429 with `Retry-After: 1` instead of queuing. Challenges expire after five minutes and do not survive restart. Existing browser sessions are revoked during the MFA migration; password-only cookies issued by an older version are also rejected after an upgrade. Accounts, libraries and API keys are preserved. Sessions are random and only their keyed hashes and expiry are persisted. At most 32 sessions remain active; the oldest is evicted when another is issued.

| Endpoint | Contract |
| --- | --- |
| `GET /api/setup` | Public `{setupRequired,passwordEnabled}`; no account name or secret. |
| `POST /api/setup` | First-run `{username,password}` → 201 and a temporary MFA challenge. Only a new, empty instance can create its single account; later attempts return 409. Restrict access until setup is complete. |
| `POST /api/mfa/enroll` | With a pending enrollment challenge, submit `{}` and receive a locally generated `{secret,qr}`. |
| `POST /api/mfa/verify` | With a pending challenge, submit `{code}`. A valid TOTP or recovery code creates the browser session; initial enrollment confirms TOTP and returns ten recovery codes once. |
| `POST /api/mfa/replace` | Browser session plus `{password,code}` starts replacement. A recent recovery-code login can use its one-time grant with an empty code; confirming the new TOTP revokes other sessions and replaces recovery codes. |
| `POST /api/mfa/recovery-codes` | Browser session plus `{password,code}` replaces all recovery codes; the new codes are returned once. |
| `GET /api/account` | Owner-only `{username,passwordEnabled}`. |
| `PUT /api/account` | Owner-only `{username,password}`. Password 12–1024 bytes, username 1–120 bytes. Empty passwords are rejected; password sign-in cannot be disabled. The browser session receives a replacement cookie. |
| `GET /api/tokens` | Owner-only array `{id,name,createdAt,active,lastUsedAt,profile,expiresAt}`; never returns secrets. |
| `POST /api/tokens` | Owner-only `{name,profile?,expiresAt?}` → `{id,name,createdAt,active,lastUsedAt,profile,expiresAt,token}`; raw key appears once. Max 32 keys. |
| `PATCH /api/tokens/{id}` | Owner-only `{name?:string,active?:boolean}` → `{ok:true}`. Supply name, active or both. Rename (1–120 UTF-8 bytes after trimming), disable temporarily or reactivate the same key; 404 for missing/deleted keys. Renaming preserves the secret, status and usage history unless active is explicitly supplied. |
| `DELETE /api/tokens/{id}` | Owner-only permanent, immediate revocation. |

Keys are active on creation. Disabling a key blocks subsequent API and WebDAV authentication without changing its secret; reactivation restores access. In-flight requests may finish. Disabled keys count toward the 32-key limit. `lastUsedAt` is a UTC RFC3339 timestamp recorded on successful credential authentication, even if the requested operation is later rejected. An empty string means no recorded use; activity before this feature was enabled cannot be recovered. Existing keys remain active when upgraded.

The included extension uses bearer authentication with narrowly recognized `chrome-extension://`/`moz-extension://` CORS origins; no credentialed cross-origin cookies are allowed. Ordinary cross-site browser mutations remain rejected. Extension-origin authentication uses dedicated bearer API keys.

### Existing installations and account recovery

Existing credentials, TOTP factors, MFA-verified sessions and named API keys are preserved. The old administrative bearer is no longer accepted; replace it with a named API key in every integration before upgrading to avoid interruption. The old `access-token` file or `POCKETMARK_TOKEN` remains the server secret for existing installations. New installations automatically generate `server-secret` with mode `0600`.

An older library without a password cannot be claimed through public setup. Stop the server and provide a private JSON file with `{"username":"your-name","password":"your-new-password"}` via standard input:

```sh
./pocketmark -data /path/to/data -reset-account < /private/path/account.json
```

Delete the private file afterward. This preserves an existing authenticator and revokes sessions. To recover after losing both the authenticator and recovery codes, stop the server and run:

```sh
./pocketmark -data /path/to/data -reset-mfa
```

This clears the factor and recovery codes and revokes sessions. Sign in using the password and enroll again. For the supplied Docker Compose configuration, use the same data volume:

```sh
docker compose stop pocketmark
docker compose run --rm --no-deps pocketmark -reset-mfa
docker compose start pocketmark
```

Back up the server secret separately from the database. If it is missing for an existing database, startup fails rather than silently invalidating MFA. Restore the original secret, or explicitly use `-reset-mfa` to generate a replacement and enroll again. Native ZIP restores invalidate recovery codes and may require the local reset when the authenticator is unavailable. TOTP codes are accepted once within the clock window; recovery codes are random, hashed and single-use. QR codes are generated locally.

Restoring a new native ZIP also blocks the current TOTP window to prevent replay of a code used after the snapshot. Wait for up to two new authenticator codes before signing in; clock differences can add delay. Older ZIPs and raw copies cannot be identified automatically and may restore earlier TOTP counters.

The `pquerna/otp` package and its QR encoder run within the existing Go process. QR generation is limited to a 220 × 220 image during enrollment, and authentication work slots bound concurrency; no resident process, cache or index is added. Their memory impact has not been separately benchmarked.

## Compatibility and synchronization

Pocketmark exposes only its native `/api` endpoints and WebDAV. The Linkwarden
compatibility endpoints under `/api/v1/` and `/api/v2/` have been removed. This
also removes third-party Linkwarden extension/mobile access and Floccus's
Linkwarden API backend. Use the Pocketmark Chrome extension or Floccus WebDAV.
Existing bookmarks, collections, tags, notes, annotations and archives are kept.
Legacy compatibility metadata tables remain on disk so no destructive database
migration is needed; they no longer expose an HTTP interface.

WebDAV supports `OPTIONS`, `PROPFIND`, `GET`, `HEAD`, `PUT`, `DELETE` and `MOVE` for the fixed `/dav/` collection and its `bookmarks.xbel`, `bookmarks.xbel.temp` and `bookmarks.xbel.lock` resources. Resource-specific methods are restricted; primary XML deletion is not supported. Authenticate using Basic with any username and a dedicated API key as password, or use bearer authentication. Extension-origin Basic authentication is accepted only after normal credential verification. ETag conditional `If-Match` writes and stale locked snapshots return 412; competing lock owners receive 423. Acquire a lock, GET the primary XML, upload the temporary resource, then MOVE it to the same server's primary XML. XML is limited to 8 MiB and persisted as bounded SQLite chunks. Uploads apply an authoritative bookmark tree including deletions and preserve personal fields for retained IDs/URLs. There is no scheduled server synchronizer. See [Floccus instructions](FEATURES.md#floccus-setup-and-data-semantics) and [protocol details](CLIENT_FLOCCUS_NOTES.md).

## Limits and failures

| Limit | Value |
| --- | --- |
| Bookmark create/update JSON | 100 KiB |
| URL | HTTP(S), no embedded credentials, at most 4096 bytes |
| Title / description / notes | 1 KiB / 8 KiB / 64 KiB |
| Tags | At most 32 input entries, each at most 80 bytes after trimming |
| Collection name | 1–120 bytes after trimming |
| Search query | 512 bytes; page must not exceed 1,000,000 |
| Import | 8 MiB, 10,000 links, 2,000 collections; one import at a time. JSON also allows 10,000 pinned links, 32 tags per record and 64 nesting levels; counts include repeated fields and are checked before typed allocation. JSON/HTML receive to disk before any write transaction |
| Concurrent HTTP requests | Eight general request slots; separate authentication and health slots; excess requests receive 503 |
| HTTP request rate | Per client IP: 10 requests/second with a 100-request burst; excess requests receive 429 |
| Login attempts | Ten per minute per client address (IPv6 /64), up to 256 tracked windows; excess requests receive 429 |

Common errors: 400 for invalid JSON/limits/duplicate URLs or references, 401 for missing/invalid authentication, 403 for rejected browser origin, 404 for missing records or an already-processing capture, 409 for concurrent imports, 415 for a missing/wrong JSON content type, 429 for rate limits, and 503 when busy. Oversized import bodies currently return 400. For a reverse proxy, set `POCKETMARK_ORIGIN` to the exact public origin; cross-site browser mutations are rejected.

### HTTP rate limiting

Rate limiting is enabled by default for all HTTP traffic, including static files,
unknown routes, WebDAV, setup, login, invalid credentials and CORS preflight. It
runs before authentication, request-body reads and work-slot acquisition. A token
bucket per client IP allows a burst of 100 requests and replenishes 10 tokens per
second. Successful authentication does not bypass or reset the quota. IPv4-mapped
addresses share their IPv4 quota; IPv6 addresses share a /64 quota.

Set `POCKETMARK_RATE_LIMIT` to an integer from 1 to 1000 (requests per second), and
`POCKETMARK_RATE_BURST` to an integer from 1 to 10000 (bucket capacity). Defaults are
10 and 100. Invalid values, including zero, prevent startup. The limits cover the
combined traffic of clients sharing an IP, so allow room for browser assets and
extension/WebDAV requests when tuning them. Existing protocol and client evidence
does not qualify these limits under every client workload.

Excess requests receive JSON HTTP 429 with `Cache-Control: no-store` and an integer
`Retry-After` in seconds, rounded up until another token is available. Extension
CORS responses expose `Retry-After`. Clients should wait before retrying; failed
requests are not queued. The stricter login limit and concurrency limits still
apply independently.

Each process tracks at most 256 source buckets. New sources receive 429 at capacity;
active buckets are never evicted to admit rotating addresses. Inactive buckets
can be reclaimed after the greater of one minute and the time needed to refill
their whole bucket. Unknown peer addresses share one bucket. State stays in bounded
memory, requires no additional dependency or worker, and resets on process restart.

`GET`/`HEAD /healthz` and `/livez` are exempt so exhausted quotas cannot cause probe
failures. Other methods on those paths still consume quota. Readiness retains its
independent concurrency and database timeout limits. The application limit does
not bound incoming connections or provide distributed/volumetric DDoS protection;
keep ingress connection/rate limits in front of an Internet-facing instance.

## Tag directory

`GET /api/tags/browse?q=<substring>&page=1` lists all tags currently used by bookmarks, in alphabetical order. Returns `{tags:[{name,count,letter}],groups:[{letter,count}],total,page,pageSize}` with 40 tags per page and global bookmark counts. Groups contain the distinct tag count for each available initial across all matching pages (at most 27 groups). ASCII initials are grouped under A–Z; numbers, symbols and other scripts follow under `#`. Names within a group use SQLite's ASCII case-insensitive order, with exact name as a tie-breaker.

Optional `jump=A` (A–Z, case-insensitive, or URL-encoded `#`) resolves the page containing the first matching tag under that initial; the response's `page` reports the resolved page. If that initial has no matches, the requested page is retained. Search is a literal substring (ASCII case-insensitive); `%` and `_` have no wildcard meaning. `q` is limited to 512 bytes and page to 1–1,000,000; invalid values return 400. Authentication is required. The existing `/api/tags` array remains limited to the 200 most-used tags; the web sidebar shows the first 12 as frequent-tag shortcuts.

### Public HTTPS deployment

Set `POCKETMARK_ORIGIN` to the exact HTTPS origin. Complete first-run setup before exposing the instance to untrusted networks: anyone who can reach an eligible empty instance can create its owner account.

Behind an Ingress, set `POCKETMARK_TRUSTED_PROXIES` to a comma-separated list of **only the actual proxy CIDRs**. The immediate peer must be trusted before `X-Forwarded-For` is used; the chain is read from right to left to find the first untrusted address. Untrusted peers cannot spoof their limit through forwarding headers. Configure the proxy to overwrite or append the actual source address and restrict direct access to the application. Without this setting, clients behind the same proxy share its limit. Do not trust every address or the whole cluster unless every workload in that range is trusted.

Public `/api/login`, `/api/setup` and MFA challenge endpoints use two separate request slots; their POST bodies have a five-second read deadline. Library requests retain eight slots. `/healthz` uses two independent slots and a one-second SQLite context timeout: use it for readiness. `/livez` has no database dependency and is independent of these slots: use it for liveness. Ingress connection/rate limits are still needed for distributed traffic floods.

## Security controls

The local [OpenAPI reference](/api-docs/) and bundled `openapi.json` describe every
native endpoint, metrics, and WebDAV. The specification records allowed key profiles
with `x-api-key-profiles`, owner restrictions with `x-owner-only`, and password
confirmation with `x-reauthentication-required`. WebDAV PROPFIND/MOVE are documented
with `x-webdav-methods` because OpenAPI 3.0 does not define these operation names.

All library, archive, upload, import, export, metrics, account and session endpoints
require authentication, including GET and HEAD. Only setup/login, minimal health
probes and static UI/documentation are public. MFA enrollment and verification require a short-lived password-stage challenge. Setup requires an eligible empty database and is available to anyone able to reach it. Extension CORS OPTIONS
preflight is public but grants no data access or mutation. Other DAV OPTIONS requests
are authenticated. Invalid Authorization never falls back to a valid cookie.

### Password confirmation

Browser sessions require password confirmation within the last **five minutes**
for password changes, creating/updating/deleting/rotating API keys, downloading a
full backup, changing inactivity timeout, and revoking sessions through the session
management endpoints. Fresh password login/setup counts as confirmation. Expiry
returns HTTP 403 with `{"error":"Confirm your password to continue.","code":"reauth_required"}`
before the handler runs. Call `POST /api/reauth` with `{password}` using the same
browser session, then retry. Incorrect passwords return 403; expired/revoked sessions
return 401. Confirmation shares the login attempt limiter and bounded serialized
password work; busy/throttled requests return 429 with Retry-After. A confirmation
is tied to one session and cannot revive a revoked session or old account credentials.

Normal logout remains possible without
password confirmation. The UI prompts only when needed and clears the entered
password when the confirmation dialog closes. Backup navigation always confirms
first and streams the download normally, without buffering the ZIP in the UI.

### API key profiles and lifetime

| Profile | Allowed operations |
| --- | --- |
| `read` (new API default) | Native library reads, metadata exports, saved-file downloads/previews, reader and metrics; no library writes or DAV. |
| `capture` | Session check, stats, tags, collections and bookmark reads; bookmark creation/update, collection creation, capture/preservation and attachment/standalone-file upload. No deletes, bulk edits, imports, exports, saved-file download or DAV. For Pocketmark's browser extension. Bookmark reads can include notes and extracted text. |
| `sync` | WebDAV including authoritative updates/deletions, plus `GET /api/session`. No native library reads/writes, file downloads or metrics. For Floccus. |
| `full` | All native library operations, metrics and WebDAV; no owner administration or full backups. |

Every named key is refused on account/key/session administration and full backup.
New routes require an explicit profile policy; unknown routes do not inherit key
permissions. The server tests compare the route inventory, authorization policy and
OpenAPI and exercise anonymous denials and the profile matrix.

`POST /api/tokens` accepts `{name,profile?,expiresAt?}`. `expiresAt` is a future Unix
timestamp in seconds, or 0 (default) for no expiry. The UI defaults to read-only and
30 days. Existing keys migrate to `full` without expiry, preserving integrations;
review and replace them with a narrower profile. Permissions and expiry are immutable:
create a replacement key when changing them. Expired keys remain listed but cannot
authenticate or be rotated; reactivation does not extend expiry. Disabled/expired
keys still count toward the 32-key limit.

`POST /api/tokens/{id}/rotate` atomically replaces an active unexpired key and returns
`{token}` once. Its ID/name/profile/expiry remain, last-use history resets, and the
previous secret immediately stops authenticating. Update the connected client.
In-flight requests may finish after rotation, expiry or revocation. No raw key is
stored or returned by listing; no session secret is exposed.

### Browser sessions

| Endpoint | Behavior |
| --- | --- |
| `GET /api/sessions` | Owner-only list of at most 32 unexpired sessions: `{id,createdAt,lastUsedAt,expiresAt,idleTimeoutMinutes,device,current}`. Times are Unix seconds; legacy creation/activity may be 0. Device is an untrusted User-Agent truncated to 256 bytes, never a verified identity; no IP is stored. |
| `PATCH /api/sessions/current` | Cookie session and recent confirmation required; `{idleTimeoutMinutes: 0|15|60|1440}`. Applies only to this browser. |
| `DELETE /api/sessions/{id}` | Owner and recent confirmation; revoke a session by its numeric ID. 404 if missing. Revocation persists across restart. |
| `DELETE /api/sessions/others` | Cookie session and recent confirmation; revoke all sessions except the current one. |

New sessions have a 24-hour inactivity timeout and a seven-day absolute expiry.
Every authenticated request counts as activity, including background refresh from
an open library. Server-side conditional updates cannot revive an expired session.
Choosing 0 disables only inactivity expiry. Legacy sessions retain their original
absolute expiry and require fresh confirmation before sensitive actions. Password
changes revoke all previous sessions, and backups continue to omit browser sessions.

### Cached card image

`GET /api/links/{id}/thumbnail` returns the optional cached JPEG/PNG (at most
512 KiB), or 404 when absent. It requires library read access (`read`, `capture`
or `full` keys, or the owner session). Responses use `Cache-Control: private,
no-cache` and ETag revalidation (304). Link-list records include
`hasThumbnail:true` only when an image is cached. No original image URL or image
bytes are included in the list response. See [archive boundaries](ARCHIVES.md)
for capture, invalidation and image limits.
