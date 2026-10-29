# Real client validation

> Current scope: Pocketmark's own Chrome extension and Floccus WebDAV. The
> Linkwarden API compatibility layer, third-party extension/mobile support and
> Floccus Linkwarden API backend have been removed. The older dated observations
> remain historical evidence; the new worker is qualified separately below.

## Extension collection and tag check — 29 October 2026

Chrome for Testing 156.0.8078.4 loaded a disposable copy of the extension and
its actual MV3 worker against an isolated Pocketmark server and database. In a
320 px viewport, collection creation and selection, the collection-name hint,
and manual tag addition worked without horizontal page overflow. The test used
a normal extension page rather than the native action popup, pre-granted the
loopback host permission in the copied manifest, and simulated active-tab
selection. It does not test the browser's permission prompt, native popup sizing,
physical devices, or other browsers. Credentials and the profile were disposable.

## Extension popup UI/UX — 22 October 2026

The popup keeps Pocketmark's existing dark/indigo workspace language. Connection
setup, bookmark editing and pending work have separate views. Optional captures
are disclosed on demand; primary save/connect/recovery actions remain in a fixed
footer while content scrolls. Completed saves collapse into a summary. Repeated
background polls preserve disclosure state and keyboard focus.

Disposable Chrome for Testing 149.0.7827.55 observations:

- The actual action popup opened at 400 px wide and adapted to the native
  available height (498 px in the test window); its footer remained within the
  viewport. This caught and corrected an intrinsic-sizing issue that did not
  reproduce when the same document was opened in a normal tab.
- A separate UI harness with mocked Chrome/library responses checked 48 layout
  combinations: 200/320/360/400 px wide, 260/400/600 px high, with connection,
  normal editor, long tags/nested collections and partial-upload recovery states.
  No horizontal document/content overflow or clipped footer was observed.
- Keyboard checks covered Enter submission from the title/connection fields,
  tag creation/removal and Escape/cancel focus recovery for a new collection.
  Switching to Connection and back retained an unfinished title and selected
  formats. Unchanged polling preserved a collapsed task and focused summary.
- The real-extension/native-server capture scenario below passed again with
  the updated UI: all four formats, popup closure, partial upload failure,
  source-tab closure, full browser restart, manual retry and metadata retention.

These are Chromium desktop and emulated viewport checks, not physical mobile or
other-browser qualification. Runtime permission origins were pre-granted only
in the disposable real-extension fixture as described below. No personal profile
or database was used. The Impeccable engine was unavailable; refinement followed
PRODUCT.md, DESIGN.md and the skill's adapt/polish/craft references directly.

Screenshots: [editor](pocketmark-extension.png),
[connection](pocketmark-extension-connect.png),
[manual retry](pocketmark-extension-retry.png).

## Personal native Chrome extension — 21 October 2026

A disposable Chrome for Testing 149.0.7827.55 profile exercised the new popup,
MV3 worker and real IndexedDB against an isolated native Pocketmark executable
and a synthetic JavaScript-rendered article. No personal database/profile was
used. The automated test copy pre-granted only its two loopback origins to
represent an already authorized connection and tab; production permission-dialog
interruption/recovery is covered by deterministic popup regressions, not this run.

Observed successfully:

- Creation/selection of a collection, creation of a tag and one bookmark.
- Cumulative rendered HTML, visible PNG, full-page PNG and PDF capture. HTML
  contained the marker inserted by page JavaScript.
- Closing the popup immediately after starting the task did not cancel work.
- A synthetic HTTP 503 rejected only the PDF upload; the bookmark and three
  successful attachments remained. The PDF was retained in local IndexedDB.
- Closing the source tab, fully closing Chrome, reopening the same disposable
  profile and manually retrying sent the retained PDF without recapturing it.
  All four attachments then remained on the bookmark.
- Reopening the extension loaded the same exact-URL bookmark. Editing its title
  and tags kept its collection, notes, description, favorite flag and attachments;
  the native exact-URL query still returned exactly one bookmark.

[Current popup with synthetic content](pocketmark-extension.png).
The screenshot is the 390 px-wide extension body; tall popups scroll in Chrome.
Deterministic extension tests additionally cover interrupted workers, failed
acquisition, raster/PDF limits, response-loss reconciliation, connection recovery,
validation and preventing a pending task from being sent to a different server.

## Historical client observations

19–20 October 2026 (Europe/Paris), macOS ARM64, Google Chrome 155.0.8059.80. Tests use an explicitly authorized temporary Chrome profile, an isolated Pocketmark database, synthetic pages and dedicated credentials. Personal browser data is not involved.

## Executed clients

| Client | Artifact | Runtime result |
| --- | --- | --- |
| Pocketmark Advanced | Local package, 1.0.0 | PDF, full-page PNG and rendered HTML uploaded successfully; two bugs corrected and retested |
| Third-party extension | Unmodified Chrome Web Store package, 1.5.6 | Password login, collection selection, tags, description, screenshot upload and existing-link detection passed |
| Official Floccus | Unmodified Chromium release, 5.11.1 | Native API and WebDAV backends passed the workflows below, including restart |
| Third-party Android app | Unmodified official APK, 1.4.4 | Password login, dashboard, bookmark/tag/collection edits, search and archive views passed in an ARM64 emulator; offline limitation documented below |

Floccus artifact provenance is recorded in [Floccus notes](CLIENT_FLOCCUS_NOTES.md). All client tests used unmodified packages.

## Advanced capture

The fixture is served by `scripts/real_clients_fixture.py`. JavaScript adds five long sections and two unique markers after initial HTML parsing. Captures were initiated through the actual extension popup.

- PDF: 75,143 bytes, six pages. Text extraction finds both `rendered-client-fixture-2026` and `full-page-capture-complete`.
- Rendered HTML: 1,394 bytes; both markers present, script elements absent.
- Initial full-page PNG: 2,400 × 8,088 pixels. This exposed a Retina bug: the CSS-dimension budget ignored device pixel density and exceeded 16 million physical pixels.
- Corrected PNG: **2,178 × 7,341 = 15,988,698 pixels**, 316,982 bytes. The calculation now includes device pixel density and integer rounding, plus the existing per-axis limit.
- First-time host permission approval closed the popup before connection settings were saved. The extension now persists a pending connection before opening the permission prompt and validates authentication on reopening before activating it. A new `localhost` permission grant reproduced the popup closure and recovered automatically without re-entering credentials.
- Sixteen extension tests pass, including permission interruption, invalid/denied connection recovery, PDF streaming cleanup and Retina limits. Automated tests complement the runtime checks.

Evidence: [capture completed](real-advanced-capture.png), [connection recovered](real-advanced-reconnect.png).

## Third-party extension

The unmodified extension sent real requests through a local logging proxy. Password authentication returned a session token; collection/config/tag reads succeeded. Saving a synthetic page created its name, description and `real-client` tag, followed by a 577,724-byte PNG through `/api/v1/archives/2?format=0`. Reopening displayed “You've already saved this link”.

This qualifies only the exercised extension workflows.

## Floccus native API backend

For native API synchronization, use the Pocketmark origin, any descriptive username and a dedicated API key as the access token. The tested server collection is `Floccus real native`; the local folder belongs only to the temporary Chrome profile. Automatic synchronization was disabled for controlled manual tests.

Passed through the real Floccus UI:

1. Initial synchronization creates the server collection.
2. A server-created bookmark appears in Chrome.
3. Renaming it in Chrome updates the server while retaining its description, notes and tags.
4. A browser-created nested folder and bookmark create the corresponding collection hierarchy and link on the server.
5. Moving that link and changing its URL/title on the server updates Chrome.
6. Deleting the disposable server link removes it from Chrome; the other bookmark and folder remain.

Evidence: Floccus synchronization state (screenshot omitted), [remaining Chrome bookmarks](real-floccus-bookmarks.png).

## Floccus WebDAV

The actual setup wizard initially failed on `PROPFIND /dav/` with HTTP 403 using Basic API-key authentication. [Failure evidence](real-floccus-dav-before.png). The corrected adapter accepts authenticated extension-origin DAV requests and implements lock files, staged uploads, atomic MOVE, numeric IDs, allocation watermark, sibling order and exact uploaded byte lengths.

Retesting the unmodified Floccus extension against the final Docker image passed:

1. Discovery and initial library download into the temporary profile's bookmarks bar.
2. Browser rename through the actual `GET lock → PUT lock → GET XML → PUT temp → PROPFIND temp → MOVE → PROPFIND final → DELETE lock` sequence. Description, tag and both attachments survived despite the client's reduced XML format.
3. Native title/note changes invalidate the saved XML and reach Chrome on the next synchronization.
4. A new Chrome bookmark receives the next numeric ID and reaches Pocketmark; server deletion subsequently removes it from Chrome.
5. Chrome's changed bookmark order reaches the XML and survives native edits. The highest allocated ID remains 6 after deleting that bookmark.
6. Docker restart preserves exact XML bytes, all five captured assets and personal metadata. Both Floccus backends synchronize successfully afterward.

The review also found and fixed allocator-watermark loss and stale writes following lease expiration. Three independent regression probes and the integrated tests passed. Final Floccus state (screenshot omitted), [restart/hash evidence](real-client-restart.json). Raw HTTP traces are retained locally and excluded from Git.

## Final build and memory

Final image: `pocketmark:clients` / `pocketmark:local`, SHA-256 `4f2ceb38f842edd6ed5e1e3c6b159601bb6e07bb0ed7cf51c34b5be2cfc93b60`. The macOS binary and both extension packages were rebuilt. The existing synthetic demo on port 18091 was refreshed without resetting its library.

The full Go race suite, `go vet`, UI syntax check and 16 extension tests passed. Disk pressure initially interrupted parallel race compilation; using `CGO_CFLAGS='-O2 -g0'` and sequential package builds resolved it, followed by a successful full `go test -race -p 1` run.

The final 128 MiB Docker workload passed six public captures, 200 requests, a 19 MiB upload/download, staged Floccus DAV, full backup and restart. Idle RSS: **10.47 MiB**; process peak: **22.93 MiB**; whole-container peak including cache: **84.04 MiB**; zero memory-limit/OOM events. See [raw measurements](benchmark-clients.json) and [measurement boundaries](BENCHMARK.md).

## Scope and reproduction

Run a separate Pocketmark instance on port 18092 with a temporary database and synthetic credentials. Run `python3 scripts/real_clients_fixture.py` to serve the fixture on 18093 and log API requests through 18094. Load the packages into a temporary Chrome profile, configure their server to `http://127.0.0.1:18094`, and repeat the workflows above. The proxy logs methods, paths, statuses and JSON field names, never credentials or request values. It is test infrastructure and excluded from production memory measurements.

Loopback bookmarks deliberately fail **server-side** capture because of SSRF protection; the tested browser captures succeed without weakening that protection. Browser rendering memory is separate from the Go server's RAM budget. iOS, physical mobile devices, Firefox and Safari have not been runtime-qualified. No production deployment or universal client compatibility is claimed.

After validation, the temporary Chrome profile, downloaded test clients, synthetic credentials, logging fixture, Docker test container and its volume were removed. The refreshed demo on port 18091 remains available; evidence is retained in this repository.

## Official Android application — 20 October 2026

The actual release APK, the third-party Android client (1.4.4), was installed without modification into a disposable AOSP Android 11/API 30 ARM64 emulator. Native UI actions operated the application, not a rebuilt client or an HTTP-only imitation. No physical phone or personal browser profile was used. The emulator used a private SDK/AVD and ADB port, with a synthetic Pocketmark account and separate database. Its server address was `http://10.0.2.2:18094`, forwarding to the isolated instance on port 18092. This cleartext address was restricted to the local test environment; normal remote use needs HTTPS.

The tested Android APK was version 1.4.4, 142,604,910 bytes, SHA-256 `94171eef0975f2d650119ac2baf0dadcd3113892a320e03713d2c36e9bbe473c`. This run does not qualify iOS.

### Exercised workflows

| Actual application workflow | Observed result |
| --- | --- |
| Configure self-hosted server and password sign-in | Config, login methods, session and users/me return 200; dashboard loads. The session survives a full emulator restart. |
| Create a URL-only bookmark | The app creates the `example.com` test bookmark; server capture fills its title and text. |
| Edit and pin a bookmark | Edited title appears in Recent and Pinned; description and existing tag remain. |
| Create a tag, open its detail page and filter links | Corrected requests return 200; tag name, counts and dates render correctly. |
| Create a collection with a description | Description is stored and displayed in the collection list after the correction. |
| Move a bookmark and select a second tag | Collection and both tag identities persist; existing description, preview and PDF remain. |
| Search for the edited title | Only the matching bookmark appears; the app sends the expected search query. |
| Change banner using Android's PNG picker | Corrected upload and preview download return 200; the actual PNG appears in lists/dashboard. |
| Open Readable, PDF and Webpage archives | Article text, the synthetic one-page PDF and captured HTML render in the app. Default HTML capture omits external styling by design. |
| Enable Save for offline access | The client downloads archives and reports “Up to date”, 60.2 KB. Immediate reopening of the reader with Wi-Fi disabled succeeds. A later-cache limitation is described below. |
| Restart Pocketmark | Collection/tag/link JSON, PDF bytes and PNG preview bytes are identical before and after restart. |

Evidence: [banner](mobile-banner-after.png), [tag detail](mobile-tag-detail.png), [collection description](mobile-collection-after.png), [search and moved bookmark](mobile-search-after.png), [reader](mobile-reader.png), PDF (screenshot omitted), [HTML](mobile-html.png), offline synchronization (screenshot omitted), [immediate offline reader](mobile-offline-immediate.png). Local HTTP traces contain methods, paths, statuses and JSON field names only and are excluded from Git. [Restart hashes](mobile-restart.json) record byte-for-byte comparisons.

### Server defects corrected and retested

1. Tag creation used the mobile `{tags:[{label,value?}]}` batch shape, while the server accepted only `{name}`: HTTP 400. The adapter now validates bounded batches before writing, retains existing identities and returns the expected array. The legacy request still works.
2. The advertised API level makes the app request `GET /api/v1/tags/{id}`; this returned 501. Tag detail now includes name, count and persisted creation date, with 404 for unknown IDs.
3. Collections and tags lacked `createdAt`, displaying “Invalid Date”. SQLite insert triggers now retain stable creation dates across native/API/import/DAV writes and restarts. Old rows receive a persisted first-upgrade date once; their original dates were never stored and cannot be recovered.
4. A mobile banner was confused with the preserved image archive. Previews now have a separate asset kind and availability field, preserving archived images. Terminal records without a preview use the client's `unavailable` sentinel instead of spinning forever; pending captures remain pending.
5. Android's picker can send real PNG bytes while declaring JPEG/format 1: HTTP 415. Preview uploads now sniff PNG/JPEG bytes and serve their actual MIME type without decoding or re-encoding. Normal archive formats remain strict, and non-image previews are rejected. [Failure before correction](mobile-banner-before.png).
6. Collection creation accepted the description but discarded it. An optional bounded SQLite field now round-trips through mobile/native APIs and JSON migration. Rename/move requests that omit it preserve it; an explicit empty string clears it. Native request envelopes allow JSON escaping of the full 8 KiB field.

These changes retain one Go process and SQLite. They add no resident renderer, image decoder or synchronization worker. The complete Go race suite, `go vet`, UI syntax check and all 16 extension tests pass. Native executable SHA-256: `de0547eb55bb7afedad7554f3db3d9ea443ea656467994e3f0b93412d1750654`. The final Docker workload is recorded in [benchmark-mobile.json](benchmark-mobile.json): 10.52 MiB idle RSS, 23.59 MiB process peak, 95.37 MiB whole-container peak, zero limit/OOM events. Image `pocketmark:mobile` / `pocketmark:local` has SHA-256 `ad750f95840315d7ed7bbe059abb90f8b4d4d8ea7a1f93e134bdc6ae3600af76`. The existing demo on port 18091 was restarted with the corrected native executable and its original library; health, capture status and migrated collection dates passed. The isolated mobile server and logging proxy were then stopped.

### Remaining client limitation: offline metadata eviction

With Wi-Fi disabled after the app had been inactive on a different screen for several minutes, the library lists and cached preview remained visible, but opening Readable stayed on “Loading…”. Read-only inspection of the disposable app data confirmed both cached readable files (10,875 and 167 bytes), while the persisted query cache contained library lists/user/config and **no individual-link query**. Reconnecting and reopening loaded the article; disabling Wi-Fi immediately afterward and reopening displayed the cached article successfully. [Failure screenshot](mobile-offline-reader.png), disconnected status (screenshot omitted), [sanitized cache evidence](mobile-offline-diagnostics.json).

Source inspection at upstream commit `952ac4540657cae3a67c3ca59433899d2fda8374` explains a likely cause: the reader requires `useGetLink`, which has no list-data fallback; the query client does not override inactive-query garbage collection; `offlineSync.startSync` returns before hydrating individual-link queries when disconnected. That checkout's app config says 1.4.3, so this mechanism is an inference supporting the observed 1.4.4 behavior, not proof of identical shipped source. A server cannot return metadata to a disconnected app. A client cache/fallback fix is required for reliable prolonged offline opening; the official APK was deliberately left unmodified. Full offline compatibility is therefore **not** claimed.

Untested workflows include mobile share-extension import, file uploads other than the banner, every reader/highlight gesture and every settings action. Physical devices and iOS remain untested. The emulator and private ADB server were shut down after testing; RAM measurements exclude the emulator and all client rendering. The command-protection hook blocked removal of the disposable SDK at `/private/tmp/pocketmark-mobile-sdk` (about 2.4 GiB); it and the downloaded APK remain on disk for manual cleanup. No global cache or personal device data was deleted.
