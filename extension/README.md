# Pocketmark for Chrome

A personal, manually installed Chrome extension. It uses Pocketmark's native API;
no Linkwarden extension or service is involved. Requires Chrome 120 or newer.

## Install and connect

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked**, then select this `extension/` directory. Alternatively,
   extract `pocketmark-extension.zip` and select the extracted folder.
3. In Pocketmark, sign in and create a dedicated key under **API keys**.
4. Open the extension on a regular HTTP(S) page. Under **Connection settings**,
   enter the Pocketmark server origin and the key, then click **Connect**.
5. Approve access to that server. Chrome may close the popup while asking;
   reopen it to finish validation without re-entering the connection.

The key stays in this browser profile's local extension storage, never Chrome
Sync. It grants library access, not account/key administration or full backups.
Revoke it from Pocketmark if needed. Use HTTPS except on a trusted local network.
A task with pending files stays bound to its original server; retry or discard
that task before connecting to another server.

## Save and edit

The popup loads an existing bookmark for the exact URL, or starts a new one.
Edit its **title**, **collection** and **tags**. The save action stays visible
while the editor scrolls. **Connection** opens settings without losing the
current editor fields. Select nested collections or create
one under the root/current collection. Choose existing tags from suggestions or
type a new one and press Enter/Add; new tags are created on saving. Notes,
description, favorites and read status are preserved when updating a bookmark.
No library browser or bookmark synchronization is built into this extension.
Floccus can still synchronize browser bookmarks independently through WebDAV.

Open **Attach captures** and select any combination of these optional formats;
all start unchecked:

- **Rendered HTML**: a passive offline snapshot of the current rendered DOM.
- **Visible area**: PNG of the source tab's viewport.
- **Full page**: PNG of the current full rendered layout.
- **PDF**: print-layout PDF of the current rendered page.

Captures can contain private signed-in content visible in the source page.
Chrome's `debugger` permission is required at installation (Chrome does not allow
it as an optional permission). The extension attaches only to the tab you chose,
for capture/upload work, then detaches. Chrome may show its debugging indicator.
No persistent content script or automatic capture scans your browsing activity.

## Progress, failures and manual retry

One background task runs at a time. Closing the popup does not cancel it; reopen
the popup to see progress and results. Active/failed tasks take priority over
the editor, with retry/discard actions kept visible. The popup closes automatically
after the bookmark and all selected captures are saved, including after a successful
retry. Reopening it on the saved page shows a green “Saved to Pocketmark” message
and a collapsed summary; expand it to inspect individual formats or edit the bookmark.
Partial failures keep the popup open with the attention message and retry actions.
Keep the source tab open and on the same URL until acquisition finishes. After acquisition, uploads do not need that tab.
Closing Chrome interrupts work; reopening the popup marks it interrupted and
requires a manual retry, rather than silently resuming or recapturing.

The bookmark is saved even if captures fail. Successful attachments remain on
the server, and new captures append rather than replace previous attachments.
Failed uploads retain the exact captured files temporarily in IndexedDB in this
Chrome profile. **Retry failed items** resends those bytes, including after a
browser restart. A failed capture that produced no file needs the original page
open and is captured again on manual retry. Files are removed locally after a
successful upload or **Discard pending files**. Discard never deletes a bookmark
or an attachment already saved to Pocketmark. No scheduled retry/offline queue
runs, and unresolved work must be retried or discarded before another save.

Uploads use stable per-task filenames to detect an already accepted attachment
when its response was lost. Retrying a committed bookmark does not overwrite
later metadata edits in Pocketmark.

## Limits

- At most four pending local files, each at most 20 MiB (80 MiB total).
  Browser storage quota/eviction can still make a file unavailable.
- One task and one upload at a time; the server's existing 32-attachment limit
  applies. Delete unwanted attachments in Pocketmark when that limit is reached.
- Full-page PNG is scaled to at most 16 megapixels and 16,384 pixels per axis,
  accounting for device pixel density. Visible screenshots remain viewport-only.
- HTML excludes scripts, frames, form controls and interactive content. External
  styles/images that cannot be read or embedded remain omitted. Lazy content not
  loaded in the tab is not synthesized. This is not a perfect site clone.
- Browser-internal pages, the Chrome Web Store, other extension pages and pages
  that disallow capture are unsupported. Existing DevTools/debugger sessions may
  prevent capture; close them and retry. Changes of URL during capture fail safely.
- Chrome is the target. Firefox, Safari and mobile extensions are not supported.

Build a manual ZIP without including tests or local files:

```sh
python3 extension/package.py /tmp/pocketmark-extension.zip
```

Run `make test-extension` for deterministic regressions. Actual browser observations
are recorded separately in [docs/REAL_CLIENTS.md](../docs/REAL_CLIENTS.md).

For a new API key, choose **Add, edit & capture — browser extension** in Settings. Read-only keys cannot save pages; Floccus keys only support WebDAV. After rotating a key, reconnect the extension with its new value.


The popup offers Dark and Light appearance in its header; the choice stays in
this browser. Dark retains its original palette. Collection creation shows a
live character count and percentage of the server name budget, including
accented letters and emoji. Shared local theme/name modules are checked by
`python3 scripts/sync_ui_assets.py` and refreshed with `--write`.
