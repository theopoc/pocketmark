"use strict";
const $ = (id) => document.getElementById(id);
let settings = {}, activeTab, attachedTarget, connecting = false;
const LIMIT = 20 * 1024 * 1024;
function status(message, error = false) { $("status").textContent = message; $("status").className = error ? "error" : ""; }
function origin(value) { const url = new URL(value); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || (url.pathname !== "/" && url.pathname !== "")) throw new Error("Enter an http(s) server origin without a path or credentials."); return url.origin; }
async function request(path, options = {}, connection = settings) {
  const response = await fetch(connection.server + path, { ...options, credentials: "omit", headers: { "Authorization": `Bearer ${connection.token}`, ...options.headers } });
  const text = await response.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch { throw new Error("The server returned an unexpected response."); }
  if (!response.ok) throw new Error(data?.error || `Request failed (${response.status}).`);
  return data;
}
async function upload(id, name, blob) {
  if (blob.size > LIMIT) throw new Error("Snapshot exceeds the 20 MiB file limit.");
  return request(`/api/links/${id}/assets?name=${encodeURIComponent(name)}`, { method: "POST", headers: { "Content-Type": blob.type }, body: blob });
}

function decodedBytes(data) {
  if (typeof data !== "string" || data.length > Math.ceil(LIMIT / 3) * 4 + 4) throw new Error("Capture exceeds the 20 MiB limit.");
  const binary = atob(data), bytes = new Uint8Array(binary.length);
  if (bytes.length > LIMIT) throw new Error("Capture exceeds the 20 MiB limit.");
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
async function advancedCapture(mode) {
  if (!chrome.debugger || !await chrome.permissions.contains({ permissions: ["debugger"] })) throw new Error("This mode requires the advanced extension package. See extension/README.md, or use your browser’s Print → Save as PDF.");
  const current = await chrome.tabs.query({ active: true, currentWindow: true });
  if (current[0]?.id !== activeTab.id || current[0]?.url !== activeTab.url) throw new Error("The active page changed. Reopen the extension on the page to capture.");
  const target = { tabId: activeTab.id };
  let attached = false, stream;
  try {
    await chrome.debugger.attach(target, "1.3"); attached = true; attachedTarget = target;
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
    if (attached) { try { await chrome.debugger.detach(target); } catch {} }
    attachedTarget = undefined;
  }
}
window.addEventListener("pagehide", () => { if (attachedTarget) chrome.debugger.detach(attachedTarget).catch(() => {}); });

// Runs only after the user chooses a snapshot. No persistent content script or background process.
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
async function finishConnection(candidate) {
  const connection = { server: origin(candidate.server), token: candidate.token };
  if (typeof connection.token !== "string" || !connection.token.trim()) throw new Error("Enter a named API key from your Pocketmark settings.");
  const session = await request("/api/session", {}, connection);
  if (session?.authenticated !== true) throw new Error("The server did not confirm an authenticated connection.");
  // Promote only after server validation; pending credentials never become active.
  await chrome.storage.local.set({ ...connection, pendingConnection: null });
  settings = connection;
  $("settings").open = false; status("Connected. You can save this page.");
}
$("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (connecting) return;
  connecting = true; $("save").disabled = true;
  try {
    const server = origin($("server").value.trim()), token = $("token").value.trim();
    if (!token) throw new Error("Enter a named API key from your Pocketmark settings.");
    const candidate = { server, token };
    settings = {};
    status("Waiting for server permission… Reopen this popup after approving if it closes.");
    // Dispatch the durable write before opening Chrome's permission prompt.
    // Start request synchronously in the user gesture: its dialog may destroy
    // this popup, but the browser-owned storage operation still persists.
    const persisted = chrome.storage.local.set({ pendingConnection: candidate });
    const permission = chrome.permissions.request({ origins: [server + "/*"] });
    const [, granted] = await Promise.all([persisted, permission]);
    if (!granted) {
      await chrome.storage.local.set({ pendingConnection: null });
      throw new Error("Server access was not granted. Click Connect to retry.");
    }
    status("Checking the server connection…");
    await finishConnection(candidate);
  } catch (error) { $("settings").open = true; status(error.message, true); }
  finally { connecting = false; $("save").disabled = false; }
});
$("save-form").addEventListener("submit", async (event) => {
  event.preventDefault(); $("save").disabled = true;
  try {
    if (connecting || !settings.server || !settings.token) throw new Error("Connect your Pocketmark server below first.");
    if (!activeTab?.url || !/^https?:\/\//i.test(activeTab.url)) throw new Error("Open a regular http(s) web page first.");
    status("Saving… Keep this popup open until it finishes.");
    const mode = $("mode").value;
    // Capture before network work so the visible page cannot change unnoticed.
    let screenshot, snapshot, advanced;
    if (["pdf", "fullpage"].includes(mode)) advanced = await advancedCapture(mode);
    if (["screenshot", "both"].includes(mode)) {
      const current = await chrome.tabs.query({ active: true, currentWindow: true });
      if (current[0]?.id !== activeTab.id) throw new Error("The active tab changed. Reopen the extension on the page to capture.");
      const data = await chrome.tabs.captureVisibleTab(activeTab.windowId, { format: "png" });
      screenshot = await (await fetch(data)).blob();
    }
    if (["html", "both"].includes(mode)) {
      const results = await chrome.scripting.executeScript({ target: { tabId: activeTab.id }, func: snapshotPage });
      if (!results[0]?.result?.html) throw new Error("This page could not be captured.");
      snapshot = results[0].result;
    }
    // Reuse a bookmark already saved with the exact URL.
    const existing = await request(`/api/links?url=${encodeURIComponent(activeTab.url)}`);
    let link = existing.links?.find((item) => item.url === activeTab.url);
    if (!link) link = await request("/api/links", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: activeTab.url, title: $("title").value.trim(), tags: [...new Set($("tags").value.split(",").map((tag) => tag.trim()).filter(Boolean))] }) });
    if (snapshot) await upload(link.id, "rendered-page.html", new Blob([snapshot.html], { type: "text/html" }));
    if (screenshot) await upload(link.id, "screenshot.png", screenshot);
    if (advanced) await upload(link.id, mode === "pdf" ? "page.pdf" : "full-page.png", advanced);
    status(`Saved to Pocketmark.${snapshot?.omitted ? ` ${snapshot.omitted} resource(s) could not be embedded; save a screenshot to preserve visible appearance.` : ""}`);
  } catch (error) { status(error.message, true); } finally { $("save").disabled = false; }
});
(async () => {
  try {
    const stored = await chrome.storage.local.get(["server", "token", "pendingConnection"]);
    settings = { server: stored.server, token: stored.token };
    [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    $("title").value = activeTab?.title || ""; $("page-title").textContent = activeTab?.title || "Open a web page to save it";
    const candidate = stored.pendingConnection;
    const displayed = candidate || settings;
    $("server").value = displayed.server || ""; $("token").value = displayed.token || "";
    $("settings").open = !!candidate || !settings.server || !settings.token;
    const advanced = !!chrome.debugger && await chrome.permissions.contains({ permissions: ["debugger"] });
    $("mode-pdf").disabled = !advanced; $("mode-fullpage").disabled = !advanced;
    if (candidate) {
      settings = {}; connecting = true; $("save").disabled = true;
      const server = origin(candidate.server);
      if (!await chrome.permissions.contains({ origins: [server + "/*"] })) {
        await chrome.storage.local.set({ pendingConnection: null });
        throw new Error("Server access was not granted. Click Connect to retry.");
      }
      status("Checking the saved connection…");
      await finishConnection(candidate);
    }
  } catch (error) { $("settings").open = true; status(error.message, true); }
  finally { connecting = false; $("save").disabled = false; }
})();
