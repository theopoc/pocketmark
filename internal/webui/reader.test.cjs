"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { create } = require("./static/reader.js");
const workspace = require("./static/workspace.js");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise(setImmediate);
const link = (id, changes = {}) => ({ id, url: `https://example.com/${id}`, title: `Page ${id}`, content: `Text ${id}`, notes: "Saved notes", description: "Description", tags: ["keep"], collectionId: 7, favorite: true, read: false, status: "ready", ...changes });

// A small browser adapter exercises the production module and its DOM events.
// IDs and section controls come from the shipped document, not an alternate UI.
class Element {
  constructor(tag = "div", id = "") {
    Object.assign(this, { tagName: tag.toUpperCase(), id, value: "", hidden: false, disabled: false, open: false, dataset: {}, style: {}, attributes: {}, children: [], events: new Map(), scrollTop: 0, text: "" });
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(""); }
  append(...nodes) {
    for (const node of nodes) {
      if (node.tagName === "#FRAGMENT") { this.append(...node.children); continue; }
      node.parentNode = this; this.children.push(node);
    }
  }
  replaceChildren(...nodes) { this.children = []; this.text = ""; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; if (name === "src") this.src = ""; }
  addEventListener(type, fn) { if (!this.events.has(type)) this.events.set(type, []); this.events.get(type).push(fn); }
  dispatchEvent(event) { for (const fn of this.events.get(event.type) || []) fn(event); return true; }
  querySelector(selector) {
    assert.equal(selector, "button[type=submit]");
    if (!this.submit) { this.submit = new Element("button"); this.append(this.submit); }
    return this.submit;
  }
  contains(node) { for (; node; node = node.parentNode) if (node === this) return true; return false; }
  showModal() { this.open = true; }
  close() { if (this.open) { this.open = false; queueMicrotask(() => this.dispatchEvent({ type: "close" })); } }
  click() { if (!this.disabled) this.dispatchEvent({ type: "click" }); }
  focus() { this.focused = true; }
  scrollIntoView(options) { this.scrollOptions = options; }
}
async function fire(node, type, extra = {}) {
  const event = { type, target: node, submitter: node.querySelector && type === "submit" ? node.querySelector("button[type=submit]") : undefined, preventDefault() {}, ...extra };
  await Promise.all((node.events.get(type) || []).map(fn => fn(event)));
}
function setup({ handler, head } = {}) {
  const elements = new Map(), sections = [];
  const html = fs.readFileSync(`${__dirname}/static/index.html`, "utf8");
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)) elements.set(match[2], new Element(match[1], match[2]));
  for (const match of html.matchAll(/data-reader-section="([^"]+)"/g)) { const node = new Element("button"); node.dataset.readerSection = match[1]; sections.push(node); }
  const get = id => { assert.ok(elements.has(id), `unknown shipped element ${id}`); return elements.get(id); };
  const document = new Element("document");
  Object.assign(document, {
    getElementById: get, createElement: tag => new Element(tag), createTextNode: text => { const node = new Element("#text"); node.textContent = text; return node; }, createDocumentFragment: () => new Element("#fragment"),
    querySelectorAll: selector => selector === "[data-highlight-selection]" ? [get("reader-highlight"), get("annotate-selection")] : selector === "[data-reader-section]" ? sections : assert.fail(`unexpected selector ${selector}`),
  });
  const records = new Map([[1, link(1)], [2, link(2)]]), annotations = new Map(), assets = new Map(), calls = [], notices = [], edits = [], changes = [], headCalls = [], windows = [];
  const drafts = workspace.createDrafts();
  let expired = 0;
  const browser = { document, addEventListener: (...args) => document.addEventListener(...args), location: { origin: "https://pocketmark.test" }, matchMedia: () => ({ matches: true }), confirm: () => true, getSelection: () => null, open: (...args) => windows.push(args), Event: class { constructor(type) { this.type = type; } },
    fetch: async (path, options) => { headCalls.push({ path, options }); return head ? head(path, options) : { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) }; },
  };
  async function api(path, options = {}) {
    calls.push({ path, ...options });
    const fallback = () => {
      const match = path.match(/^\/api\/links\/(\d+)(?:\/(annotations|assets|capture|preserve))?$/);
      if (!match) throw Error(`unexpected request ${path}`);
      const id = Number(match[1]), section = match[2];
      if (section === "annotations") return structuredClone(annotations.get(id) || []);
      if (section === "assets") return structuredClone(assets.get(id) || []);
      if (section === "capture") return { ok: true };
      if (section === "preserve") return { embedded: 2, omitted: 0 };
      if (options.method === "PUT") { records.set(id, { ...records.get(id), ...JSON.parse(options.body) }); return structuredClone(records.get(id)); }
      return structuredClone(records.get(id));
    };
    return handler ? handler(path, options, fallback) : fallback();
  }
  const reader = create({ api, drafts, toast: (...args) => notices.push(args), onEdit: value => edits.push(value), onChange: async () => changes.push(true), onSessionExpired: () => expired++ }, browser);
  return { reader, get, document, browser, records, annotations, assets, calls, notices, edits, changes, headCalls, windows, drafts, expired: () => expired };
}

test("opening a later bookmark ignores reversed document and section responses", async () => {
  const first = deferred();
  const env = setup({ handler: (path, options, fallback) => path === "/api/links/1" ? first.promise : fallback() });
  const old = env.reader.open(1);
  await env.reader.open(2);
  first.resolve(link(1)); await old;
  assert.equal(env.get("reader-title").textContent, "Page 2");
  assert.equal(env.calls.filter(call => call.path.startsWith("/api/links/1/")).length, 0);

  const notes = deferred(), files = deferred();
  const other = setup({ handler: (path, options, fallback) => path === "/api/links/1/annotations" ? notes.promise : path === "/api/links/1/assets" ? files.promise : fallback() });
  const loading = other.reader.open(1); await tick();
  await other.reader.open(2);
  notes.resolve([{ id: 4, quote: "Old", start: 0, end: 3, note: "Old note" }]); files.resolve([{ id: 8, name: "old.html", mediaType: "text/html", size: 10 }]); await loading;
  assert.equal(other.get("reader-title").textContent, "Page 2");
  assert.doesNotMatch(other.get("annotation-list").textContent, /Old/);
  assert.doesNotMatch(other.get("asset-list").textContent, /old.html/);
});

test("closing before a response and queued close events cannot repopulate a new reader", async () => {
  const response = deferred();
  const env = setup({ handler: (path, options, fallback) => path === "/api/links/1" ? response.promise : fallback() });
  const loading = env.reader.open(1);
  env.reader.close();
  await env.reader.open(2);
  response.resolve(link(1)); await loading;
  assert.equal(env.get("reader-dialog").open, true);
  assert.equal(env.get("reader-title").textContent, "Page 2");
  assert.equal(env.get("reader-layout").src, "");
});

test("a failed reader opening can retry the same bookmark", async () => {
  let failing = true;
  const env = setup({ handler: (path, options, fallback) => {
    if (path === "/api/links/1" && failing) throw Error("Temporarily unavailable");
    return fallback();
  } });
  await env.reader.open(1);
  assert.equal(env.get("reader-retry-open").hidden, false);
  assert.match(env.get("reader-status").textContent, /Temporarily unavailable/);
  for (const id of ["reader-section-nav", "reader-reading-bar", "annotations-section", "reader-files"]) assert.equal(env.get(id).hidden, true);
  failing = false;
  await fire(env.get("reader-retry-open"), "click");
  await tick();
  assert.equal(env.get("reader-title").textContent, "Page 1");
  assert.equal(env.get("reader-retry-open").hidden, true);
  for (const id of ["reader-section-nav", "reader-reading-bar", "annotations-section", "reader-files"]) assert.equal(env.get(id).hidden, false);
  assert.equal(env.calls.filter(call => call.path === "/api/links/1").length, 2);
});

test("checking capture status keeps a keyboard focus target", async () => {
  const env = setup();
  env.records.set(1, link(1, { status: "pending" }));
  await env.reader.open(1);
  await fire(env.get("reader-recheck"), "click");
  await tick();
  assert.equal(env.get("reader-title").focused, true);
  assert.equal(env.get("reader-recheck").hidden, false);
});

test("partial section errors leave text usable and retry only the failed section", async () => {
  let fail = true;
  const env = setup({ handler: (path, options, fallback) => {
    if (path.endsWith("/assets") && fail) throw Error("Files unavailable");
    return fallback();
  } });
  await env.reader.open(1);
  assert.equal(env.get("reader-content").textContent, "Text 1");
  assert.equal(env.get("assets-retry").hidden, false);
  assert.equal(env.get("annotations-error").hidden, true);
  fail = false;
  await fire(env.get("assets-retry"), "click");
  assert.equal(env.get("assets-error").hidden, true);
  assert.equal(env.calls.filter(call => call.path.endsWith("/annotations")).length, 1);
});

test("failed capture offers a direct retry and prevents duplicate requests", async () => {
  const pending = deferred();
  const env = setup({ handler: (path, options, fallback) => path.endsWith("/capture") ? pending.promise : fallback() });
  env.records.set(1, link(1, { status: "failed", error: "page not found" }));
  await env.reader.open(1);
  assert.equal(env.get("reader-retry-capture").hidden, false);
  env.document.activeElement = env.get("reader-retry-capture");
  const retry = fire(env.get("reader-retry-capture"), "click");
  assert.equal(env.get("reader-capture").disabled, true);
  assert.equal(env.get("reader-retry-capture").attributes["aria-disabled"], "true");
  await fire(env.get("reader-retry-capture"), "click");
  await fire(env.get("reader-capture"), "click");
  assert.equal(env.calls.filter(call => call.path.endsWith("/capture")).length, 1);
  pending.resolve({ ok: true }); await retry;
  assert.equal(env.get("reader-retry-capture").hidden, true);
  assert.equal(env.get("reader-recheck").hidden, false);
  assert.equal(env.get("reader-recheck").focused, true);
  assert.match(env.get("reader-status").textContent, /queued/i);
  await env.reader.open(2);
  assert.equal(env.get("reader-retry-capture").hidden, true);
});

test("a rejected direct capture retry remains available with a visible error", async () => {
  const env = setup({ handler: (path, options, fallback) => { if (path.endsWith("/capture")) throw Error("Try again later"); return fallback(); } });
  env.records.set(1, link(1, { status: "failed" }));
  await env.reader.open(1);
  await fire(env.get("reader-retry-capture"), "click");
  assert.equal(env.get("reader-retry-capture").hidden, false);
  assert.equal(env.get("reader-retry-capture").attributes["aria-disabled"], undefined);
  assert.match(env.get("reader-status").textContent, /Try again later/);
});

test("notes saved while typing preserve newer notes and unrelated editor drafts", async () => {
  const save = deferred();
  const env = setup({ handler: (path, options, fallback) => options.method === "PUT" ? save.promise : fallback() });
  env.drafts.put("bookmark:1", { ...workspace.editableBookmark(link(1)), title: "Unfinished title" }, workspace.editableBookmark(link(1)));
  await env.reader.open(1);
  env.get("reader-notes").value = "Submitted notes"; await fire(env.get("reader-notes"), "input");
  const saving = fire(env.get("reader-notes-form"), "submit");
  env.get("reader-notes").value = "Newer notes"; await fire(env.get("reader-notes"), "input");
  save.resolve({ ok: true }); await saving;
  assert.equal(env.drafts.get("bookmark:1").title, "Unfinished title");
  assert.equal(env.drafts.get("bookmark:1").notes, "Newer notes");
  assert.equal(env.get("reader-notes-draft").hidden, false);
  const body = JSON.parse(env.calls.find(call => call.method === "PUT").body);
  assert.equal(body.notes, "Submitted notes");
  assert.equal(body.favorite, true);
  assert.deepEqual(body.tags, ["keep"]);
});

test("an older note save cannot change a newly opened document or its submit button", async () => {
  const save = deferred();
  const env = setup({ handler: (path, options, fallback) => options.method === "PUT" ? save.promise : fallback() });
  await env.reader.open(1);
  env.get("reader-notes").value = "Saved for one"; await fire(env.get("reader-notes"), "input");
  const saving = fire(env.get("reader-notes-form"), "submit");
  await env.reader.open(2);
  env.get("reader-notes").value = "New draft for two"; await fire(env.get("reader-notes"), "input");
  save.resolve({ ok: true }); await saving;
  assert.equal(env.get("reader-title").textContent, "Page 2");
  assert.equal(env.get("reader-notes").value, "New draft for two");
  assert.equal(env.drafts.get("bookmark:2").notes, "New draft for two");
});

test("session expiry closes the reader, retains drafts and ignores other late sections", async () => {
  const files = deferred();
  const env = setup({ handler: (path, options, fallback) => {
    if (path.endsWith("/assets")) return files.promise;
    if (path.endsWith("/annotations")) throw Object.assign(Error("Expired"), { status: 401 });
    return fallback();
  } });
  env.drafts.put("bookmark:1", { notes: "Keep this draft" }, {});
  const opening = env.reader.open(1); await tick();
  assert.equal(env.get("reader-dialog").open, false);
  files.resolve([{ id: 8, name: "late.html", mediaType: "text/html", size: 10 }]); await opening;
  assert.equal(env.expired(), 1);
  assert.equal(env.drafts.get("bookmark:1").notes, "Keep this draft");
  assert.doesNotMatch(env.get("asset-list").textContent, /late.html/);
});

test("formatted-view requests cannot override text mode or a new document", async () => {
  const head = deferred();
  const env = setup({ head: () => head.promise });
  env.assets.set(1, [{ id: 8, name: "page.html", mediaType: "text/html", size: 100 }]);
  await env.reader.open(1);
  const showing = fire(env.get("reader-layout-mode"), "click");
  await fire(env.get("reader-text-mode"), "click");
  head.resolve({ ok: true, status: 200 }); await showing;
  assert.equal(env.get("reader-layout").hidden, true);
  assert.equal(env.get("reader-layout").src, "");
  assert.equal(env.headCalls[0].options.credentials, "same-origin");
});

test("saved files open images, PDF and sandboxed original HTML in the integrated viewer", async () => {
  const env = setup();
  env.assets.set(1, [
    { id: 8, name: "Full page.png", mediaType: "image/png", size: 100 },
    { id: 9, name: "Printed.pdf", mediaType: "application/pdf", size: 100 },
    { id: 10, name: "Large page.html", mediaType: "text/html", size: 3 * 1024 * 1024 },
  ]);
  await env.reader.open(1);
  const row = env.get("asset-list").children[0];
  assert.equal(row.children.find(node => node.textContent === "Delete").attributes["aria-label"], "Delete Full page.png");
  await fire(row.children.find(node => node.textContent === "View"), "click");
  await tick();
  assert.equal(env.get("asset-viewer").open, true);
  assert.equal(env.get("asset-viewer-select").children.length, 3);
  let content = env.get("asset-viewer-content").children[0];
  assert.equal(content.tagName, "IMG");
  assert.equal(content.src, "/api/assets/8/view");
  assert.equal(env.get("asset-viewer-download").href, "/api/assets/8");
  await fire(content, "load");
  assert.equal(env.get("asset-viewer-status").textContent, "Full page.png");
  env.get("asset-viewer-select").value = "9";
  await fire(env.get("asset-viewer-select"), "change");
  content = env.get("asset-viewer-content").children[0];
  assert.equal(content.tagName, "IFRAME");
  assert.equal(content.src, "/api/assets/9/view");
  assert.equal(content.attributes.sandbox, undefined, "native PDF plugin must remain usable");
  env.get("asset-viewer-select").value = "10";
  await fire(env.get("asset-viewer-select"), "change");
  content = env.get("asset-viewer-content").children[0];
  assert.equal(content.src, "/asset-preview.html");
  assert.equal(env.headCalls.at(-1).options.method, "GET", "HTML checks the actual preparation response");
  await fire(env.get("asset-viewer-close"), "click");
  assert.equal(env.get("asset-viewer").open, false);
  assert.equal(env.get("asset-viewer-content").children.length, 0);
  assert.equal(env.get("reader-dialog").open, true);
});

test("late preview responses cannot reopen closed captures or replace a newer selection", async () => {
  const head = deferred();
  const env = setup({ head: (path) => path.includes("/8/") ? head.promise : { ok: true, status: 200 } });
  env.assets.set(1, [{ id: 8, name: "Slow.html", mediaType: "text/html", size: 100 }, { id: 9, name: "New.png", mediaType: "image/png", size: 100 }]);
  await env.reader.open(1);
  await fire(env.get("asset-list").children[0].children.find(node => node.textContent === "View"), "click");
  env.get("asset-viewer-select").value = "9";
  await fire(env.get("asset-viewer-select"), "change");
  head.resolve({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) }); await tick();
  assert.equal(env.get("asset-viewer-content").children[0].src, "/api/assets/9/view");
  await env.reader.open(2);
  assert.equal(env.get("asset-viewer").open, false);
  assert.equal(env.get("asset-viewer-content").children.length, 0);
});

test("preview errors offer retry and session expiry closes every viewer", async () => {
  let status = 404;
  const env = setup({ head: () => ({ ok: status === 200, status, arrayBuffer: async () => new ArrayBuffer(0) }) });
  env.assets.set(1, [{ id: 8, name: "Page.html", mediaType: "text/html", size: 100 }]);
  await env.reader.open(1);
  await fire(env.get("asset-list").children[0].children.find(node => node.textContent === "View"), "click");
  await tick();
  assert.match(env.get("asset-viewer-status").textContent, /no longer available/);
  assert.equal(env.get("asset-viewer-retry").hidden, false);
  status = 200;
  await fire(env.get("asset-viewer-retry"), "click");
  assert.equal(env.get("asset-viewer-content").children[0].src, "/asset-preview.html");
  status = 422;
  await fire(env.get("asset-viewer-retry"), "click");
  assert.equal(env.get("asset-viewer-content").children.length, 0);
  assert.match(env.get("asset-viewer-status").textContent, /Could not open/);
  assert.equal(env.get("asset-viewer-retry").hidden, false);
  assert.equal(env.headCalls.at(-1).options.method, "GET");
  status = 401;
  await fire(env.get("asset-viewer-retry"), "click");
  assert.equal(env.expired(), 1);
  assert.equal(env.get("asset-viewer").open, false);
  assert.equal(env.get("reader-dialog").open, false);
});

test("capture completion cannot overwrite a different reader's status", async () => {
  const capture = deferred();
  const env = setup({ handler: (path, options, fallback) => path.endsWith("/capture") ? capture.promise : fallback() });
  await env.reader.open(1);
  const pending = fire(env.get("reader-capture"), "click");
  await env.reader.open(2);
  capture.resolve({ ok: true }); await pending;
  assert.equal(env.get("reader-status").textContent, "Captured text");
  assert.equal(env.get("reader-recheck").hidden, true);
  assert.equal(env.get("reader-capture").disabled, false);
});

test("reader edits return the selected record and standalone files hide network actions", async () => {
  const env = setup();
  env.records.set(1, link(1, { type: "file", url: "pocketmark-file:opaque" }));
  await env.reader.open(1);
  assert.equal(env.get("reader-original").hidden, true);
  assert.equal(env.get("reader-capture").hidden, true);
  assert.equal(env.get("preserve-page").hidden, true);
  await fire(env.get("reader-edit"), "click");
  assert.equal(env.edits[0].id, 1);
  assert.equal(env.get("reader-dialog").open, false);
});


test("formatted-view response after switching documents cannot restore an old iframe", async () => {
  const head = deferred();
  const env = setup({ head: () => head.promise });
  env.assets.set(1, [{ id: 8, name: "page.html", mediaType: "text/html", size: 100 }]);
  await env.reader.open(1);
  const showing = fire(env.get("reader-layout-mode"), "click");
  await env.reader.open(2);
  head.resolve({ ok: true, status: 200 }); await showing;
  assert.equal(env.get("reader-title").textContent, "Page 2");
  assert.equal(env.get("reader-layout").hidden, true);
  assert.equal(env.get("reader-layout").src, "");
});

test("formatted view uses same-origin credentials and expires the reader on 401", async () => {
  const env = setup({ head: async () => ({ ok: false, status: 401 }) });
  env.records.set(1, link(1, { archiveAvailable: true }));
  await env.reader.open(1);
  await fire(env.get("reader-layout-mode"), "click");
  assert.equal(env.expired(), 1);
  assert.equal(env.get("reader-dialog").open, false);
  assert.equal(env.get("reader-layout").src, "");
  assert.equal(env.headCalls[0].options.credentials, "same-origin");
});

test("highlights use Unicode offsets and preserve edits made during annotation save", async () => {
  const save = deferred();
  const env = setup({ handler: (path, options, fallback) => options.method === "POST" ? save.promise : fallback() });
  const content = "A😀 café <img>";
  env.records.set(1, link(1, { content }));
  await env.reader.open(1);
  const root = env.get("reader-content"), text = root.children[0];
  const offset = content.indexOf("café");
  env.browser.getSelection = () => ({ rangeCount: 1, isCollapsed: false, getRangeAt: () => ({ startContainer: text, endContainer: text, startOffset: offset, toString: () => "café", cloneRange: () => ({ selectNodeContents() {}, setEnd() {}, toString: () => content.slice(0, offset) }) }) });
  await fire(env.get("reader-highlight"), "click");
  assert.equal(env.get("annotation-dialog").open, true);
  assert.equal(env.get("annotation-quote").textContent, "café");
  env.get("annotation-note").value = "Submitted note"; await fire(env.get("annotation-form"), "input");
  const saving = fire(env.get("annotation-form"), "submit");
  env.get("annotation-note").value = "Newer note"; await fire(env.get("annotation-form"), "input");
  const body = JSON.parse(env.calls.find(call => call.method === "POST").body);
  assert.equal(body.start, 3);
  assert.equal(body.end, 7);
  assert.equal(body.quote, "café");
  save.resolve({ id: 17 }); await saving;
  assert.equal(env.drafts.get("annotation:1:17").note, "Newer note");
  assert.equal(env.get("annotation-dialog").open, true);
  assert.equal(root.textContent, content);
});

test("a highlighted passage opens its annotation with keyboard activation", async () => {
  const env = setup();
  env.annotations.set(1, [{ id: 11, quote: "Text", start: 0, end: 4, note: "Remember this", color: "yellow" }]);
  await env.reader.open(1);
  const mark = env.get("reader-content").children[0];
  assert.equal(mark.attributes.role, "button");
  assert.equal(mark.attributes.tabindex, "0");
  assert.match(mark.attributes["aria-label"], /Edit highlight: Text/);
  let prevented = false;
  await fire(mark, "keydown", { key: "Enter", preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(env.get("annotation-dialog").open, true);
  assert.equal(env.get("annotation-note").value, "Remember this");
  env.get("annotation-dialog").close(); await tick();
  await fire(mark, "keydown", { key: " ", preventDefault: () => { prevented = true; } });
  assert.equal(env.get("annotation-dialog").open, true);
});

test("refreshing highlights preserves focus or returns it to the text when removed", async () => {
  const env = setup();
  env.annotations.set(1, [{ id: 11, quote: "Text", start: 0, end: 4, note: "Remember this", color: "yellow" }]);
  await env.reader.open(1);
  const root = env.get("reader-content");
  env.document.activeElement = root.children[0];
  await fire(env.get("annotations-retry"), "click");
  assert.equal(root.children[0].focused, true);
  env.document.activeElement = root.children[0];
  env.annotations.set(1, []);
  await fire(env.get("annotations-retry"), "click");
  assert.equal(root.focused, true);
});

test("annotation completion cannot close or overwrite another document's annotation", async () => {
  const save = deferred();
  const env = setup({ handler: (path, options, fallback) => options.method === "PUT" ? save.promise : fallback() });
  for (const id of [1, 2]) env.annotations.set(id, [{ id: id + 10, quote: "Text", start: 0, end: 4, note: `Note ${id}`, color: "yellow" }]);
  const editButton = () => env.get("annotation-list").children[0].children.at(-1).children[0];
  await env.reader.open(1);
  await fire(editButton(), "click");
  env.get("annotation-note").value = "Submitted for one"; await fire(env.get("annotation-form"), "input");
  const saving = fire(env.get("annotation-form"), "submit");
  await env.reader.open(2);
  await fire(editButton(), "click");
  env.get("annotation-note").value = "Draft for two"; await fire(env.get("annotation-form"), "input");
  save.resolve({ id: 11 }); await saving;
  assert.equal(env.get("annotation-dialog").open, true);
  assert.equal(env.get("annotation-note").value, "Draft for two");
  assert.equal(env.drafts.get("annotation:2:12").note, "Draft for two");
  assert.equal(env.get("annotation-form").querySelector("button[type=submit]").disabled, false);
});

for (const action of ["save", "delete"]) test(`${action} annotation remains successful when refreshing highlights fails`, async () => {
  let failRefresh = false;
  const env = setup({ handler: (path, options, fallback) => {
    if (path === "/api/links/1/annotations" && failRefresh) throw Error("Highlights unavailable");
    if (["PUT", "DELETE"].includes(options.method)) { failRefresh = true; return { id: 11 }; }
    return fallback();
  } });
  env.annotations.set(1, [{ id: 11, quote: "Text", start: 0, end: 4, note: "Old note", color: "yellow" }]);
  await env.reader.open(1);
  const actions = env.get("annotation-list").children[0].children.at(-1);
  assert.equal(actions.children[0].attributes["aria-label"], "Edit annotation: Text");
  assert.equal(actions.children[1].attributes["aria-label"], "Delete annotation: Text");
  if (action === "save") {
    await fire(actions.children[0], "click");
    env.get("annotation-note").value = "Updated note";
    await fire(env.get("annotation-form"), "submit");
    assert.equal(env.get("annotation-dialog").open, false);
  } else await fire(actions.children[1], "click");
  assert.match(env.notices.at(-1)[0], action === "save" ? /Annotation saved/ : /Annotation deleted/);
  assert.notEqual(env.notices.at(-1)[1], true);
  assert.equal(env.get("annotation-list").children.length, 0);
  assert.equal(env.get("annotations-retry").hidden, false);
  assert.match(env.get("annotations-error").textContent, /Highlights unavailable/);
  failRefresh = false;
  await fire(env.get("annotations-retry"), "click");
  assert.equal(env.get("annotations-error").hidden, true);
  assert.equal(env.get("annotations-retry").hidden, true);
  assert.match(env.get("annotation-list").textContent, /Old note/);
});

test("an old file upload cannot release another document's active upload control", async () => {
  const first = deferred(), second = deferred();
  const env = setup({ handler: (path, options, fallback) => options.method === "POST" && path.includes("/assets?") ? (path.includes("/1/") ? first.promise : second.promise) : fallback() });
  await env.reader.open(1);
  env.get("asset-file").files = [{ name: "one.pdf", size: 32, type: "application/pdf" }];
  const uploading = fire(env.get("asset-file"), "change");
  await env.reader.open(2);
  env.get("asset-file").files = [{ name: "two.pdf", size: 32, type: "application/pdf" }];
  const newer = fire(env.get("asset-file"), "change");
  first.resolve({ id: 18 }); await uploading;
  assert.equal(env.get("asset-file").disabled, true);
  assert.equal(env.get("asset-upload-button").attributes["aria-disabled"], "true");
  assert.equal(env.get("asset-upload-button").textContent, "Uploading file…");
  let chooserRequests = 0;
  env.get("asset-file").addEventListener("click", () => { chooserRequests++; });
  await fire(env.get("asset-upload-button"), "click");
  assert.equal(chooserRequests, 0);
  assert.equal(env.get("reader-title").textContent, "Page 2");
  second.resolve({ id: 19 }); await newer;
  assert.equal(env.get("asset-file").disabled, false);
  assert.equal(env.get("asset-upload-button").attributes["aria-disabled"], undefined);
  assert.equal(env.get("asset-upload-button").textContent, "Attach a saved file");
  await fire(env.get("asset-upload-button"), "click");
  assert.equal(chooserRequests, 1);
  assert.equal(env.calls.filter(call => call.path === "/api/links/1/assets").length, 1);
});

for (const action of ["upload", "preserve", "delete"]) test(`${action} remains successful when refreshing saved files fails`, async () => {
  let failRefresh = false;
  const env = setup({ handler: (path, options, fallback) => {
    if (path === "/api/links/1/assets" && failRefresh) throw Error("Files unavailable");
    if (options.method === "POST" || options.method === "DELETE") {
      failRefresh = true;
      return action === "preserve" ? { embedded: 2, omitted: 0 } : { id: 8 };
    }
    return fallback();
  } });
  env.assets.set(1, [{ id: 8, name: "old.pdf", mediaType: "application/pdf", size: 100 }]);
  await env.reader.open(1);
  if (action === "upload") {
    env.get("asset-file").files = [{ name: "new.pdf", size: 32, type: "application/pdf" }];
    await fire(env.get("asset-file"), "change");
  } else if (action === "preserve") await fire(env.get("preserve-page"), "click");
  else await fire(env.get("asset-list").children[0].children.find(node => node.textContent === "Delete"), "click");
  assert.match(env.notices.at(-1)[0], action === "delete" ? /File deleted/ : action === "preserve" ? /Page saved/ : /File saved/);
  assert.notEqual(env.notices.at(-1)[1], true);
  assert.equal(env.get("asset-list").children.length, 0);
  assert.equal(env.get("assets-retry").hidden, false);
  assert.match(env.get("assets-error").textContent, /Files unavailable/);
  failRefresh = false;
  await fire(env.get("assets-retry"), "click");
  assert.equal(env.get("assets-error").hidden, true);
  assert.equal(env.get("assets-retry").hidden, true);
  assert.match(env.get("asset-list").textContent, /old.pdf/);
});

test("the shipped script order and worker cache include the reader without private data", () => {
  const html = fs.readFileSync(`${__dirname}/static/index.html`, "utf8");
  const scripts = [...html.matchAll(/<script src="([^"]+)"[^>]*>/g)].map(match => match[1]);
  assert.ok(scripts.indexOf("/workspace.js") < scripts.indexOf("/reader.js"));
  assert.ok(scripts.indexOf("/reader.js") < scripts.indexOf("/app.js"));
  const vm = require("node:vm"), handlers = new Map();
  const context = vm.createContext({ self: { addEventListener: (name, handler) => handlers.set(name, handler) }, URL });
  vm.runInContext(fs.readFileSync(`${__dirname}/static/sw.js`, "utf8"), context);
  assert.equal(vm.runInContext('ASSETS.includes("/reader.js")', context), true);
  assert.equal(vm.runInContext('ASSETS.some(path => path.startsWith("/api/") || path === "/")', context), false);
  for (const pathname of ["/api/links/1", "/api/links/1/reader", "/"]) {
    let intercepted = false;
    context.self.location = { origin: "https://pocketmark.test" };
    handlers.get("fetch")({ request: { method: "GET", url: `https://pocketmark.test${pathname}` }, respondWith() { intercepted = true; } });
    assert.equal(intercepted, false);
  }
});
