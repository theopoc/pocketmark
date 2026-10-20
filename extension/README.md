# Pocketmark browser extension

A small Manifest V3 companion for Chromium browsers (Chrome, Edge, Brave). It has no background worker and does no work until opened.

1. In Pocketmark, open **Settings** and create a named API key.
2. Open your browser’s extensions page, enable developer mode, choose **Load unpacked**, and select this `extension` directory.
3. Open a web page, click Pocketmark, enter your Pocketmark server origin and API key, then click **Connect**. Grant access only to that server.
4. Save the bookmark, a rendered HTML snapshot, a screenshot of the visible page, or both. Keep the popup open until saving finishes.

The server URL and API key stay in local extension storage, not synchronized browser storage. Revoke the key from Pocketmark settings to disconnect it. For remote servers use HTTPS. `activeTab` grants temporary access to the current page after you click the extension; optional host access is requested for the configured server only.

Chrome may close the popup while asking for first-time server permission. Reopen it after approving: the pending settings are recovered and authenticated before saving is enabled.

Rendered snapshots capture the current DOM after JavaScript has run and inline readable CSS rules and drawable images. Browser cross-origin protections can prevent embedding some resources. Scripts, forms and embedded frames are removed; a restrictive content policy prevents scripts and external requests in the saved HTML. A screenshot preserves the visible viewport’s appearance. This is not a full-page screenshot. A signed-in page can include personal content; capture only pages you intend to retain.

For PDF, print the source page using the browser’s **Save as PDF**, then attach the PDF in the Pocketmark reader’s **Saved files** section. This uses the browser already on your device and does not require server-side Chromium. Large captures are limited to 20 MiB per file; rendered page extraction also has a client-side resource budget.

Compatible third-party clients can instead use Pocketmark’s `/api/v1` adapter. This companion uses the native `/api` endpoints. Firefox and Safari packaging/signing are not included in this unpacked Chromium extension.

## Validation

Run `node --test extension/popup.test.cjs`. The tests exercise exact-URL lookup, authenticated creation, attaching a screenshot to an existing bookmark, active-tab change rejection, server-scoped permission requests and denied permissions. They use browser API doubles; they do not claim the extension has been installed or tested in every browser.

Actual Chrome 155 validation also covered rendered HTML, a six-page PDF, full-page PNG on a Retina display and interrupted permission recovery. See [real-client evidence](../docs/REAL_CLIENTS.md).

## Optional advanced capture package

For one-click PDF or full-page PNG capture, build the separate advanced variant:

```sh
python3 extension/build_advanced.py /tmp/pocketmark-extension-advanced
```

Load that generated directory manually instead of the default one. It requires Chromium 120+ and declares the powerful `debugger` permission at installation. Chrome explicitly does **not** allow debugger to be an optional runtime permission; the default package therefore has no debugger permission and disables these two modes. Do not install the advanced package unless you accept that broader browser capability. Both variants still request only the configured server origin for network access.

Choose **PDF** or **Full-page screenshot**, then **Save page**. Advanced capture attaches only to the clicked active tab, calls the browser’s rendering API, closes any PDF stream, and detaches in a `finally` block before uploading. There is no resident background worker. Keep the popup open while capturing. Full-page PNGs are scaled to at most 16 million pixels and 16,384 pixels per axis; both outputs have the server’s 20 MiB file limit. PDF uses the page’s print layout. Browser policies, open DevTools, restricted pages, or browser versions can prevent debugger attachment or printing; in that case use the ordinary Print → Save as PDF flow and upload the file. Lazy content that has not loaded cannot be captured.

The advanced API flow has unit coverage for PDF streaming, full-page raster bounds, failure cleanup, and oversize rejection. It has not been installed or physically qualified in a user's browser.

API references verified during implementation: [Chrome permissions restrictions](https://developer.chrome.com/docs/extensions/reference/api/permissions), [debugger attach/sendCommand/detach](https://developer.chrome.com/docs/extensions/reference/api/debugger), and [official DevTools protocol definitions](https://github.com/ChromeDevTools/devtools-protocol/blob/master/json/browser_protocol.json).
