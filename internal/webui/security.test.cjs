"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs");

test("session settings replace stale feedback when saving succeeds or fails", async () => {
  const nodes = new Map();
  for (const match of fs.readFileSync(`${__dirname}/static/index.html`, "utf8").matchAll(/\bid="([^"]+)"/g)) {
    nodes.set(match[1], { value: "", textContent: "", disabled: false, events: {}, addEventListener(type, fn) { this.events[type] = fn; } });
  }
  const document = { getElementById: id => nodes.get(id), querySelectorAll: () => [] };
  const context = { document, PocketmarkSecurity: require("../../frontend/src/features/security.js").default };
  let fail = false;
  context.PocketmarkSecurity.create({ api: async () => { if (fail) throw Error("Save failed"); }, toast() {}, onSessionExpired() {} }, context);
  const form = nodes.get("session-idle-form"), submitter = { disabled: false };
  const submit = () => form.events.submit({ preventDefault() {}, submitter });
  await submit(); assert.match(nodes.get("sessions-feedback").textContent, /saved/);
  fail = true; await submit();
  assert.equal(nodes.get("sessions-feedback").textContent, ""); assert.equal(nodes.get("sessions-error").textContent, "Save failed");
  fail = false; await submit();
  assert.equal(nodes.get("sessions-error").textContent, ""); assert.match(nodes.get("sessions-feedback").textContent, /saved/);
});

test("leaving settings prevents an old session response from populating a reopened page", async () => {
  const nodes = new Map();
  for (const match of fs.readFileSync(`${__dirname}/static/index.html`, "utf8").matchAll(/\bid="([^"]+)"/g)) {
    nodes.set(match[1], { value: "", textContent: "", hidden: false, children: [], addEventListener() {}, replaceChildren(...children) { this.children = children; } });
  }
  const document = {
    getElementById: id => nodes.get(id), querySelectorAll: () => [],
    createElement: () => ({ textContent: "", className: "" }),
  };
  const context = { document, PocketmarkSecurity: require("../../frontend/src/features/security.js").default };
  let respond;
  const security = context.PocketmarkSecurity.create({ renderSessions(node, sessions, action, notice) { node.replaceChildren(...sessions, ...(notice ? [notice] : [])); }, api: () => new Promise(resolve => { respond = resolve; }), toast() {}, onSessionExpired() {} }, context);
  const loading = security.loadSessions();
  assert.deepEqual(nodes.get("sessions-list").children, ["Loading sessions…"]);
  nodes.get("sessions-feedback").textContent = "Old feedback";
  security.clear();
  // Settings is already visible again when the previous visit's request finishes.
  respond([{ id: 1, current: true, idleTimeoutMinutes: 15 }]);
  await loading;
  assert.equal(nodes.get("session-idle").value, "");
  assert.deepEqual(nodes.get("sessions-list").children, []);
  assert.equal(nodes.get("sessions-feedback").textContent, "");
});


test("revoking a session refreshes the list even after another refresh finishes", async () => {
  const nodes = new Map();
  const document = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, { addEventListener() {}, focus() {} });
      return nodes.get(id);
    },
    querySelectorAll: () => [],
  };
  const remote = { id: 12, device: "Synthetic browser", current: false };
  const requests = [];
  let records, revoke;
  const api = (path, options) => new Promise(resolve => requests.push({ path, method: options?.method, resolve }));
  const security = require("../../frontend/src/features/security.js").default.create({
    api,
    confirmAction: async () => true,
    renderSessions(container, sessions, action) { records = sessions; revoke = action; },
  }, { document });
  const opening = security.loadSessions();
  requests.shift().resolve([remote]);
  await opening;
  const removal = revoke(remote, "Browser", {});
  await Promise.resolve();
  const deleting = requests.shift();
  assert.equal(deleting.method, "DELETE");
  assert.equal(deleting.path, "/api/sessions/12");
  const refresh = security.loadSessions();
  requests.shift().resolve([remote]);
  await refresh;
  assert.deepEqual(records, [remote]);
  deleting.resolve({});
  await Promise.resolve();
  assert.equal(requests[0]?.path, "/api/sessions");
  requests.shift().resolve([]);
  await removal;
  assert.deepEqual(records, []);
});
