"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), vm = require("node:vm"), fs = require("node:fs"), path = require("node:path");
async function setup({ stored, permissionCloses = false, granted = true, hostGranted = true, authenticated = true, existing = false } = {}) {
  const elements = new Map(), calls = [], writes = [], permissions = [], data = stored || { server: "https://library.example", token: "key" };
  function node(id = "") { return { id, value: "", hidden: true, children: [], listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, setAttribute() {}, replaceChildren() { this.children = []; }, append(child) { this.children.push(child); }, focus() {} }; }
  const element = (id) => { if (!elements.has(id)) elements.set(id, node(id)); return elements.get(id); };
  const context = vm.createContext({ document: { getElementById: element, createElement: () => node() }, URL, TextEncoder, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, window: { addEventListener() {} },
    chrome: {
      storage: { local: { setAccessLevel: async () => {}, get: async () => data, set: async (value) => { writes.push(value); Object.assign(data, value); } } },
      tabs: { query: async () => [{ id: 3, url: "https://example.org", title: "Page title" }] },
      permissions: { contains: async () => hostGranted, request: async (value) => { permissions.push(value); return permissionCloses ? new Promise(() => {}) : granted; } },
      runtime: { sendMessage: async (message) => {
        calls.push(message);
        let value = null;
        if (message.type === "connect") {
          if (!authenticated) return { ok: false, error: "Invalid API key" };
          Object.assign(data, message.connection, { pendingConnection: null }); value = { connected: true };
        }
        if (message.type === "load") value = { collections: [{ id: 7, name: "Reading", parentId: null }], tags: [{ name: "docs" }], link: existing ? { id: 17, title: "Existing title", tags: ["existing"], collectionId: 7 } : null };
        if (message.type === "save") value = { fields: message.fields, status: "running", message: "Starting", items: [] };
        return { ok: true, value };
      } },
    },
  });
  for (const file of ["common.js", "popup.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, file), "utf8"), context);
  await new Promise(setImmediate);
  const submit = async (id) => element(id).listeners.submit({ preventDefault() {} });
  return { element, calls, writes, permissions, data, submit };
}
test("existing bookmark preloads editable fields, collection and selected tags", async () => {
  const env = await setup({ existing: true });
  assert.equal(env.element("title").value, "Existing title"); assert.equal(env.element("collection").value, "7");
  assert.equal(env.element("selected-tags").children.length, 1); assert.equal(env.element("save").textContent, "Save changes");
});
test("save sends edited metadata and only user-selected capture formats", async () => {
  const env = await setup(); env.element("title").value = "Edited"; env.element("collection").value = "7";
  env.element("tag-input").value = "new, docs"; env.element("capture-pdf").checked = true;
  await env.submit("save-form");
  const message = env.calls.find((call) => call.type === "save");
  assert.equal(message.fields.title, "Edited"); assert.equal(message.fields.collectionId, 7);
  assert.deepEqual(Array.from(message.fields.tags), ["new", "docs"]); assert.deepEqual(Array.from(message.modes), ["pdf"]);
  assert.equal(env.element("editor").disabled, true); assert.equal(env.element("capture-pdf").checked, false);
});
test("connection permission prompt persists its draft before popup closure and recovers on reopen", async () => {
  const first = await setup({ permissionCloses: true });
  first.element("server").value = "http://localhost:18090/"; first.element("token").value = "new-key";
  void first.submit("settings-form"); await new Promise(setImmediate);
  assert.equal(first.data.pendingConnection.server, "http://localhost:18090"); assert.equal(first.data.server, "https://library.example");
  assert.equal(first.permissions[0].origins[0], "http://localhost:18090/*");
  const reopened = await setup({ stored: first.data });
  assert.equal(reopened.data.server, "http://localhost:18090"); assert.equal(reopened.data.pendingConnection, null);
});
test("denied server permission and invalid credentials never replace the established connection", async () => {
  const denied = await setup({ granted: false }); denied.element("server").value = "https://other.example"; denied.element("token").value = "new-key";
  await denied.submit("settings-form"); assert.equal(denied.data.server, "https://library.example"); assert.equal(denied.data.pendingConnection, null);
  const invalid = await setup({ authenticated: false }); invalid.element("server").value = "https://other.example"; invalid.element("token").value = "bad-key";
  await invalid.submit("settings-form"); assert.equal(invalid.data.server, "https://library.example"); assert.match(invalid.element("status").textContent, /Invalid API key/);
});
test("reopening denied permission never sends pending credentials", async () => {
  const env = await setup({ stored: { pendingConnection: { server: "https://denied.example", token: "secret" } }, hostGranted: false });
  assert.equal(env.calls.some((call) => call.type === "connect"), false); assert.equal(env.data.pendingConnection, null);
  assert.match(env.element("status").textContent, /not granted/);
});
test("server address rejects credentials, paths, queries and fragments", async () => {
  const env = await setup();
  for (const url of ["https://user:pass@example.org", "https://example.org/path", "https://example.org?key=x", "https://example.org#x"]) {
    env.element("server").value = url; env.element("token").value = "key"; await env.submit("settings-form");
  }
  assert.equal(env.permissions.length, 0);
});
