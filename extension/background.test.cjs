"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), vm = require("node:vm"), fs = require("node:fs"), path = require("node:path");
const { randomUUID } = require("node:crypto");
const read = (name) => fs.readFileSync(path.join(__dirname, name), "utf8");
const fields = { url: "https://example.org/article", title: "Updated title", collectionId: 7, tags: ["read"] };
function event() {
  const listeners = [];
  return { addListener(fn) { listeners.push(fn); }, emit(...args) { return Promise.all(listeners.map((fn) => fn(...args))); } };
}
async function setup({ existing = false, data = new Map(), failModes = [], failUploads = [], holdCapture, attachFails = false, loseUploadResponse = false, store } = {}) {
  const calls = [], captures = [], debugging = [], assets = [], links = existing ? [{ id: 17, ...fields, description: "Keep description", notes: "Keep notes", favorite: true, read: true, title: "Old title" }] : [];
  const settings = store || { server: "https://library.example", token: "test-api-key" };
  const tabs = new Map([[3, { id: 3, url: fields.url, active: true, windowId: 1 }]]);
  const badges = new Map(), titles = new Map();
  let listener, sequence = 22;
  const chrome = {
    storage: { onChanged: event(), local: { setAccessLevel: async () => {}, get: async () => ({ ...settings }), set: async (value) => Object.assign(settings, value) } },
    permissions: { contains: async () => true, onRemoved: event() },
    action: {
      setBadgeText: async ({ tabId, text }) => badges.set(tabId, text),
      setTitle: async ({ tabId, title }) => titles.set(tabId, title),
      setBadgeBackgroundColor: async () => {},
    },
    runtime: { id: "test", getURL: (s) => "chrome-extension://test/" + s, onConnect: event(), onStartup: event(), onInstalled: event(), onMessage: { addListener(fn) { listener = fn; } } },
    windows: { WINDOW_ID_NONE: -1, onFocusChanged: event() },
    tabs: { onActivated: event(), onUpdated: event(), get: async (id) => ({ ...tabs.get(id) }),
      query: async ({ active, windowId }) => [...tabs.values()].filter((tab) => tab.active === active && (!windowId || tab.windowId === windowId)) },
    debugger: { attach: async () => { debugging.push("attach"); if (attachFails) throw Error("Debugger unavailable"); }, detach: async () => { debugging.push("detach"); } },
  };
  const jobStore = { read: async (key) => structuredClone(data.get(key)), write: async (values, remove = []) => { for (const key of remove) data.delete(key); for (const [key, value] of Object.entries(values)) data.set(key, structuredClone(value)); } };
  const context = vm.createContext({ chrome, jobStore, Blob, URL, TextEncoder, AbortSignal, crypto: { randomUUID }, console, setTimeout, clearTimeout,
    importScripts(...names) { for (const name of names) if (name !== "job-store.js" && name !== "capture.js") vm.runInContext(read(name), context); },
    captureFormat: async (mode) => { captures.push(mode); if (holdCapture) await holdCapture; if (failModes.includes(mode)) throw Error("Capture failed"); return new Blob([mode], { type: mode === "pdf" ? "application/pdf" : "image/png" }); },
    fetch: async (url, options) => {
      calls.push({ url, options });
      const pathname = new URL(url).pathname; let body, ok = true;
      if (pathname.endsWith("/api/session")) body = { authenticated: options.headers.Authorization !== "Bearer bad-key" };
      else if (pathname.endsWith("/api/collections")) body = options.method === "POST" ? { id: 7, ...JSON.parse(options.body) } : [{ id: 7, name: "Reading", parentId: null }];
      else if (pathname.endsWith("/api/tags")) body = [{ name: "read", count: 1 }];
      else if (url.includes("/api/links?")) body = { links };
      else if (pathname.endsWith("/api/links")) { body = { id: sequence++, ...JSON.parse(options.body) }; links.push(body); }
      else if (/\/assets$/.test(pathname)) {
        if (options.method === "POST") {
          const name = new URL(url).searchParams.get("name");
          if (failUploads.some((mode) => name.startsWith(mode + "-"))) { ok = false; body = { error: "Upload failed" }; }
          else { body = { id: assets.length + 1, name, size: options.body.size }; assets.push(body); if (loseUploadResponse) throw Error("Response lost"); }
        } else body = assets;
      } else if (/\/links\/\d+$/.test(pathname)) {
        const id = Number(pathname.split("/").at(-1)), index = links.findIndex((link) => link.id === id);
        if (options.method === "PUT") links[index] = { ...links[index], ...JSON.parse(options.body) };
        body = links[index];
      } else throw Error(`Unexpected request ${url}`);
      return { ok, status: ok ? 200 : 503, text: async () => JSON.stringify(body) };
    },
  });
  vm.runInContext(read("background.js"), context);
  async function send(type, values = {}) { return context.dispatch({ type, ...values }); }
  async function idle() { for (let i = 0; i < 100; i++) { const job = await send("state"); if (job?.status !== "running") return job; await new Promise(setImmediate); } throw Error("job did not finish"); }
  return { send, idle, data, calls, captures, debugging, assets, links, settings, tabs, badges, titles, chrome, context, listener: (...args) => listener(...args) };
}
test("native save creates one bookmark and updates existing fields without erasing personal data", async () => {
  const env = await setup({ existing: true });
  await env.send("save", { tabId: 3, fields, modes: [] });
  const job = await env.idle(); assert.equal(job.status, "done"); assert.equal(env.links.length, 1);
  assert.equal(env.links[0].title, fields.title); assert.equal(env.links[0].notes, "Keep notes"); assert.equal(env.links[0].description, "Keep description"); assert.equal(env.links[0].favorite, true); assert.equal(env.links[0].read, true);
  assert.ok(env.calls.every((call) => !call.url.includes("/api/v1/")));
  assert.ok(env.calls.every((call) => call.options.credentials === "omit" && call.options.redirect === "error"));
});
test("save continues after the caller receives its acknowledgement and blocks concurrent jobs", async () => {
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const env = await setup({ holdCapture: gate });
  const job = await env.send("save", { tabId: 3, fields, modes: ["pdf"] });
  assert.equal(job.status, "running");
  await assert.rejects(env.send("save", { tabId: 3, fields, modes: [] }), /running/);
  release(); assert.equal((await env.idle()).status, "done");
  assert.deepEqual(env.debugging, ["attach", "detach"]); assert.equal(env.assets.length, 1);
});
test("four independent formats upload sequentially and delete successful local blobs", async () => {
  const env = await setup(); const modes = ["html", "screenshot", "fullpage", "pdf"];
  await env.send("save", { tabId: 3, fields, modes });
  assert.equal((await env.idle()).status, "done"); assert.deepEqual(env.captures, modes);
  assert.equal(env.assets.length, 4); assert.equal(env.data.size, 1);
});
test("save feedback follows theme changes during capture and while a toast is visible", async () => {
  let release;
  const env = await setup({ holdCapture: new Promise((resolve) => { release = resolve; }) });
  const shown = [];
  env.chrome.scripting = { executeScript: async ({ args }) => {
    shown.push(args[2]);
    return [{ result: true }];
  } };
  await env.send("save", { tabId: 3, fields, modes: ["pdf"], theme: "dark" });
  await env.send("theme", { theme: "light" });
  release();
  assert.equal((await env.idle()).toastShown, true);
  assert.deepEqual(shown, ["light"]);

  const received = [];
  const port = { name: "save-toast-theme", sender: { id: "test" }, onDisconnect: event(), postMessage: (value) => received.push(value) };
  await env.chrome.runtime.onConnect.emit(port);
  await env.send("theme", { theme: "dark" });
  await port.onDisconnect.emit();
  await env.send("theme", { theme: "light" });
  assert.deepEqual(received, ["light", "dark"]);
});
test("partial capture failure still saves bookmark and successful captures", async () => {
  const env = await setup({ failModes: ["pdf"] });
  await env.send("save", { tabId: 3, fields, modes: ["screenshot", "pdf"] });
  const job = await env.idle(); assert.equal(job.status, "paused"); assert.ok(job.linkId);
  assert.equal(job.items[0].status, "saved"); assert.equal(job.items[1].status, "failed"); assert.equal(env.assets.length, 1);
  assert.deepEqual(env.debugging, ["attach", "detach"]);
  assert.equal(env.badges.get(3), "✓");
  await env.send("discard");
  assert.equal(env.badges.get(3), "✓");
});
test("failed debugger attachment preserves bookmark and records each failed format", async () => {
  const env = await setup({ attachFails: true });
  await env.send("save", { tabId: 3, fields, modes: ["html", "pdf"] });
  const job = await env.idle(); assert.ok(job.linkId); assert.equal(job.status, "paused"); assert.equal(env.assets.length, 0);
  assert.ok(job.items.every((item) => item.status === "failed"));
});
test("manual retry uses identical captured bytes even after source tab closes", async () => {
  const failures = ["pdf"], env = await setup({ failUploads: failures });
  await env.send("save", { tabId: 3, fields, modes: ["pdf", "screenshot"] });
  let job = await env.idle(); assert.equal(job.status, "paused");
  assert.equal(env.data.has("pdf"), true); assert.equal(env.data.has("screenshot"), false);
  failures.length = 0; env.chrome.tabs.get = async () => { throw Error("Tab closed"); };
  await env.send("retry"); job = await env.idle();
  assert.equal(job.status, "done"); assert.deepEqual(env.captures, ["pdf", "screenshot"]); assert.equal(env.assets.length, 2); assert.equal(env.data.size, 1);
});
test("lost upload response reconciles stable filename without creating duplicate attachments", async () => {
  const env = await setup({ loseUploadResponse: true });
  await env.send("save", { tabId: 3, fields, modes: ["pdf"] });
  assert.equal((await env.idle()).status, "paused"); assert.equal(env.assets.length, 1);
  await env.send("retry"); assert.equal((await env.idle()).status, "done"); assert.equal(env.assets.length, 1);
});
test("worker restart pauses unfinished work and never automatically recaptures or uploads", async () => {
  const data = new Map([["job", { status: "running", server: "https://library.example", fields, items: [{ mode: "pdf", status: "uploading" }] }], ["pdf", new Blob(["original"])]]);
  const env = await setup({ data }); const job = await env.send("state");
  assert.equal(job.status, "paused"); assert.equal(job.items[0].status, "failed"); assert.equal(env.calls.length, 0); assert.equal(env.captures.length, 0);
  await env.send("discard"); assert.equal(data.size, 0);
});
test("pending captures cannot be sent to a different server", async () => {
  const env = await setup({ failUploads: ["pdf"] });
  await env.send("save", { tabId: 3, fields, modes: ["pdf"] }); await env.idle();
  await assert.rejects(env.send("connect", { connection: { server: "https://other.example", token: "other" } }), /before changing servers/);
  env.settings.server = "https://other.example";
  await assert.rejects(env.send("retry"), /original server/);
});
test("native collection creation and full tag directory are available", async () => {
  const env = await setup();
  const data = await env.send("load", { tabId: 3 }); assert.equal(data.collections[0].id, 7); assert.equal(data.tags[0].name, "read");
  const collection = await env.send("collection", { name: "New", parentId: 7 }); assert.equal(collection.parentId, 7);
  await assert.rejects(env.send("collection", { name: "界".repeat(41) }), /120 bytes/);
});
test("only this extension's popup can issue commands", async () => {
  const env = await setup(); let replied = false;
  assert.equal(env.listener({ type: "discard" }, { id: "test", url: "https://example.org" }, () => { replied = true; }), false);
  assert.equal(replied, false);
});
test("invalid credentials are never promoted and tag limits are validated before saving", async () => {
  const env = await setup();
  await assert.rejects(env.send("connect", { connection: { server: env.settings.server, token: "bad-key" } }), /did not confirm/);
  assert.equal(env.settings.token, "test-api-key");
  await assert.rejects(env.send("save", { tabId: 3, fields: { ...fields, tags: ["界".repeat(27)] }, modes: [] }), /80 bytes/);
});

test("toolbar badge follows the active tab's exact URL and refreshed server state", async () => {
  const env = await setup(), { chrome } = env, tab = env.tabs.get(3);
  tab.url += "?lang=en#section";
  env.links.push({ id: 34, url: tab.url });
  await chrome.runtime.onStartup.emit();
  assert.equal(env.badges.get(3), "✓");
  assert.equal(env.titles.get(3), "Saved to Pocketmark");
  assert.equal(new URL(env.calls[0].url).searchParams.get("url"), tab.url);

  tab.url = fields.url;
  await chrome.tabs.onUpdated.emit(3, { url: tab.url }, tab);
  assert.equal(env.badges.get(3), "");
  assert.equal(env.titles.get(3), "Save to Pocketmark");
  env.links.push({ id: 35, url: tab.url });
  await chrome.tabs.onActivated.emit({ tabId: 3 });
  assert.equal(env.badges.get(3), "✓");
  env.links.pop();
  await chrome.windows.onFocusChanged.emit(tab.windowId);
  assert.equal(env.badges.get(3), "");
});

test("private, unsupported, credential-bearing and oversized URLs never trigger a passive request", async () => {
  const env = await setup({ existing: true }), { chrome } = env, tab = env.tabs.get(3);
  await chrome.tabs.onActivated.emit({ tabId: 3 });
  env.calls.length = 0;
  tab.incognito = true;
  await chrome.tabs.onActivated.emit({ tabId: 3 });
  assert.equal(env.badges.get(3), "");
  tab.incognito = false;
  for (const url of ["about:blank", "file:///example", "chrome://extensions", "https://u:p@example.org/", "https://example.org/" + "界".repeat(1400)]) {
    tab.url = url;
    await chrome.tabs.onUpdated.emit(3, { url }, tab);
  }
  tab.active = false;
  tab.url = fields.url;
  await chrome.tabs.onUpdated.emit(3, { url: tab.url }, tab);
  assert.equal(env.calls.length, 0);
});

test("a slow response for a previous page cannot mark the current page as saved", async () => {
  const env = await setup({ existing: true }), tab = env.tabs.get(3), fetch = env.context.fetch;
  const pending = Promise.withResolvers(), started = Promise.withResolvers();
  env.context.fetch = async (...args) => {
    if (new URL(args[0]).searchParams.get("url") === fields.url) {
      started.resolve();
      await pending.promise;
    }
    return fetch(...args);
  };
  const first = env.chrome.tabs.onActivated.emit({ tabId: 3 });
  await started.promise;
  tab.url += "/next";
  await env.chrome.tabs.onUpdated.emit(3, { url: tab.url }, tab);
  pending.resolve();
  await first;
  assert.equal(env.badges.get(3), "");
});

test("toolbar clears a saved check when the connection changes, permission is revoked or lookup fails", async () => {
  const env = await setup({ existing: true }), { chrome } = env;
  await chrome.tabs.onActivated.emit({ tabId: 3 });
  assert.equal(env.badges.get(3), "✓");
  env.settings.token = "";
  await chrome.storage.onChanged.emit({ token: {} }, "local");
  assert.equal(env.badges.get(3), "");
  env.settings.token = "test-api-key";
  await chrome.storage.onChanged.emit({ token: {} }, "local");
  assert.equal(env.badges.get(3), "✓");
  const requests = env.calls.length;
  chrome.permissions.contains = async () => false;
  await chrome.permissions.onRemoved.emit({ origins: [env.settings.server + "/*"] });
  assert.equal(env.badges.get(3), "");
  assert.equal(env.calls.length, requests);
  chrome.permissions.contains = async () => true;
  env.context.fetch = async () => { throw Error("offline"); };
  env.badges.set(3, "✓");
  await chrome.tabs.onActivated.emit({ tabId: 3 });
  assert.equal(env.badges.get(3), "");
});
