"use strict";
// Captures run on demand in Chrome, never on the Pocketmark server.
const LIMIT = 20 * 1024 * 1024;
function decodedBytes(data) {
  if (typeof data !== "string" || data.length > Math.ceil(LIMIT / 3) * 4 + 4) throw new Error("Capture exceeds the 20 MiB limit.");
  const binary = atob(data), bytes = new Uint8Array(binary.length);
  if (bytes.length > LIMIT) throw new Error("Capture exceeds the 20 MiB limit.");
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
async function advancedCapture(mode, tab) {
  const target = { tabId: tab.id };
  let stream;
  try {
    if (mode === "screenshot") {
      const result = await chrome.debugger.sendCommand(target, "Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true });
      return new Blob([decodedBytes(result.data)], { type: "image/png" });
    }
    if (mode === "fullpage") {
      const metrics = await chrome.debugger.sendCommand(target, "Page.getLayoutMetrics");
      const { width, height, x = 0, y = 0 } = metrics.cssContentSize || {};
      if (![width, height, x, y].every(Number.isFinite) || width <= 0 || height <= 0 || width > 1e6 || height > 1e6) throw new Error("This page has unsupported dimensions.");
      const density = await chrome.debugger.sendCommand(target, "Runtime.evaluate", { expression: "window.devicePixelRatio", returnByValue: true });
      const dpr = density.result?.value;
      if (!Number.isFinite(dpr) || dpr <= 0 || dpr > 16) throw new Error("This page has an unsupported pixel density.");
      // CDP clip dimensions are CSS pixels, but PNG pixels include device scale.
      // Account for Retina/zoom before capture to bound the physical raster.
      const physicalWidth = width * dpr, physicalHeight = height * dpr;
      // Reserve one pixel per axis for Chromium's integer raster rounding.
      const area = physicalWidth * physicalHeight, edges = physicalWidth + physicalHeight;
      const pixelScale = (Math.sqrt(edges * edges + 4 * area * (16_000_000 - 1)) - edges) / (2 * area);
      const scale = Math.min(1, pixelScale, 16383 / physicalWidth, 16383 / physicalHeight);
      const result = await chrome.debugger.sendCommand(target, "Page.captureScreenshot", { format: "png", captureBeyondViewport: true, fromSurface: true, clip: { x, y, width, height, scale } });
      return new Blob([decodedBytes(result.data)], { type: "image/png" });
    }
    const result = await chrome.debugger.sendCommand(target, "Page.printToPDF", { printBackground: true, preferCSSPageSize: true, transferMode: "ReturnAsStream" });
    if (!result.stream) return new Blob([decodedBytes(result.data)], { type: "application/pdf" });
    stream = result.stream;
    const chunks = []; let size = 0;
    for (;;) {
      const chunk = await chrome.debugger.sendCommand(target, "IO.read", { handle: stream, size: 256 * 1024 });
      const bytes = chunk.base64Encoded ? decodedBytes(chunk.data) : new TextEncoder().encode(chunk.data);
      size += bytes.length;
      if (size > LIMIT) throw new Error("PDF exceeds the 20 MiB limit.");
      chunks.push(bytes);
      if (chunk.eof) break;
      if (!bytes.length) throw new Error("PDF stream stalled.");
    }
    return new Blob(chunks, { type: "application/pdf" });
  } finally {
    if (stream) { try { await chrome.debugger.sendCommand(target, "IO.close", { handle: stream }); } catch {} }
  }
}
async function snapshotPage() {
  const clone = document.documentElement.cloneNode(true);
  const limit = 12 * 1024 * 1024;
  let embedded = 0, omitted = 0;
  const styles = [];
  for (const sheet of document.styleSheets) {
    try { const css = [...sheet.cssRules].map((rule) => rule.cssText).join("\n"); if (embedded + css.length < limit) { styles.push(css); embedded += css.length; } else omitted++; }
    catch { omitted++; }
  }
  const originals = [...document.images], images = [...clone.querySelectorAll("img")];
  for (let i = 0; i < images.length; i++) {
    const source = originals[i], target = images[i]; target.removeAttribute("srcset"); target.removeAttribute("loading");
    if (!source?.complete || !source.naturalWidth || source.naturalWidth * source.naturalHeight > 4_000_000 || embedded >= limit) { target.removeAttribute("src"); omitted++; continue; }
    try {
      const canvas = document.createElement("canvas"); canvas.width = source.naturalWidth; canvas.height = source.naturalHeight;
      canvas.getContext("2d").drawImage(source, 0, 0); const data = canvas.toDataURL("image/png");
      canvas.width = canvas.height = 0;
      if (embedded + data.length <= limit) { target.setAttribute("src", data); embedded += data.length; } else { target.removeAttribute("src"); omitted++; }
    } catch { target.removeAttribute("src"); omitted++; }
  }
  for (const node of clone.querySelectorAll("script,iframe,frame,object,embed,link,base,meta[http-equiv],input,textarea,select,button")) node.remove();
  for (const node of clone.querySelectorAll("*")) {
    for (const attr of [...node.attributes]) if (/^on/i.test(attr.name) || ["srcdoc", "nonce", "integrity", "formaction", "action", "contenteditable"].includes(attr.name)) node.removeAttribute(attr.name);
    if (node.tagName === "A") { try { const url = new URL(node.getAttribute("href"), location.href); if (["http:", "https:"].includes(url.protocol)) { node.setAttribute("href", url.href); node.setAttribute("rel", "noopener noreferrer"); } else node.removeAttribute("href"); } catch { node.removeAttribute("href"); } }
  }
  const head = clone.querySelector("head");
  const policy = document.createElement("meta"); policy.httpEquiv = "Content-Security-Policy"; policy.content = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'"; head.prepend(policy);
  const style = document.createElement("style"); style.textContent = styles.join("\n"); head.append(style);
  const html = "<!doctype html>\n" + clone.outerHTML;
  if (html.length > 19 * 1024 * 1024) throw new Error("Rendered page is too large to save.");
  return { html, omitted };
}
async function captureFormat(mode, tab) {
  const current = await chrome.tabs.get(tab.id);
  if (current.url !== tab.url) throw new Error("The source page changed. Reopen the original URL to retry this capture.");
  let blob;
  if (mode === "html") {
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: snapshotPage });
    if (!results[0]?.result?.html) throw new Error("This page could not be captured.");
    blob = new Blob([results[0].result.html], { type: "text/html" });
  } else blob = await advancedCapture(mode, tab);
  if ((await chrome.tabs.get(tab.id)).url !== tab.url) throw new Error("The source page changed during capture. Retry on the original page.");
  if (!blob.size || blob.size > LIMIT) throw new Error("Capture exceeds the 20 MiB file limit.");
  return blob;
}
