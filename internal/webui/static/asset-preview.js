"use strict";

// This trusted shell is the only page allowed to frame a blob. Saved markup
// lives in its own scriptless, opaque sandbox, never in the shell's document.
window.addEventListener("message", (event) => {
  if (event.source !== parent || event.origin !== location.origin || event.data?.type !== "pocketmark-preview" || !(event.data.bytes instanceof ArrayBuffer)) return;
  const frame = document.createElement("iframe");
  frame.title = "Original saved HTML";
  frame.setAttribute("sandbox", "");
  const policy = "default-src 'none'; style-src 'unsafe-inline' data:; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'";
  const url = URL.createObjectURL(new Blob([`<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}">`, event.data.bytes], { type: "text/html" }));
  frame.addEventListener("load", () => {
    URL.revokeObjectURL(url);
    parent.postMessage({ type: "pocketmark-preview-ready" }, location.origin);
  }, { once: true });
  frame.src = url;
  document.body.replaceChildren(frame);
});
