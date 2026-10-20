"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const code = fs.readFileSync(path.join(__dirname, "popup.js"), "utf8");
async function setup({ existing = false, granted = true, mode = "bookmark", activeChanged = false, advanced = false, captureFails = false, oversized = false, stored, hostGranted = true, permissionCloses = false, sessionFails = false, authenticated = true, dpr = 1, width = 2000, height = 40000 } = {}) {
  const elements = new Map();
  const calls = [], saved = [], permissions = [], debugCalls = [];
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { value: id === "mode" ? mode : "", listeners: {}, addEventListener(event, fn) { this.listeners[event] = fn; } });
    return elements.get(id);
  };
  let tabQueries = 0;
  const store = stored || { server: "https://library.example", token: "test-api-key" };
  const context = vm.createContext({
    document: { getElementById: element }, URL, Blob, atob, Uint8Array, TextEncoder, window: { addEventListener() {} },
    chrome: {
      storage: { local: { get: async () => ({ ...store }), set: async (value) => { saved.push(value); Object.assign(store, value); } } },
      tabs: {
        query: async () => { tabQueries++; return [{ id: activeChanged && tabQueries > 1 ? 4 : 3, windowId: 1, url: "https://example.org/article", title: "A saved article" }]; },
        captureVisibleTab: async () => "data:image/png;base64,aGVsbG8=",
      },
      debugger: advanced ? {
        attach: async (target, version) => debugCalls.push({ command: "attach", target, version }),
        detach: async (target) => debugCalls.push({ command: "detach", target }),
        sendCommand: async (target, command, parameters) => {
          debugCalls.push({ target, command, parameters });
          if (captureFails && command === "Page.printToPDF") throw new Error("Printing unavailable");
          if (command === "Page.printToPDF") return { stream: "pdf-stream" };
          if (command === "IO.read") return { data: oversized ? "A".repeat(256 * 1024) : Buffer.from("%PDF-example").toString("base64"), base64Encoded: !oversized, eof: !oversized };
          if (command === "Page.getLayoutMetrics") return { cssContentSize: { width, height } };
          if (command === "Runtime.evaluate") return { result: { value: dpr } };
          if (command === "Page.captureScreenshot") return { data: Buffer.from("png").toString("base64") };
          return {};
        },
      } : undefined,
      permissions: { contains: async (value) => value.origins ? hostGranted : advanced, request: async (value) => { permissions.push(value); return permissionCloses ? new Promise(() => {}) : granted; } },
    },
    fetch: async (url, options) => {
      if (url.startsWith("data:")) return { blob: async () => new Blob(["png"], { type: "image/png" }) };
      calls.push({ url, options });
      let body;
      if (url.includes("/api/links?")) body = { links: existing ? [{ id: 17, url: "https://example.org/article" }] : [] };
      else if (url.endsWith("/api/links")) body = { id: 22 };
      else if (url.endsWith("/api/session")) body = sessionFails ? { error: "Invalid API key" } : { authenticated };
      else body = { id: 1 };
      return { ok: !(sessionFails && url.endsWith("/api/session")), status: sessionFails ? 401 : 200, text: async () => JSON.stringify(body) };
    },
  });
  vm.runInContext(code, context);
  await new Promise(setImmediate);
  const submit = async (id) => element(id).listeners.submit({ preventDefault() {}, submitter: {} });
  return { element, calls, saved, permissions, debugCalls, submit, store };
}
test("bookmark save uses exact URL lookup and authenticated creation", async () => {
  const env = await setup(); await env.submit("save-form");
  assert.equal(env.calls.length, 2);
  assert.equal(env.calls[0].url, "https://library.example/api/links?url=https%3A%2F%2Fexample.org%2Farticle");
  const create = env.calls[1];
  assert.equal(create.options.headers.Authorization, "Bearer test-api-key");
  assert.equal(create.options.credentials, "omit");
  assert.equal(JSON.parse(create.options.body).title, "A saved article");
  assert.equal(env.element("save").disabled, false);
});
test("existing bookmark gets a screenshot attachment without duplicate creation", async () => {
  const env = await setup({ existing: true, mode: "screenshot" }); await env.submit("save-form");
  assert.equal(env.calls.length, 2);
  assert.equal(env.calls[1].url, "https://library.example/api/links/17/assets?name=screenshot.png");
  assert.equal(env.calls[1].options.headers["Content-Type"], "image/png");
  assert.equal(env.calls[1].options.body.size, 3);
});
test("changed active tab is rejected before screenshot upload", async () => {
  const env = await setup({ mode: "screenshot", activeChanged: true }); await env.submit("save-form");
  assert.equal(env.calls.length, 0);
  assert.match(env.element("status").textContent, /active tab changed/);
});
test("connection stores a pending draft, requests only its origin, then promotes after validation", async () => {
  const env = await setup(); env.element("server").value = "https://private.example:8443/"; env.element("token").value = "new-key";
  await env.submit("settings-form");
  assert.deepEqual(JSON.parse(JSON.stringify(env.permissions)), [{ origins: ["https://private.example:8443/*"] }]);
  assert.equal(env.calls[0].url, "https://private.example:8443/api/session");
  assert.equal(env.saved.length, 2);
  assert.equal(env.saved[0].pendingConnection.server, "https://private.example:8443");
  assert.equal(env.saved[0].server, undefined);
  assert.equal(env.store.server, "https://private.example:8443");
  assert.equal(env.store.pendingConnection, null);
});
test("permission denial clears pending credentials without replacing the established connection", async () => {
  const env = await setup({ granted: false }); env.element("server").value = "https://private.example"; env.element("token").value = "new-key";
  await env.submit("settings-form");
  assert.equal(env.saved.length, 2); assert.equal(env.calls.length, 0);
  assert.equal(env.store.pendingConnection, null);
  assert.equal(env.store.server, "https://library.example");
  assert.equal(env.store.token, "test-api-key");
  assert.match(env.element("status").textContent, /not granted/);
});

test("advanced PDF streams upload and closes stream before detaching", async () => {
  const env = await setup({ advanced: true, mode: "pdf" }); await env.submit("save-form");
  const upload = env.calls.at(-1);
  assert.match(upload.url, /name=page.pdf$/);
  assert.equal(upload.options.headers["Content-Type"], "application/pdf");
  assert.equal(await upload.options.body.text(), "%PDF-example");
  assert.deepEqual(env.debugCalls.map((call) => call.command), ["attach", "Page.printToPDF", "IO.read", "IO.close", "detach"]);
  assert.equal(env.debugCalls[0].target.tabId, 3);
});
test("advanced full-page capture bounds raster memory and detaches", async () => {
  const env = await setup({ advanced: true, mode: "fullpage" }); await env.submit("save-form");
  const capture = env.debugCalls.find((call) => call.command === "Page.captureScreenshot");
  const clip = capture.parameters.clip;
  assert.equal(capture.parameters.captureBeyondViewport, true);
  assert.ok(clip.width * clip.height * clip.scale * clip.scale <= 16_000_001);
  assert.ok(clip.height * clip.scale <= 16384);
  assert.match(env.calls.at(-1).url, /name=full-page.png$/);
  assert.equal(env.debugCalls.at(-1).command, "detach");
});
test("failed advanced capture detaches without transmitting", async () => {
  const env = await setup({ advanced: true, mode: "pdf", captureFails: true }); await env.submit("save-form");
  assert.equal(env.calls.length, 0);
  assert.equal(env.debugCalls.at(-1).command, "detach");
  assert.match(env.element("status").textContent, /Printing unavailable/);
});
test("oversized PDF stops at limit, closes and detaches without uploading", async () => {
  const env = await setup({ advanced: true, mode: "pdf", oversized: true }); await env.submit("save-form");
  assert.equal(env.calls.length, 0);
  assert.deepEqual(env.debugCalls.slice(-2).map((call) => call.command), ["IO.close", "detach"]);
  assert.match(env.element("status").textContent, /20 MiB/);
});
test("default extension has no debugger access and advanced modes are disabled", async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "manifest.json"), "utf8"));
  assert.equal(manifest.permissions.includes("debugger"), false);
  const env = await setup();
  assert.equal(env.element("mode-pdf").disabled, true);
  assert.equal(env.element("mode-fullpage").disabled, true);
});


test("permission prompt closure recovers the pending connection and validates on reopen", async () => {
  const first = await setup({ permissionCloses: true });
  first.element("server").value = "http://localhost:18090"; first.element("token").value = "pending-key";
  void first.submit("settings-form");
  await new Promise(setImmediate);
  assert.equal(first.permissions.length, 1);
  assert.equal(first.store.pendingConnection.server, "http://localhost:18090");
  assert.equal(first.store.server, "https://library.example");
  assert.equal(first.calls.length, 0);
  const reopened = await setup({ stored: first.store });
  assert.equal(reopened.element("server").value, "http://localhost:18090");
  assert.equal(reopened.element("token").value, "pending-key");
  assert.equal(reopened.calls[0].url, "http://localhost:18090/api/session");
  assert.equal(reopened.calls[0].options.headers.Authorization, "Bearer pending-key");
  assert.equal(reopened.store.server, "http://localhost:18090");
  assert.equal(reopened.store.pendingConnection, null);
  assert.equal(reopened.element("settings").open, false);
  assert.match(reopened.element("status").textContent, /^Connected/);
});
test("reopening a denied pending connection never sends its API key", async () => {
  const stored = { pendingConnection: { server: "https://denied.example", token: "pending-key" } };
  const env = await setup({ stored, hostGranted: false });
  assert.equal(env.calls.length, 0);
  assert.equal(env.store.pendingConnection, null);
  assert.equal(env.element("settings").open, true);
  assert.equal(env.element("server").value, "https://denied.example");
  assert.match(env.element("status").textContent, /not granted/);
});
test("invalid pending credentials remain a draft and cannot be used to save", async () => {
  const stored = { server: "https://old.example", token: "old-key", pendingConnection: { server: "https://new.example", token: "bad-key" } };
  const env = await setup({ stored, sessionFails: true });
  assert.equal(env.store.server, "https://old.example");
  assert.equal(env.store.pendingConnection.token, "bad-key");
  assert.equal(env.element("settings").open, true);
  assert.match(env.element("status").textContent, /Invalid API key/);
  await env.submit("save-form");
  assert.equal(env.calls.length, 1);
  assert.match(env.element("status").textContent, /Connect your Pocketmark/);
});
test("a successful HTTP response without authenticated:true cannot promote credentials", async () => {
  const env = await setup({ authenticated: false });
  env.element("server").value = "https://new.example"; env.element("token").value = "bad-key";
  await env.submit("settings-form");
  assert.equal(env.store.server, "https://library.example");
  assert.equal(env.store.pendingConnection.token, "bad-key");
  assert.match(env.element("status").textContent, /did not confirm/);
});
test("Retina full-page capture bounds physical PNG dimensions rather than CSS dimensions", async () => {
  const env = await setup({ advanced: true, mode: "fullpage", dpr: 2, width: 1200, height: 4044 });
  await env.submit("save-form");
  const clip = env.debugCalls.find((call) => call.command === "Page.captureScreenshot").parameters.clip;
  assert.ok(clip.scale < 1, "unscaled Retina fixture exceeds 16 megapixels");
  const physicalWidth = Math.ceil(clip.width * clip.scale * 2), physicalHeight = Math.ceil(clip.height * clip.scale * 2);
  assert.ok(physicalWidth * physicalHeight <= 16_000_000);
  assert.ok(physicalWidth <= 16384 && physicalHeight <= 16384);
  assert.equal(env.debugCalls.find((call) => call.command === "Runtime.evaluate").parameters.expression, "window.devicePixelRatio");
  assert.equal(env.debugCalls.at(-1).command, "detach");
});
test("invalid device pixel density prevents screenshot capture and detaches", async () => {
  const env = await setup({ advanced: true, mode: "fullpage", dpr: 0 });
  await env.submit("save-form");
  assert.equal(env.debugCalls.some((call) => call.command === "Page.captureScreenshot"), false);
  assert.equal(env.calls.length, 0);
  assert.equal(env.debugCalls.at(-1).command, "detach");
});
