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
  // Keep external CSS line breaks and hidden gutters available to the passive
  // reader. Mark layout only; the styled original keeps its own text and spans.
  const blocks = document.querySelectorAll("pre"), savedBlocks = clone.querySelectorAll("pre");
  let codeNodesLeft = 16000;
  for (let i = 0; i < blocks.length && codeNodesLeft > 0; i++) {
    const block = blocks[i];
    codeNodesLeft--;
    if (!block.childElementCount || !block.getClientRects().length) continue;
    const source = document.createTreeWalker(block, NodeFilter.SHOW_ELEMENT);
    const saved = document.createTreeWalker(savedBlocks[i], NodeFilter.SHOW_ELEMENT);
    while (codeNodesLeft > 0 && source.nextNode() && saved.nextNode()) {
      codeNodesLeft--;
      const style = getComputedStyle(source.currentNode);
      if (style.display === "none" || style.visibility === "hidden") {
        saved.currentNode.setAttribute("data-pocketmark-code-layout", "hidden");
      } else if (style.display === "block") {
        saved.currentNode.setAttribute("data-pocketmark-code-layout", "block");
      }
    }
  }
  const styles = [];
  for (const sheet of document.styleSheets) {
    try { const css = [...sheet.cssRules].map((rule) => rule.cssText).join("\n"); if (embedded + css.length < limit) { styles.push(css); embedded += css.length; } else omitted++; }
    catch { omitted++; }
  }
  const originals = [...document.images], images = [...clone.querySelectorAll("img")];
  const imageURLs = originals.map(image => image.currentSrc);
  const figures = document.querySelectorAll('[role="img"]'), copies = clone.querySelectorAll('[role="img"]');
  const backgrounds = [];
  for (let i = 0; i < Math.min(figures.length, 128); i++) {
    const figure = figures[i];
    if (figure.childElementCount || figure.textContent.trim() || figure.matches("img,svg") || !figure.getClientRects().length) continue;
    const url = getComputedStyle(figure).backgroundImage.match(/^url\("([^"]+)"\)$/)?.[1];
    if (url) backgrounds.push({copy: copies[i], url});
  }
  // A displayed CDN image may allow anonymous CORS reads even though it was
  // originally loaded without crossorigin. Only retry the already loaded URL.
  let attempts = 0, bytesLeft = 4 * 1024 * 1024, deadline = 0;
  async function readRaster(rawURL) {
    const url = new URL(rawURL);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && url.origin === location.origin)) || url.username || url.password || attempts >= 8) return "";
    const byteLimit = Math.min(2 * 1024 * 1024, bytesLeft, Math.floor((limit - embedded - 64) * 3 / 4));
    if (!deadline) deadline = Date.now() + 6000;
    const remaining = deadline - Date.now();
    if (byteLimit <= 0 || remaining <= 0) return "";
    attempts++;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(2000, remaining));
    try {
      const response = await fetch(url.href, {mode: "cors", credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", signal: controller.signal});
      const type = response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
      if (!response.ok || !response.body || !/^image\/(png|jpeg|gif|webp|avif)$/.test(type) || Number(response.headers.get("Content-Length")) > byteLimit) return "";
      const reader = response.body.getReader(), chunks = [];
      let size = 0;
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.byteLength;
        bytesLeft -= value.byteLength;
        if (size > byteLimit) return "";
        chunks.push(value);
      }
      if (!size) return "";
      return await new Promise((resolve, reject) => {
        const file = new FileReader();
        file.onload = () => resolve(file.result);
        file.onerror = () => reject(file.error);
        file.readAsDataURL(new Blob(chunks, {type}));
      });
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }
  const editorial = [], other = [];
  originals.forEach((img, i) => {
    const inStory = img.closest("article, main, [role=main]") && !img.closest("nav, footer, [role=navigation]");
    (inStory ? editorial : other).push(i);
  });
  for (const i of editorial.concat(other)) {
    const source = originals[i], target = images[i]; target.removeAttribute("srcset"); target.removeAttribute("loading");
    if (!source?.complete || !source.naturalWidth || source.currentSrc !== imageURLs[i] || source.naturalWidth * source.naturalHeight > 4_000_000 || embedded >= limit) { target.removeAttribute("src"); omitted++; continue; }
    try {
      const canvas = document.createElement("canvas"); canvas.width = source.naturalWidth; canvas.height = source.naturalHeight;
      let data;
      try {
        canvas.getContext("2d").drawImage(source, 0, 0);
        data = canvas.toDataURL("image/png");
      } catch (error) {
        if (error.name !== "SecurityError") throw error;
        canvas.width = canvas.height = 0;
        data = await readRaster(source.currentSrc);
      } finally {
        canvas.width = canvas.height = 0;
      }
      if (data && embedded + data.length <= limit) { target.setAttribute("src", data); embedded += data.length; } else { target.removeAttribute("src"); omitted++; }
    } catch { target.removeAttribute("src"); omitted++; }
  }
  // A labelled CSS figure has no <img> to clone. Retain its single raster
  // background only when the browser actually requested it for this page.
  for (const {copy, url} of backgrounds) {
    if (embedded >= limit) break;
    try {
      let data;
      if (/^data:image\/(png|jpeg|webp|gif|avif)[;,]/i.test(url)) data = url;
      else if (performance.getEntriesByName(url, "resource").length) data = await readRaster(url);
      if (data && embedded + data.length <= limit) {
        copy.setAttribute("data-src", data);
        embedded += data.length;
      }
    } catch { omitted++; }
  }
  for (const node of clone.querySelectorAll("script,iframe,frame,object,embed,link,base,meta[http-equiv],meta[charset],input,textarea,select,button")) node.remove();
  for (const node of clone.querySelectorAll("*")) {
    for (const attr of [...node.attributes]) if (/^on/i.test(attr.name) || ["srcdoc", "nonce", "integrity", "formaction", "action", "contenteditable"].includes(attr.name)) node.removeAttribute(attr.name);
    if (node.tagName === "A") { try { const url = new URL(node.getAttribute("href"), location.href); if (["http:", "https:"].includes(url.protocol)) { node.setAttribute("href", url.href); node.setAttribute("rel", "noopener noreferrer"); } else node.removeAttribute("href"); } catch { node.removeAttribute("href"); } }
  }
  const head = clone.querySelector("head");
  const policy = document.createElement("meta"); policy.httpEquiv = "Content-Security-Policy"; policy.content = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'"; head.prepend(policy);
  // The DOM was decoded by the source browser. The saved Blob uses UTF-8.
  const charset = document.createElement("meta"); charset.setAttribute("charset", "utf-8"); head.prepend(charset);
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
