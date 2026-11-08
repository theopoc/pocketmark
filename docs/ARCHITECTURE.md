# Architecture and ownership

Pocketmark keeps one Go process, SQLite/FTS5 and an embedded React + shadcn/ui interface. Vite compiles local assets during the build; rendering private library data stays in the browser. Capture work, uploads and database reads remain bounded. Production needs no Node runtime, resident browser or additional in-memory index.

## Server and persistence

| Module | Owns | Main test surface |
| --- | --- | --- |
| `cmd/pocketmark/` | Configuration, lifecycle and the bounded capture worker. | Store queue/recovery tests and release container smoke tests. |
| `internal/capture/` | Network filtering, pinned DNS, redirects, extraction and bounded passive snapshots. | Capture, layout and offline tests. |
| `internal/server/` | HTTP authentication, request limits, routes, shared upload staging and work slots. | Real HTTP handler tests with disposable stores. |
| `internal/store/` | Atomic schema initialization/upgrades, account persistence, library mutations, queue transitions and chunked documents. | Fresh and legacy database tests, restart/rollback and concurrent access regressions. |
| `store/import_json.go`, `store/import_html.go`, `store/xbel.go` | Format-specific metadata import/export, retaining each format's transaction and compatibility rules. | Format round-trips and rollback tests beside implementations. |

The store owns SQLite access and initialization failures. Constructing the HTTP routes does not initialize the schema. Document ingestion shares HTTP staging and private chunk writing while attachment and standalone-file transactions retain their own rules. See [archive limits](ARCHIVES.md) and [import semantics](GUIDE.md#import-a-bookmark-library).

## Embedded browser modules

| Module | Owns | Main test surface |
| --- | --- | --- |
| `frontend/src/main.jsx`, `shell.jsx`, `components/` | React bootstrap, page/forms/dialogs and locally owned shadcn primitives. | Compiled application browser journeys and design comparisons. |
| `frontend/src/application.js` | Application commands, navigation orchestration and native browser integrations. | Shared rules and feature tests; disposable browser checks for integration. |
| `frontend/src/features/library/` | Keyed React bookmarks, collection/tag navigation, filters, breadcrumbs and bounded favicons. | React view tests and disposable browser journeys. |
| `frontend/src/features/settings/` | Account/MFA orchestration and React API-key rows/rename forms. | Security regressions and actual browser settings journeys. |
| `frontend/src/features/reader.js` | Reading session, notes, annotations, files and formatted view. | Actual module with controlled browser/network adapters and reversed responses. |
| `frontend/src/features/bulk.js`, `selection.js` | Selection labels, cross-page scope, reviewed IDs and the submitting dialog's session. | Actual module events, selection limits, confirmations, stale completions and expiry. |
| `frontend/src/features/tag-picker.js` | Tag selection, keyboard/IME, suggestions and dialog lifecycle for both forms. | Actual input/reset/keyboard events and controlled asynchronous suggestions. |
| `frontend/src/features/workspace.js` | Shared routes, drafts and field rules. | Pure rules and storage-failure tests. |

The interface is the test surface: tests exercise production modules, rather than copies of their event handlers. Late responses must not populate another reader, clear another bulk session's selection or reopen closed suggestions. Bulk operations send the IDs reviewed for that dialog; later remove/reselect actions retain their newer identity. Native form input/reset events connect the tag picker to drafts and both forms without exposing its internal selection.

Import application modules through the React entry. `make frontend` compiles hashed assets, generates the static shell and generates the worker's static-only asset inventory/content version. The outputs are ignored build products. API responses, private pages and captured content stay outside that cache. See the [frontend guide](FRONTEND.md) for build dependencies, native integration ownership and updates. Classic shared scripts remain canonical for the extension and standalone API documentation.

## Extension

`background.js` owns the single task, capture/upload progression, manual retry and upload reconciliation. `job-store.js` owns IndexedDB opening, connection invalidation and atomic metadata/blob storage. A failed opening must permit a later attempt in the same worker. A transaction abort must not publish partial state, including when cloning a value fails synchronously.

Workflow tests use an in-memory adapter to control capture/network failures. Storage tests separately execute the real IndexedDB adapter with controlled transaction events. Disposable browser checks qualify actual blob persistence and rollback; they do not establish physical-device or all-browser compatibility. [Dated client evidence](REAL_CLIENTS.md).

## Verification scope

Run `make check`, `make test`, `make test-extension` and `make build`. CI additionally gates secrets, dependency vulnerabilities and release tooling, with separate native AMD64/ARM64 test and build jobs. The amd64 Build job runs the complete Chromium journey against its compiled binary before uploading it as a release input. Docker smoke tests additionally qualify release images. The deterministic suite tests regressions; it does not replace [RAM measurements](BENCHMARK.md) or real-client observations.

Keep modules together when their rules change together. Splitting the capture worker or other files solely for their size does not add depth; introduce a new seam only when it hides a real responsibility or supports a concrete adapter.
