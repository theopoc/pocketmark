"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");
const { create } = require("./static/bulk.js");
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
class Element {
  constructor(document) { Object.assign(this, { document, value: "", textContent: "", hidden: false, disabled: false, open: false, children: [], events: new Map(), dataset: {}, style: { setProperty() {} } }); }
  get options() { return this.children; }
  setAttribute(name, value) { this[name] = value; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  addEventListener(type, fn) { if (!this.events.has(type)) this.events.set(type, []); this.events.get(type).push(fn); }
  replaceChildren(...children) { this.children = children; }
  append(...children) { this.children.push(...children); }
  focus() { this.document.activeElement = this; }
  showModal() { this.open = true; }
  close() { this.open = false; queueMicrotask(() => fire(this, "close")); }
  getBoundingClientRect() { return { left: 100, top: 800, width: 420 }; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) { return this.children.filter(node => selector === '[data-bulk-action]' ? node.dataset.bulkAction : selector === '[aria-pressed="true"]' ? node['aria-pressed'] === 'true' : !node.disabled); }
}
async function fire(node, type, extra = {}) { await Promise.all((node.events.get(type) || []).map(fn => fn({ type, target: node, preventDefault() {}, ...extra }))); }
function setup(request = async () => {}, phone = false) {
  const html = fs.readFileSync(`${__dirname}/static/index.html`, "utf8"), nodes = new Map();
  const document = { getElementById: id => get(id), createElement: () => new Element(document), activeElement: null };
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) nodes.set(match[1], new Element(document));
  const get = id => { assert.ok(nodes.has(id), `unknown shipped element ${id}`); return nodes.get(id); };
  const menuButtons = ["move", "tags", "favorite", "read", "capture", "delete"].map(action => { const b = new Element(document); b.dataset.bulkAction = action; return b; });
  get("bulk-dialog").children = menuButtons;
  get("bulk-menu").children = menuButtons;
  get("bulk-status-choices").children = [get("bulk-status-true"), get("bulk-status-false")];
  get("bulk-form").reset = () => { for (const id of ["bulk-tags", "bulk-collection", "bulk-collection-search"]) get(id).value = ""; };
  const calls = [], notices = [], changes = [], selections = [], expiries = [];
  const bulk = create({ api: async (path, options) => { const call = { path, ...options, body: options?.body ? JSON.parse(options.body) : undefined }; calls.push(call); return request(call); }, toast: (...args) => notices.push(args), onChange: async () => changes.push(true), onSelectionChange: () => selections.push(true), fillCollections: (select, value) => { select.children = ["", "7", "8"].map((value, i) => Object.assign(new Element(document), { value, textContent: ["Inbox", "Design", "Reading"][i] })); select.value = value == null ? "" : String(value); }, defaultCollection: () => 7, icon: name => Object.assign(new Element(document), { name }), onSessionExpired: () => expiries.push(true) }, { document, matchMedia: () => ({ matches: phone }), addEventListener() {}, innerWidth: 1280, innerHeight: 900 });
  const link = (id, read = false) => ({ id, title: `Page ${id}`, url: `https://example.org/${id}`, read });
  const open = (action = "favorite") => fire(get(action === "tags" ? "bulk-tag-action" : `bulk-${action}`), "click");
  const submit = () => fire(get("bulk-form"), "submit");
  const status = value => fire(get(`bulk-status-${value}`), "click");
  return { bulk, get, calls, notices, changes, selections, expiries, link, open, submit, status, menuButtons, document };
}
test("selection spans pages; one reviewed scope drives a collection move", async () => {
  const e = setup(); e.bulk.render([e.link(1), e.link(2)]); e.bulk.select(e.link(1), true);
  assert.equal(e.get("select-page")["aria-pressed"], "mixed");
  e.bulk.render([e.link(3)]); e.bulk.select(e.link(3), true);
  assert.equal(e.get("selected-count").textContent, "2 selected");
  await e.open("move");
  assert.equal(e.get("bulk-scope").textContent, "2 selected bookmarks");
  assert.equal(e.get("bulk-collection").value, "7");
  await e.submit(); assert.deepEqual(e.calls[0].body.ids, [1, 3]); assert.equal(e.calls[0].body.collectionId, 7);
  assert.equal(e.bulk.has(1), false); assert.equal(e.get("bulk-dialog").open, false);
});
test("Read uses a checked circle for mixed or unread selections; all-read uses Unread and a clock including off-page bookmarks", () => {
  const e = setup(); e.bulk.render([e.link(1, true), e.link(2)]); e.bulk.select(e.link(1, true), true);
  assert.equal(e.get("bulk-read-label").textContent, "Unread"); assert.equal(e.get("bulk-read-icon").children[0].name, "clock");
  e.bulk.select(e.link(2), true);
  assert.equal(e.get("bulk-read-label").textContent, "Read"); assert.equal(e.get("bulk-read-icon").children[0].name, "check-circle");
  e.bulk.render([e.link(3, true)]); e.bulk.select(e.link(3, true), true);
  assert.equal(e.get("bulk-read-label").textContent, "Read");
  e.bulk.select(e.link(2), false); assert.equal(e.get("bulk-read-label").textContent, "Unread");
  e.bulk.render([e.link(3, false)]); assert.equal(e.get("bulk-read-label").textContent, "Read");
  assert.equal(e.get("bulk-menu-read-label").textContent, "Read");
});
test("phone menu changes contents in one dialog and Back retains selection", async () => {
  const e = setup(undefined, true); e.bulk.select(e.link(1), true); await fire(e.get("bulk-open"), "click");
  assert.equal(e.get("bulk-dialog").dataset.action, "menu"); assert.equal(e.get("bulk-footer").hidden, true);
  await fire(e.menuButtons[0], "click"); assert.equal(e.get("bulk-dialog").dataset.action, "move");
  assert.equal(e.get("bulk-back").hidden, false); assert.equal(e.calls.length, 0);
  await fire(e.get("bulk-back"), "click"); assert.equal(e.get("bulk-menu").hidden, false); assert.equal(e.bulk.has(1), true);
});
test("collection search and choice submit the chosen destination", async () => {
  const e = setup(); e.bulk.select(e.link(1), true); await e.open("move");
  e.get("bulk-collection-search").value = "read"; await fire(e.get("bulk-collection-search"), "input");
  assert.equal(e.get("bulk-collections").children.length, 1);
  await fire(e.get("bulk-collections").children[0], "click"); await e.submit();
  assert.equal(e.calls[0].body.collectionId, 8);
});
test("an old success cannot clear a later selection or close its dialog", async () => {
  const old = deferred(), e = setup(() => old.promise);
  e.bulk.select(e.link(1), true); await e.open("move"); const pending = e.submit();
  e.bulk.close(); e.bulk.clear(); e.bulk.select(e.link(2), true); await e.open("read");
  old.resolve(); await pending;
  assert.equal(e.bulk.has(2), true); assert.equal(e.get("bulk-dialog").open, true);
  assert.equal(e.get("bulk-title").textContent, "Reading status"); assert.equal(e.get("bulk-status-true").disabled, false);
});
test("reversed submissions and late errors leave current controls intact", async () => {
  const first = deferred(), second = deferred(), e = setup(call => call.body.ids[0] === 1 ? first.promise : second.promise);
  e.bulk.select(e.link(1), true); await e.open("move"); const a = e.submit();
  e.bulk.clear(); e.bulk.select(e.link(2), true); await e.open("move"); const b = e.submit();
  first.reject(Error("Earlier failure")); await a;
  assert.equal(e.get("bulk-error").textContent, ""); assert.equal(e.get("bulk-apply").disabled, true);
  second.reject(Error("Current failure")); await b;
  assert.equal(e.get("bulk-error").textContent, "Current failure"); assert.equal(e.get("bulk-apply").disabled, false); assert.equal(e.bulk.has(2), true);
});
test("delete has one confirmation; frozen reviewed scope and reselected identities survive success", async () => {
  const pending = deferred(), e = setup(() => pending.promise);
  e.bulk.select(e.link(1), true); await e.open("delete"); assert.equal(e.calls.length, 0);
  assert.equal(e.get("bulk-dialog").role, "alertdialog"); assert.equal(e.document.activeElement, e.get("bulk-cancel"));
  e.bulk.select(e.link(2), true); const save = e.submit();
  e.bulk.select(e.link(1), false); e.bulk.select(e.link(1), true);
  pending.resolve(); await save;
  assert.deepEqual(e.calls[0].body.ids, [1]); assert.equal(e.calls[0].body.action, "delete"); assert.equal(e.bulk.has(1), true); assert.equal(e.bulk.has(2), true);
});
test("select-page and individual selection enforce 500 and accurately label partial and empty pages", async () => {
  const e = setup(), links = Array.from({ length: 502 }, (_, i) => e.link(i + 1));
  e.bulk.render(links); await fire(e.get("select-page"), "click");
  assert.equal(e.bulk.has(500), true); assert.equal(e.bulk.has(501), false); assert.match(e.notices[0][0], /500.*not selected/);
  assert.equal(e.bulk.select(links[501], true), false); assert.equal(e.get("select-page")["aria-pressed"], "mixed");
  e.bulk.render([]); assert.equal(e.get("select-page").disabled, true); assert.equal(e.get("bulk-bar").hidden, false);
  await fire(e.get("clear-selection"), "click"); assert.equal(e.get("bulk-bar").hidden, true);
});
test("mobile partial-page warning is emitted after the sheet closes", async () => {
  const links = Array.from({ length: 501 }, (_, i) => ({ id: i + 1, title: `Page ${i + 1}` }));
  // A toast implementation attaches feedback to the currently open dialog.
  let openAtNotice;
  const env = setup(undefined, true);
  env.bulk.render(links); env.bulk.select(links[0], true);
  await fire(env.get("bulk-open"), "click");
  env.notices.push = (...args) => { openAtNotice = env.get("bulk-dialog").open; return Array.prototype.push.apply(env.notices, args); };
  await fire(env.get("bulk-select-page"), "click");
  assert.equal(openAtNotice, false); assert.equal(env.get("bulk-dialog").open, false);
  assert.match(env.notices[0][0], /500.*not selected/);
});
test("selection labels reflect the visible selection on desktop and phone", async () => {
  const e = setup(), links = [e.link(1), e.link(2)];
  e.bulk.render(links); e.bulk.select(links[0], true);
  for (const id of ["select-page-label", "bulk-select-page-label"]) assert.equal(e.get(id).textContent, "Select all");
  await fire(e.get("select-page"), "click");
  for (const id of ["select-page-label", "bulk-select-page-label"]) assert.equal(e.get(id).textContent, "Unselect all");
  await fire(e.get("bulk-select-page"), "click");
  assert.equal(e.bulk.has(links[0].id), false); assert.equal(e.bulk.has(links[1].id), false);
  for (const id of ["select-page-label", "bulk-select-page-label"]) assert.equal(e.get(id).textContent, "Select all");
});
test("selecting exactly 500 bookmarks does not report a partial selection", async () => {
  const e = setup(), links = Array.from({ length: 500 }, (_, i) => e.link(i + 1));
  e.bulk.render(links); await fire(e.get("select-page"), "click");
  assert.equal(e.get("select-page")["aria-pressed"], "true"); assert.equal(e.notices.length, 0);
});
test("fresh action forms, tag normalization and duplicate submits", async () => {
  const pending = deferred(), e = setup(() => pending.promise);
  e.bulk.select(e.link(1), true); await e.open("tags"); e.get("bulk-tags").value = "go, café, go";
  const saving = e.submit(); await e.submit(); assert.equal(e.calls.length, 1); assert.equal(e.get("bulk-apply").disabled, true);
  assert.deepEqual(e.calls[0].body.tags, ["go", "café"]); pending.resolve(); await saving;
  e.bulk.select(e.link(2), true); await e.open("tags"); assert.equal(e.get("bulk-tags").value, "");
});
test("favorite/read choices submit explicit booleans once and can undo mixed previous states without overwriting newer changes", async () => {
  const e = setup(async call => call.path === '/api/links/1' ? { read: true } : { read: false });
  e.bulk.select(e.link(1), true); e.bulk.select(e.link(2, true), true); e.bulk.select(e.link(3), true);
  await e.open("read"); await e.submit(); assert.equal(e.calls.length, 0);
  await e.status(true); assert.equal(e.calls[0].body.value, true); assert.equal(e.calls[0].body.action, 'read');
  await e.notices[0][2].run();
  const restore = e.calls.filter(c => c.body).at(-1).body;
  assert.deepEqual(restore.ids, [1]); assert.equal(restore.value, false); assert.equal(restore.action, 'read');
  // Page 2 was already read; page 3 has since changed, so neither is overwritten.
});
test("status buttons stay disabled until failure, which keeps the selection for retry", async () => {
  const pending = deferred(), e = setup(() => pending.promise); e.bulk.select(e.link(1), true); await e.open("favorite");
  const save = e.status(false); await e.status(true); assert.equal(e.calls.length, 1); assert.equal(e.get("bulk-status-true").disabled, true);
  pending.reject(Error("Try again")); await save;
  assert.equal(e.bulk.has(1), true); assert.equal(e.get("bulk-error").textContent, "Try again"); assert.equal(e.get("bulk-status-true").disabled, false);
});
test("session expiry invalidates selection and pending dialog", async () => {
  const e = setup(async () => { throw Object.assign(Error("Expired"), { status: 401 }); });
  e.bulk.select(e.link(1), true); await e.open("capture"); await e.submit();
  assert.equal(e.bulk.has(1), false); assert.equal(e.get("bulk-dialog").open, false); assert.equal(e.expiries.length, 1);
});
test("queued close events cannot invalidate a reopened dialog", async () => {
  const pending = deferred(), e = setup(() => pending.promise);
  e.bulk.select(e.link(1), true); await e.open("move"); const save = e.submit();
  e.bulk.close(); await e.open("read"); pending.resolve(); await save;
  assert.equal(e.get("bulk-dialog").open, true); assert.equal(e.bulk.has(1), true);
});
test("the shipped shell exposes every desktop action and caches bulk without private data", () => {
  const html = fs.readFileSync(`${__dirname}/static/index.html`, "utf8");
  assert.ok(!html.includes('id="bulk-more"')); assert.ok(!html.includes('id="bulk-action"')); assert.ok(!html.includes('id="delete-selection-dialog"'));
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]); assert.ok(scripts.indexOf("/bulk.js") < scripts.indexOf("/app.js"));
  const context = vm.createContext({ self: { addEventListener() {} } }); vm.runInContext(fs.readFileSync(`${__dirname}/static/sw.js`, "utf8"), context);
  assert.equal(vm.runInContext('ASSETS.includes("/bulk.js")', context), true);
  assert.equal(vm.runInContext('ASSETS.some(path => path === "/" || path.startsWith("/api/"))', context), false);
});
