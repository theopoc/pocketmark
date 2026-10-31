"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");
const { create } = require("./static/bulk.js");
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
class Element {
  constructor() { Object.assign(this, { value: "", textContent: "", hidden: false, disabled: false, open: false, children: [], events: new Map(), options: [{}, {}] }); }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(type, fn) { if (!this.events.has(type)) this.events.set(type, []); this.events.get(type).push(fn); }
  replaceChildren(...children) { this.children = children; }
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  close() { this.open = false; queueMicrotask(() => fire(this, "close")); }
}
async function fire(node, type, extra = {}) { await Promise.all((node.events.get(type) || []).map(fn => fn({ type, target: node, preventDefault() {}, ...extra }))); }
function setup(request = async () => {}, confirm = () => true) {
  const html = fs.readFileSync(`${__dirname}/static/index.html`, "utf8"), nodes = new Map();
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) nodes.set(match[1], new Element());
  const get = id => { assert.ok(nodes.has(id), `unknown shipped element ${id}`); return nodes.get(id); };
  get("bulk-form").reset = () => { for (const id of ["bulk-action", "bulk-tags", "bulk-collection", "bulk-value"]) get(id).value = ""; };
  const calls = [], notices = [], changes = [], selections = [], expiries = [];
  const bulk = create({ api: async (path, options) => { const call = { path, ...options, body: JSON.parse(options.body) }; calls.push(call); return request(call); }, toast: (...args) => notices.push(args), onChange: async () => changes.push(true), onSelectionChange: () => selections.push(true), fillCollections: (select, value) => { select.value = value == null ? "" : String(value); }, defaultCollection: () => 7, onSessionExpired: () => expiries.push(true) }, { document: { getElementById: get, createElement: () => new Element() }, confirm });
  const link = id => ({ id, title: `Page ${id}`, url: `https://example.org/${id}` });
  const open = async (action = "favorite") => { await fire(get("bulk-open"), "click"); get("bulk-action").value = action; await fire(get("bulk-action"), "change"); };
  const submit = () => fire(get("bulk-form"), "submit");
  return { bulk, get, calls, notices, changes, selections, expiries, link, open, submit };
}
test("selection spans pages and the review includes all selected labels", async () => {
  const env = setup(), { bulk, get, link } = env;
  bulk.render([link(1), link(2)]); bulk.select(link(1), true);
  assert.equal(get("select-page")["aria-pressed"], "mixed");
  bulk.render([link(3)]); bulk.select(link(3), true);
  assert.equal(get("selected-count").textContent, "2 selected");
  assert.equal(get("selected-outside").textContent, "1 outside these results");
  await env.open("move");
  assert.equal(get("bulk-review").open, true);
  assert.deepEqual(get("bulk-items").children.map(node => node.textContent), ["Page 1", "Page 3"]);
  assert.equal(get("bulk-collection").value, "7");
  await env.submit();
  assert.deepEqual(env.calls[0].body.ids, [1, 3]); assert.equal(env.calls[0].body.collectionId, 7);
  assert.equal(bulk.has(1), false); assert.equal(get("bulk-dialog").open, false);
});
test("an old success cannot clear a later selection or close its dialogue", async () => {
  const old = deferred(), env = setup(() => old.promise);
  env.bulk.select(env.link(1), true); await env.open(); const pending = env.submit();
  env.get("bulk-dialog").close(); env.bulk.clear(); env.bulk.select(env.link(2), true); await env.open("read");
  old.resolve(); await pending;
  assert.equal(env.bulk.has(2), true); assert.equal(env.get("bulk-dialog").open, true);
  assert.equal(env.get("bulk-apply").textContent, "Update reading status for 1 bookmark");
  assert.equal(env.get("bulk-apply").disabled, false); assert.equal(env.changes.length, 1);
});
test("reversed submissions leave the current operation and controls intact", async () => {
  const first = deferred(), second = deferred(), env = setup(call => call.body.ids[0] === 1 ? first.promise : second.promise);
  env.bulk.select(env.link(1), true); await env.open(); const a = env.submit();
  env.bulk.clear(); env.bulk.select(env.link(2), true); await env.open(); const b = env.submit();
  first.resolve(); await a;
  assert.equal(env.bulk.has(2), true); assert.equal(env.get("bulk-apply").disabled, true); assert.equal(env.get("bulk-dialog").open, true);
  second.resolve(); await b;
  assert.equal(env.bulk.has(2), false); assert.equal(env.get("bulk-dialog").open, false);
});
test("late failure cannot overwrite another dialogue's error or release its submit button", async () => {
  const first = deferred(), second = deferred(), env = setup(call => call.body.ids[0] === 1 ? first.promise : second.promise);
  env.bulk.select(env.link(1), true); await env.open(); const a = env.submit();
  env.bulk.clear(); env.bulk.select(env.link(2), true); await env.open(); const b = env.submit();
  first.reject(Error("Earlier failure")); await a;
  assert.equal(env.get("bulk-error").textContent, ""); assert.equal(env.get("bulk-apply").disabled, true);
  second.reject(Error("Current failure")); await b;
  assert.equal(env.get("bulk-error").textContent, "Current failure"); assert.equal(env.get("bulk-apply").disabled, false); assert.equal(env.bulk.has(2), true);
});
test("the reviewed scope is frozen and remove/reselect survives a submitted success", async () => {
  const pending = deferred(), env = setup(() => pending.promise);
  env.bulk.select(env.link(1), true); await env.open("delete");
  env.bulk.select(env.link(2), true); const save = env.submit();
  env.bulk.select(env.link(1), false); env.bulk.select(env.link(1), true);
  pending.resolve(); await save;
  assert.deepEqual(env.calls[0].body.ids, [1]); assert.equal(env.bulk.has(1), true); assert.equal(env.bulk.has(2), true);
});
test("select-page and individual selection enforce 500 while clear updates the toolbar", async () => {
  const env = setup(), links = Array.from({ length: 502 }, (_, i) => env.link(i + 1));
  env.bulk.render(links); await fire(env.get("select-page"), "click");
  assert.equal(env.bulk.has(500), true); assert.equal(env.bulk.has(501), false);
  assert.match(env.notices[0][0], /500.*not selected/);
  assert.equal(env.bulk.select(links[501], true), false); assert.match(env.notices[1][0], /500/);
  assert.equal(env.get("select-page")["aria-pressed"], "mixed");
  await fire(env.get("clear-selection"), "click");
  assert.equal(env.bulk.has(1), false); assert.equal(env.get("bulk-open").hidden, true);
});
test("selecting exactly 500 bookmarks does not report a partial selection", async () => {
  const env = setup(), links = Array.from({ length: 500 }, (_, i) => env.link(i + 1));
  env.bulk.render(links); await fire(env.get("select-page"), "click");
  assert.equal(env.get("select-page")["aria-pressed"], "true"); assert.equal(env.notices.length, 0);
});
test("select page reflects an unchanged selection when the limit is already reached", async () => {
  const env = setup();
  for (let i = 1; i <= 500; i++) env.bulk.select(env.link(i), true);
  env.bulk.render([env.link(501)]); await fire(env.get("select-page"), "click");
  assert.equal(env.bulk.has(501), false); assert.equal(env.get("select-page")["aria-pressed"], "false");
  assert.match(env.notices[0][0], /500.*not selected/);
});
test("select page is unavailable when the current page has no bookmarks", () => {
  const env = setup();
  assert.equal(env.get("select-page").disabled, true);
  env.bulk.render([env.link(1)]);
  assert.equal(env.get("select-page").disabled, false);
  env.bulk.select(env.link(1), true);
  env.bulk.render([]);
  assert.equal(env.get("select-page").disabled, true);
  assert.equal(env.get("bulk-open").hidden, false);
});
test("duplicate submits and action changes cannot release a pending operation", async () => {
  const pending = deferred(), env = setup(() => pending.promise);
  env.bulk.select(env.link(1), true); await env.open("tags"); env.get("bulk-tags").value = "go, café, go";
  const saving = env.submit(); env.get("bulk-action").value = "read"; await fire(env.get("bulk-action"), "change"); await env.submit();
  assert.equal(env.get("bulk-apply").disabled, true); assert.equal(env.calls.length, 1);
  assert.deepEqual(env.calls[0].body.tags, ["go", "café"]); assert.equal(env.calls[0].body.action, "tags");
  pending.resolve(); await saving;
});
test("cancelled delete and unknown actions send no mutation", async () => {
  const env = setup(undefined, () => false); env.bulk.select(env.link(1), true); await env.open("delete"); await env.submit();
  assert.equal(env.calls.length, 0); assert.equal(env.bulk.has(1), true);
  env.get("bulk-action").value = "bad"; await env.submit(); assert.equal(env.calls.length, 0);
});
test("session expiry invalidates selection and pending dialogue", async () => {
  const env = setup(async () => { throw Object.assign(Error("Expired"), { status: 401 }); });
  env.bulk.select(env.link(1), true); await env.open(); await env.submit();
  assert.equal(env.bulk.has(1), false); assert.equal(env.get("bulk-dialog").open, false); assert.equal(env.expiries.length, 1);
});
test("closing before a response and queued close events cannot invalidate a reopened dialogue", async () => {
  const pending = deferred(), env = setup(() => pending.promise);
  env.bulk.select(env.link(1), true); await env.open(); const save = env.submit();
  env.bulk.close(); await env.open(); pending.resolve(); await save;
  assert.equal(env.get("bulk-dialog").open, true); assert.equal(env.bulk.has(1), true);
  env.get("bulk-action").value = "move"; await fire(env.get("bulk-action"), "change");
  assert.equal(env.get("bulk-apply").disabled, false);
});
test("the shipped shell loads and caches bulk before app without private data", () => {
  const html = fs.readFileSync(`${__dirname}/static/index.html`, "utf8"), scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(match => match[1]);
  assert.ok(scripts.includes("/bulk.js")); assert.ok(scripts.indexOf("/bulk.js") < scripts.indexOf("/app.js"));
  const context = vm.createContext({ self: { addEventListener() {} } }); vm.runInContext(fs.readFileSync(`${__dirname}/static/sw.js`, "utf8"), context);
  assert.equal(vm.runInContext('ASSETS.includes("/bulk.js")', context), true);
  assert.equal(vm.runInContext('ASSETS.some(path => path === "/" || path.startsWith("/api/"))', context), false);
});
