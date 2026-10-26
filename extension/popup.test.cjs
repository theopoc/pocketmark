"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), vm = require("node:vm"), fs = require("node:fs"), path = require("node:path");
async function setup({ stored, permissionCloses = false, granted = true, hostGranted = true, authenticated = true, existing = false, job = null } = {}) {
  const elements = new Map(), calls = [], writes = [], permissions = [], data = stored || { server: "https://library.example", token: "key" };
  function node(id = "") { return { id, value: "", hidden: true, children: [], listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, setAttribute() {}, replaceChildren() { this.children = []; }, append(child) { this.children.push(child); }, focus() {} }; }
  const element = (id) => { if (!elements.has(id)) elements.set(id, node(id)); return elements.get(id); };
  const context = vm.createContext({ document: { getElementById: element, createElement: () => node(), createElementNS: () => node() }, URL, TextEncoder, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, window: { addEventListener() {} },
    chrome: {
      storage: { local: { setAccessLevel: async () => {}, get: async () => data, set: async (value) => { writes.push(value); Object.assign(data, value); } } },
      tabs: { query: async () => [{ id: 3, url: "https://example.org", title: "Page title" }] },
      permissions: { contains: async () => hostGranted, request: async (value) => { permissions.push(value); return permissionCloses ? new Promise(() => {}) : granted; } },
      runtime: { sendMessage: async (message) => {
        calls.push(message);
        let value = message.type === "state" ? job : null;
        if (message.type === "connect") {
          if (!authenticated) return { ok: false, error: "Invalid API key" };
          Object.assign(data, message.connection, { pendingConnection: null }); value = { connected: true };
        }
        if (message.type === "load") value = { server: data.server, collections: [{ id: 7, name: "Reading", parentId: null }], tags: [{ name: "docs" }], link: existing ? { id: 17, title: "Existing title", tags: ["existing"], collectionId: 7 } : null };
        if (message.type === "save") value = { fields: message.fields, status: "running", message: "Starting", items: [] };
        return { ok: true, value };
      } },
    },
  });
  for (const file of ["common.js", "popup.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, file), "utf8"), context);
  await new Promise(setImmediate);
  const submit = async (id) => element(id).listeners.submit({ preventDefault() {} });
  return { element, calls, writes, permissions, data, submit, context };
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
test("first-run connection takes priority over an unusable editor", async () => {
  const env = await setup({ stored: {} });
  assert.equal(env.element("settings").hidden, false);
  assert.equal(env.element("save-form").hidden, true);
  assert.equal(env.element("connect-footer").hidden, false);
  assert.equal(env.element("save-footer").hidden, true);
});
test("connection settings preserve an unfinished bookmark and selected captures", async () => {
  const env = await setup(); env.element("title").value = "Unfinished title"; env.element("capture-pdf").checked = true;
  env.element("connection-toggle").listeners.click();
  assert.equal(env.element("settings").hidden, false); assert.equal(env.element("save-form").hidden, true);
  env.element("connection-toggle").listeners.click();
  assert.equal(env.element("save-form").hidden, false); assert.equal(env.element("title").value, "Unfinished title"); assert.equal(env.element("capture-pdf").checked, true);
  assert.equal(env.calls.filter((call) => call.type === "load").length, 1);
});
test("pending work shows recovery actions, then collapses on completion without reopening on polling", async () => {
  const job = { id: "task", status: "paused", fields: { url: "https://example.org", title: "Saved article" }, message: "Retry manually", items: [{ mode: "pdf", status: "failed", error: "Temporary error" }] };
  const env = await setup({ job });
  assert.equal(env.element("save-form").hidden, true); assert.equal(env.element("task-actions").hidden, false); assert.equal(env.element("task").open, true);
  env.element("task").open = false;
  const previousChildren = env.element("task-items").children;
  env.context.renderTask(structuredClone(job));
  assert.equal(env.element("task").open, false); assert.equal(env.element("task-items").children, previousChildren);
  env.context.renderTask({ ...job, status: "done", items: [{ mode: "pdf", status: "saved" }] });
  assert.equal(env.element("task").open, false); assert.equal(env.element("save-form").hidden, false); assert.equal(env.element("task-actions").hidden, true);
});
test("capture selection updates its summary without starting capture work", async () => {
  const env = await setup();
  assert.equal(env.element("save-hint").textContent, "Bookmark only");
  env.element("capture-pdf").checked = true; env.element("capture-pdf").listeners.change();
  assert.equal(env.element("capture-count").textContent, "1 selected"); assert.equal(env.element("save-hint").textContent, "Bookmark + 1 capture");
  assert.equal(env.calls.some((call) => call.type === "save"), false);
});

test("completed save shows a success notice and clears it on the next save", async () => {
  const env = await setup();
  await env.submit("save-form");
  const job = { id: "saved", fields: { url: "https://example.org", title: "Article" }, items: [], status: "done", linkId: 17, message: "Saved to Pocketmark." };
  env.context.renderTask(job);
  assert.equal(env.element("status").textContent, "Saved to Pocketmark.");
  assert.equal(env.element("status").className, "notice success");
  await env.submit("save-form");
  assert.equal(env.element("status").textContent, "");
  assert.equal(env.element("status").className, "notice");
});

test("reopening a completed save confirms only the current article", async () => {
  const job = { id: "saved", fields: { url: "https://example.org", title: "Article" }, items: [], status: "done", linkId: 17, message: "Saved to Pocketmark." };
  job.server = "https://library.example";
  const current = await setup({ job, existing: true });
  assert.equal(current.element("status").className, "notice success");
  assert.equal(current.element("status").textContent, "Saved to Pocketmark.");
  const other = await setup({ job: { ...job, fields: { ...job.fields, url: "https://other.example" } } });
  assert.equal(other.element("status").className, "notice");
  assert.equal(other.element("status").textContent, "Ready to save this page.");
});
test("partial and unconfirmed saves show attention instead of success, then retry confirms completion", async () => {
  const env = await setup();
  const job = { id: "save", fields: { url: "https://example.org", title: "Article" }, items: [{ mode: "pdf", status: "failed" }], status: "paused", linkId: 17, message: "Bookmark saved. Some captures need attention; retry or discard them." };
  env.context.renderTask(job);
  assert.equal(env.element("status").className, "notice error");
  assert.equal(env.element("status").textContent, job.message);
  env.context.renderTask({ ...job, status: "running" });
  assert.equal(env.element("status").textContent, "");
  env.context.renderTask({ ...job, status: "done", items: [{ mode: "pdf", status: "saved" }] });
  assert.equal(env.element("status").className, "notice success");
  const failed = { ...job, id: "failed", linkId: undefined, message: "Bookmark not confirmed. Retry manually." };
  env.context.renderTask(failed);
  assert.equal(env.element("status").className, "notice error");
  assert.equal(env.element("status").textContent, failed.message);
});

test("a completed task from another server cannot confirm the current library save", async () => {
  const env = await setup({ job: { id: "old", server: "https://old.example", fields: { url: "https://example.org" }, items: [], status: "done", linkId: 17 } });
  assert.notEqual(env.element("status").className, "notice success");
});
