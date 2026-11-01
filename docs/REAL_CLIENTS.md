# Client compatibility and verification

Pocketmark supports its own Chrome extension and Floccus over WebDAV. The
Linkwarden API compatibility layer, third-party extension/mobile support and
Floccus Linkwarden API backend have been removed. Use the
[extension guide](../extension/README.md) and [Floccus setup](FEATURES.md#floccus-setup-and-data-semantics)
for current configuration.

## Observed workflows and their limits

Historical real-client runs used disposable profiles, synthetic libraries and
unmodified client packages. They establish only the exercised workflows at the
tested revisions, not qualification of the current head or every browser.

- The Pocketmark Chrome extension was exercised in Chrome for Testing on
  21–22 October 2026: collection/tag creation, rendered HTML, visible/full-page
  PNG and PDF, popup closure, partial upload failure, browser restart and manual
  retry. Reopening an existing bookmark preserved its unrelated metadata and
  attachments. Loopback host permissions were pre-granted in that fixture;
  permission-dialog recovery has separate deterministic regression coverage.
- A 29 October 2026 Chrome extension-page check exercised collection creation,
  selection and tag addition in a narrow viewport. A normal extension page with
  simulated active-tab selection does not qualify native popup sizing or the
  browser's permission prompt.
- Unmodified Floccus 5.11.1 on Chromium was exercised on 19–20 October 2026
  through WebDAV: initial download, rename, nested folders, additions, deletions,
  order, personal metadata preservation and synchronization after server restart.
  Exact uploaded XML bytes and numeric identity survived the staged upload/MOVE
  sequence. See [protocol details](CLIENT_FLOCCUS_NOTES.md).

The removed third-party Android integration had a prolonged-offline cache issue:
lists and cached files could remain available while opening a reader stalled
because individual-link metadata had been evicted. Immediate offline reopening
worked in the tested emulator. This remains an upstream client limitation, not
a server-side offline guarantee or a currently supported integration.

## Repeatable verification

Use `make test-extension` for deterministic popup/worker behavior and `make test`
for HTTP, WebDAV and persistence regressions. Protocol tests do not operate the
actual Floccus UI. Browser checks under `e2e/` use disposable server data and
profiles; emulated phone layouts do not qualify physical devices.

When changing an integration, exercise its real client separately: capture and
retry across popup/browser closure for the extension; download, edit, move,
delete and restart synchronization for Floccus. Use a distinct API key for each
client and back up before a synchronization that can propagate deletions.

Record the exact revision, client version, exercised states and limitations in
the PR. Keep reports, traces, downloaded clients and test screenshots outside
version control as required by [AGENTS.md](../AGENTS.md).

Physical phones, iOS, Safari, spoken screen-reader behavior and every native
permission interaction remain unqualified by these observations. Chromium,
Firefox and WebKit checks of bounded interface states do not establish complete
client compatibility. Client rendering and emulator/browser RAM are excluded
from [server memory workloads](BENCHMARK.md).
