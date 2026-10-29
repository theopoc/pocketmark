"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), vm = require("node:vm"), fs = require("node:fs"), path = require("node:path");
async function setup({ stored, permissionCloses = false, granted = true, hostGranted = true, authenticated = true, existing = false, job = null, collectionResult, tagsFail = false, tagsResult } = {}) {
  const elements = new Map(), calls = [], writes = [], permissions = [], data = stored || { server: "https://library.example", token: "key" };
  let closeCount = 0;
  function node(id = "") { return { id, value: "", hidden: true, children: [], listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, setAttribute() {}, replaceChildren() { this.children = []; }, append(child) { this.children.push(child); }, focus() {} }; }
  const element = (id) => { if (!elements.has(id)) elements.set(id, node(id)); return elements.get(id); };
  const context = vm.createContext({ document: { getElementById: element, createElement: () => node(), createElementNS: () => node() }, URL, TextEncoder, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, window: { addEventListener() {}, close() { closeCount++; } },
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
        if (message.type === "collection") value = await collectionResult;
        if (message.type === "tags") { if (tagsFail) return { ok: false, error: "Unavailable" }; value = tagsResult ? await tagsResult : { tags: [] }; }
        if (message.type === "save") value = job = { id: "task", fields: message.fields, status: "running", message: "Starting", items: message.modes.map((mode) => ({ mode, status: "pending" })) };
        if (message.type === "retry") value = job = { ...job, status: "running", message: "Retrying" };
        return { ok: true, value };
      } },
    },
  });
  for (const file of ["common.js", "popup.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, file), "utf8"), context);
  await new Promise(setImmediate);
  const submit = async (id) => element(id).listeners.submit({ preventDefault() {} });
  return { element, calls, writes, permissions, data, submit, context, get closeCount() { return closeCount; }, setJob(value) { job = value; } };
}
test("adding a tag invalidates an outstanding suggestions request", async () => {
  let resolve; const pending = new Promise(done => { resolve = done; });
  const env = await setup({ tagsResult: pending }), el = env.element;
  el("tag-input").value = "news"; el("tag-input").listeners.input();
  await new Promise(done => setTimeout(done, 250));
  assert.equal(env.calls.some(call => call.type === "tags"), true);
  el("add-tag").listeners.click(); resolve({ tags: [{ name: "newsletter" }] });
  await new Promise(setImmediate);
  assert.equal(el("tag-options").children.length, 0); assert.equal(el("selected-tags").children.length, 1);
});
test("failed tag suggestions clear stale options and explain manual entry", async () => {
  const env = await setup({ tagsFail: true }), el = env.element;
  assert.equal(el("tag-options").children.length, 1);
  el("tag-input").value = "new"; el("tag-input").listeners.input();
  assert.equal(el("tag-options").children.length, 0);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.match(el("tag-hint").textContent, /unavailable.*press Enter/i);
  el("add-tag").listeners.click(); assert.equal(el("selected-tags").children.length, 1);
});
test("a late collection creation leaves a reopened editor and its parent intact", async () => {
  let resolve; const pending = new Promise(done => { resolve = done; });
  const env = await setup({ collectionResult: pending }), el = env.element;
  el("new-collection").listeners.click(); el("collection-name").value = "Earlier";
  const creating = el("create-collection").listeners.click();
  assert.equal(el("collection-name").readOnly, true); assert.equal(el("collection-parent").disabled, true);
  el("cancel-collection").listeners.click(); el("new-collection").listeners.click();
  el("collection-name").value = "New draft"; el("collection-parent").value = "7";
  resolve({ id: 8, name: "Earlier", parentId: null }); await creating;
  assert.equal(el("collection-create").hidden, false); assert.equal(el("collection-name").value, "New draft");
  assert.equal(el("collection-parent").value, "7"); assert.equal(el("create-collection").disabled, false);
});
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
for (const modes of [[], ["pdf", "screenshot"]]) test(`popup closes only after successful save (${modes.length} captures)`, async () => {
  const env = await setup();
  for (const mode of modes) env.element("capture-" + mode).checked = true;
  await env.submit("save-form");
  assert.equal(env.closeCount, 0);
  const job = { id: "task", fields: { url: "https://example.org", title: "Page title" }, status: "running", message: "Uploading", linkId: 17, items: modes.map((mode) => ({ mode, status: "uploading" })) };
  env.setJob(job); await env.context.refresh();
  assert.equal(env.closeCount, 0);
  env.setJob({ ...job, status: "done", items: modes.map((mode) => ({ mode, status: "saved" })) });
  await env.context.refresh();
  assert.equal(env.closeCount, 1);
  await env.context.refresh();
  assert.equal(env.closeCount, 1);
});
test("reopening a completed save keeps the popup open for editing", async () => {
  const env = await setup({ existing: true, job: { id: "previous", fields: { url: "https://example.org", title: "Saved page" }, status: "done", message: "Saved", items: [] } });
  await env.context.refresh();
  assert.equal(env.closeCount, 0); assert.equal(env.element("save-form").hidden, false);
});
test("partial capture failure keeps recovery visible and successful retry closes the popup", async () => {
  const env = await setup(); env.element("capture-pdf").checked = true;
  await env.submit("save-form");
  const job = { id: "task", fields: { url: "https://example.org", title: "Page title" }, status: "paused", message: "Capture failed", linkId: 17, items: [{ mode: "pdf", status: "failed" }] };
  env.setJob(job); await env.context.refresh();
  assert.equal(env.closeCount, 0); assert.equal(env.element("task-actions").hidden, false);
  await env.element("retry").listeners.click();
  assert.equal(env.closeCount, 0);
  env.setJob({ ...job, status: "done", items: [{ mode: "pdf", status: "saved" }] });
  await env.context.refresh();
  assert.equal(env.closeCount, 1);
});
test("invalid bookmark stays open and shows its error", async () => {
  const env = await setup(); env.element("title").value = "x".repeat(1025);
  await env.submit("save-form");
  assert.equal(env.closeCount, 0); assert.equal(env.calls.some((call) => call.type === "save"), false);
  assert.ok(env.element("status").textContent); assert.equal(env.element("save").disabled, false);
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
