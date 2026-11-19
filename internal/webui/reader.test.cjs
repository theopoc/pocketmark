"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { create } = require("../../frontend/src/features/reader.js").default;
const workspace = require("../../frontend/src/features/workspace.js").default;

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
  querySelectorAll(selector) {
    if (selector === "button") return this.children.filter(node => node.tagName === "BUTTON");
    return [];
  }
  contains(node) { for (; node; node = node.parentNode) if (node === this) return true; return false; }
  hasChildNodes() { return this.children.length > 0; }
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
function setup({ handler, head, breadcrumbs = () => [], confirmAction = async () => true } = {}) {
  const elements = new Map(), sections = [];
  const html = fs.readFileSync(`${__dirname}/static/index.html`, "utf8");
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)) elements.set(match[2], new Element(match[1], match[2]));
  for (const match of html.matchAll(/data-reader-section="([^"]+)"/g)) { const node = new Element("button"); node.dataset.readerSection = match[1]; sections.push(node); }
  const get = id => { assert.ok(elements.has(id), `unknown shipped element ${id}`); return elements.get(id); };
  get("reader-size").value = "17";
  get("reader-size").selectedOptions = [{ textContent: "S" }];
  const document = new Element("document");
  Object.assign(document, {
    getElementById: get, createElement: tag => new Element(tag), createTextNode: text => { const node = new Element("#text"); node.textContent = text; return node; }, createDocumentFragment: () => new Element("#fragment"),
    querySelectorAll: selector => selector === "[data-highlight-selection]" ? [get("reader-highlight"), get("annotate-selection")] : selector === "[data-reader-section]" ? sections : assert.fail(`unexpected selector ${selector}`),
  });
  const records = new Map([[1, link(1)], [2, link(2)]]), annotations = new Map(), assets = new Map(), calls = [], notices = [], changes = [], headCalls = [];
  const drafts = workspace.createDrafts();
  let expired = 0;
  const browser = { document, addEventListener: (...args) => document.addEventListener(...args), location: { origin: "https://pocketmark.test" }, matchMedia: () => ({ matches: true }), confirm: () => true, getSelection: () => null, Event: class { constructor(type) { this.type = type; } },
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
  const reader = create({ api, drafts, breadcrumbs, toast: (...args) => notices.push(args), confirmAction, onChange: async () => changes.push(true), onSessionExpired: () => expired++ }, browser);
  return { reader, get, sections, document, browser, records, annotations, assets, calls, notices, changes, headCalls, drafts, expired: () => expired };
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
  assert.equal(other.get("reader-format-html-status").textContent, "HTML · Not saved");
  assert.equal(other.get("reader-format-html").disabled, true);
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
  assert.equal(env.get("reader-rich-article").children.length, 0);
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
  for (const id of ["reader-section-nav", "reader-content", "annotations-section", "reader-rich-article"]) assert.equal(env.get(id).hidden, true);
  failing = false;
  await fire(env.get("reader-retry-open"), "click");
  await tick();
  assert.equal(env.get("reader-title").textContent, "Page 1");
  assert.equal(env.get("reader-retry-open").hidden, true);
  for (const id of ["reader-section-nav", "reader-content", "reader-text-panel"]) assert.equal(env.get(id).hidden, false);
  for (const id of ["annotations-section", "reader-rich-article", "reader-notebook"]) assert.equal(env.get(id).hidden, true);
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
  assert.equal(env.get("reader-formats-retry").hidden, false);
  assert.equal(env.get("annotations-error").hidden, true);
  fail = false;
  await fire(env.get("reader-formats-retry"), "click");
  assert.equal(env.get("reader-formats-error").hidden, true);
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
  assert.equal(env.get("reader-retry-capture").attributes["aria-disabled"], "true");
  await fire(env.get("reader-retry-capture"), "click");
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
  assert.equal(env.get("reader-rich-article").children.length, 0);
});

test("a late attachment read cannot replace the current bookmark", async () => {
  const response = deferred();
  const env = setup({ head: () => response.promise });
  env.assets.set(1, [{ id: 8, name: "article.html", mediaType: "text/html", size: 100 }]);
  await env.reader.open(1);
  const request = env.headCalls[0];
  assert.equal(request.path, "/api/assets/8");
  assert.equal(request.options.credentials, "same-origin");
  assert.equal(env.get("reader-content").hidden, false);
  await env.reader.open(2);
  assert.equal(request.options.signal.aborted, true);
  response.resolve({ok: true, body: null});
  await tick();
  assert.equal(env.get("reader-title").textContent, "Page 2");
  assert.equal(env.get("reader-rich-article").children.length, 0);
});

test("saved files open images, PDF and sandboxed original HTML in the integrated viewer", async () => {
  const env = setup();
  env.assets.set(1, [
    { id: 8, name: "Full page.png", mediaType: "image/png", size: 100 },
    { id: 9, name: "Printed.pdf", mediaType: "application/pdf", size: 100 },
    { id: 10, name: "Large page.html", mediaType: "text/html", size: 3 * 1024 * 1024 },
  ]);
  await env.reader.open(1);
  await fire(env.get("reader-format-image"), "click");
  await tick();
  assert.equal(env.get("asset-viewer").open, true);
  assert.equal(env.get("asset-viewer-select").children.length, 1);
  let content = env.get("asset-viewer-content").children[0];
  assert.equal(content.tagName, "IMG");
  assert.equal(content.src, "/api/assets/8/view");
  assert.equal(env.get("asset-viewer-download").href, "/api/assets/8");
  await fire(content, "load");
  assert.equal(env.get("asset-viewer-status").textContent, "Full page.png");
  await fire(env.get("reader-format-pdf"), "click");
  await tick();
  content = env.get("asset-viewer-content").children[0];
  assert.equal(content.tagName, "IFRAME");
  assert.equal(content.src, "/api/assets/9/view");
  assert.equal(content.attributes.sandbox, undefined, "native PDF plugin must remain usable");
  await fire(env.get("reader-format-html"), "click");
  await tick();
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
  await fire(env.get("reader-format-html"), "click");
  await fire(env.get("reader-format-image"), "click");
  await tick();
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
  await fire(env.get("reader-format-html"), "click");
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
  const pending = fire(env.get("reader-retry-capture"), "click");
  await env.reader.open(2);
  capture.resolve({ ok: true }); await pending;
  assert.equal(env.get("reader-status").textContent, "");
  assert.equal(env.get("reader-recheck").hidden, true);
  assert.equal(env.get("reader-retry-capture").attributes["aria-disabled"], undefined);
});

test("standalone files expose available copies and hide network actions", async () => {
  const env = setup();
  env.records.set(1, link(1, { type: "file", url: "pocketmark-file:opaque" }));
  env.assets.set(1, [{ id: 9, name: "book.pdf", mediaType: "application/pdf", size: 200 }]);
  await env.reader.open(1);
  assert.equal(env.get("reader-source").textContent, "Saved file");
  assert.equal(env.get("reader-original").hidden, true);
  assert.equal(env.get("reader-retry-capture").hidden, true);
  assert.equal(env.get("reader-format-pdf").disabled, false);
});

test("an expired saved article request clears the active reader after switching bookmarks", async () => {
  const response = deferred();
  const env = setup({ head: () => response.promise });
  env.records.set(1, link(1, { archiveAvailable: true }));
  await env.reader.open(1);
  await env.reader.open(2);
  response.resolve({ ok: false, status: 401 });
  await tick();
  assert.equal(env.expired(), 1);
  assert.equal(env.get("reader-dialog").open, false);
  assert.equal(env.get("reader-rich-article").children.length, 0);
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

test("rich selections use canonical Unicode offsets and discard ambiguous selections", async () => {
  const env = setup({ handler: (path, options, fallback) => options.method === "POST" ? { id: 18 } : fallback() });
  env.records.set(1, link(1, { content: "😀 café then café unique" }));
  await env.reader.open(1);
  const rich = env.get("reader-rich-article");
  rich.hidden = false;
  const node = env.document.createTextNode("café and unique");
  rich.append(node);
  let quote = "unique";
  env.browser.getSelection = () => ({ rangeCount: 1, isCollapsed: false, getRangeAt: () => ({ startContainer: node, endContainer: node, toString: () => quote }) });
  await fire(env.document, "selectionchange");
  assert.equal(env.get("reader-highlight").hidden, false);
  quote = "café";
  await fire(env.document, "selectionchange");
  assert.equal(env.get("reader-highlight").hidden, true);
  await fire(env.get("annotate-selection"), "click");
  assert.equal(env.get("annotation-dialog").open, false);
  quote = "unique";
  await fire(env.get("reader-highlight"), "click");
  assert.equal(env.get("annotation-quote").textContent, "unique");
  await fire(env.get("annotation-form"), "submit");
  const body = JSON.parse(env.calls.find(call => call.method === "POST").body);
  assert.equal(body.start, 17);
  assert.equal(body.end, 23);
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

test("the accessible highlighted passage retains its complete text", async () => {
  const env = setup(), quote = "A".repeat(120) + " ending";
  env.records.set(1, link(1, { content: quote }));
  env.annotations.set(1, [{ id: 11, quote, start: 0, end: quote.length, color: "yellow" }]);
  await env.reader.open(1);
  assert.equal(env.get("reader-content").children[0].attributes["aria-label"], `Edit highlight: ${quote}`);
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

test("refreshing the annotation list preserves the focused edit action", async () => {
  const env = setup();
  env.annotations.set(1, [{ id: 11, quote: "Text", start: 0, end: 4, note: "Remember this", color: "yellow" }]);
  await env.reader.open(1);
  const edit = () => env.get("annotation-list").children[0].children.at(-1).children[0];
  env.document.activeElement = edit();
  await fire(env.get("annotations-retry"), "click");
  assert.equal(edit().focused, true);
  env.document.activeElement = edit();
  env.annotations.set(1, []);
  await fire(env.get("annotations-retry"), "click");
  assert.equal(env.get("annotations-section").focused, true);
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

test("cancelled or stale reader confirmations do not delete an annotation", async () => {
  const pending = deferred();
  let answer = async () => false;
  const env = setup({ confirmAction: (...args) => answer(...args) });
  env.annotations.set(1, [{ id: 11, quote: "Text", start: 0, end: 4, note: "", color: "yellow" }]);
  await env.reader.open(1);
  const remove = env.get("annotation-list").children[0].children.at(-1).children[1];
  await fire(remove, "click");
  assert.equal(env.calls.some(call => call.method === "DELETE"), false);
  answer = () => pending.promise;
  const deleting = fire(remove, "click");
  await env.reader.open(2);
  pending.resolve(true);
  await deleting;
  assert.equal(env.calls.some(call => call.method === "DELETE"), false);
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

test("the shipped script order and worker cache include the reader without private data", () => {
  const html = fs.readFileSync(`${__dirname}/static/index.html`, "utf8");
  require("./bundle-helper.cjs").assertBundledModule("reader");
  const vm = require("node:vm"), handlers = new Map();
  const context = vm.createContext({ self: { addEventListener: (name, handler) => handlers.set(name, handler) }, URL });
  vm.runInContext(fs.readFileSync(`${__dirname}/static/sw.js`, "utf8"), context);
  assert.equal(vm.runInContext('ASSETS.some(path => path.startsWith("/api/") || path === "/")', context), false);
  for (const pathname of ["/api/links/1", "/api/links/1/reader", "/"]) {
    let intercepted = false;
    context.self.location = { origin: "https://pocketmark.test" };
    handlers.get("fetch")({ request: { method: "GET", url: `https://pocketmark.test${pathname}` }, respondWith() { intercepted = true; } });
    assert.equal(intercepted, false);
  }
});


test("article text opens first; optional notebook navigation preserves reading and notes", async () => {
  const env = setup();
  await env.reader.open(1);
  assert.equal(env.get("reader-notebook").hidden, true);
  assert.equal(env.get("reader-original").href, "https://example.com/1");
  assert.equal(env.get("reader-original").hidden, false);
  assert.equal(env.get("reader-formats").hidden, false);
  assert.equal(env.get("reader-content").hidden, false);
  assert.equal(env.get("reader-rich-article").hidden, true);
  assert.equal(env.headCalls.length, 0, "a text-only bookmark has no attachment payload to load");
  for (const format of ["html", "image", "pdf"]) {
    assert.equal(env.get(`reader-format-${format}`).disabled, true);
    assert.equal(env.get(`reader-format-${format}`).hidden, false);
    assert.match(env.get(`reader-format-${format}-status`).textContent, /Not saved/);
  }
  assert.equal(env.get("reader-content").hidden, false);
  env.get("reader-text-panel").scrollTop = 350;
  env.get("reader-notebook-toggle").click();
  assert.equal(env.get("reader-notebook").hidden, false);
  const panels = ["reader-notes-form", "annotations-section"];
  function selected(index) {
    assert.equal(env.get("reader-text-panel").hidden, false);
    assert.equal(env.get("reader-original").hidden, false);
    panels.forEach((id, i) => assert.equal(env.get(id).hidden, i !== index));
    env.sections.forEach((tab, i) => {
      assert.equal(tab.attributes["aria-selected"], String(i === index));
      assert.equal(tab.tabIndex, i === index ? 0 : -1);
    });
  }
  selected(0);
  env.get("reader-notes").value = "Unfinished thought";
  await fire(env.get("reader-notes"), "input");
  await fire(env.sections[0], "keydown", { key: "End" }); selected(1);
  await fire(env.sections[1], "keydown", { key: "ArrowRight" }); selected(0);
  await fire(env.sections[0], "keydown", { key: "ArrowLeft" }); selected(1);
  await fire(env.sections[1], "keydown", { key: "Home" }); selected(0);
  await fire(env.sections[0], "keydown", { key: "ArrowRight" }); selected(1);
  env.get("reader-notebook-close").click();
  assert.equal(env.get("reader-notebook").hidden, true);
  assert.equal(env.get("reader-text-panel").scrollTop, 350);
  assert.equal(env.get("reader-notes").value, "Unfinished thought");
  assert.equal(env.get("reader-notebook-toggle").focused, true);
  env.get("reader-notebook-toggle").click();
  await env.reader.open(1, true);
  assert.equal(env.get("reader-notebook").hidden, false);
  selected(1);
  assert.equal(env.get("reader-text-panel").scrollTop, 350);
  await env.reader.open(2);
  assert.equal(env.get("reader-notebook").hidden, true);
  assert.equal(env.get("reader-content").hidden, false);
  selected(0);
});

test("format shortcuts open the newest copy and retain earlier copies of that format", async () => {
  const env = setup();
  env.records.set(1, link(1, { status: "failed", archiveAvailable: true }));
  env.assets.set(1, [
    { id: 8, name: "old.html", mediaType: "text/html", size: 100 },
    { id: 11, name: "new.html", mediaType: "text/html", size: 3 * 1024 * 1024 },
    { id: 9, name: "page.png", mediaType: "image/png", size: 100 },
    { id: 10, name: "page.pdf", mediaType: "application/pdf", size: 100 },
  ]);
  await env.reader.open(1);
  assert.equal(env.get("reader-content").hidden, false);
  assert.equal(env.get("reader-format-html-status").textContent, "Open saved HTML · 2 copies");
  assert.equal(env.get("reader-format-html").hidden, false);
  for (const [format, latest, copies, source] of [["html", "11", 2, "/asset-preview.html"], ["image", "9", 1, "/api/assets/9/view"], ["pdf", "10", 1, "/api/assets/10/view"]]) {
    assert.equal(env.get(`reader-format-${format}`).disabled, false, "failed page capture must not hide successful files");
    env.get(`reader-format-${format}`).click();
    await tick();
    assert.equal(env.get("asset-viewer-select").value, latest);
    assert.equal(env.get("asset-viewer-select").children.length, copies);
    assert.equal(env.get("asset-viewer-content").children[0].src, source);
    if (format === "html") {
      env.get("asset-viewer-select").value = "8";
      await fire(env.get("asset-viewer-select"), "change");
      assert.equal(env.get("asset-viewer-download").href, "/api/assets/8");
    }
    env.get("asset-viewer-close").click();
    await tick();
  }
});

test("basic HTML archives remain available without attachments and use the sandboxed reader", async () => {
  const files = deferred();
  const env = setup({ handler: (path, options, fallback) => path.endsWith("/assets") ? files.promise : fallback() });
  env.records.set(1, link(1, { archiveAvailable: true }));
  const opening = env.reader.open(1);
  await tick();
  assert.equal(env.get("reader-format-html-status").textContent, "HTML · Checking…");
  assert.equal(env.get("reader-format-html").disabled, true, "wait for attachments before choosing the basic archive");
  files.resolve([]);
  await opening;
  assert.equal(env.get("reader-format-html-status").textContent, "Open saved HTML");
  env.get("reader-format-html").click();
  await tick();
  const frame = env.get("asset-viewer-content").children[0];
  assert.equal(frame.src, "/api/links/1/reader");
  assert.equal(frame.attributes.sandbox, "");
  assert.equal(env.get("asset-viewer-download").href, "/api/links/1/archive");
  assert.match(env.get("asset-viewer-hint").textContent, /simplified/);
});

test("format states distinguish loading and failed checks from absent files, with a direct retry", async () => {
  const files = deferred();
  let failing = true;
  const env = setup({ handler: (path, options, fallback) => path.endsWith("/assets") && failing ? files.promise : fallback() });
  const opening = env.reader.open(1);
  await tick();
  assert.equal(env.get("reader-format-pdf-status").textContent, "PDF · Checking…");
  files.reject(Error("Files unavailable"));
  await opening;
  assert.equal(env.get("reader-format-pdf-status").textContent, "PDF · Unknown");
  assert.equal(env.get("reader-formats-error").hidden, false);
  assert.equal(env.get("reader-formats-retry").hidden, false);
  failing = false;
  env.assets.set(1, [{ id: 8, name: "document.pdf", mediaType: "application/pdf", size: 100 }]);
  env.get("reader-formats-retry").click();
  await tick();
  assert.equal(env.get("reader-format-pdf-status").textContent, "Open saved PDF");
  assert.equal(env.get("reader-format-html-status").textContent, "HTML · Not saved");
  assert.equal(env.get("reader-formats-error").hidden, true);
  assert.equal(env.get("reader-formats-retry").hidden, true);
  await env.reader.open(2);
  assert.equal(env.get("reader-format-pdf-status").textContent, "PDF · Not saved");
  assert.equal(env.get("reader-format-pdf").disabled, true);
});

test("full-page reading preserves the source path and Escape returns to the same bookmark", async () => {
  let returned = 0;
  const env = setup({ breadcrumbs: () => [
    { key:"root", label:"My library", action:()=>{returned++} },
    { key:"current", label:"Favorites", action:()=>assert.fail("parent must preserve current filter") },
  ] });
  await env.reader.open(1);
  const toggle = env.get("reader-page-toggle"), dialog = env.get("reader-dialog"), trail = env.get("reader-page-breadcrumb");
  const panel = env.get("reader-text-panel"), paragraph = new Element("p");
  panel.append(paragraph);
  panel.scrollTop = 100;
  panel.getBoundingClientRect = () => ({ left: 0, width: 600, top: 80 });
  paragraph.closest = () => paragraph;
  paragraph.getBoundingClientRect = () => ({ top: (dialog.dataset.layout === "page" ? 135 : 155) - panel.scrollTop });
  env.document.elementFromPoint = () => paragraph;
  toggle.click();
  assert.equal(panel.scrollTop, 80);
  assert.equal(dialog.dataset.layout, "page");
  assert.equal(trail.hidden, false);
  assert.deepEqual(trail.querySelectorAll("button").map(node => node.textContent), ["My library","Favorites"]);
  assert.equal(trail.children.at(-1).textContent, "Page 1");
  assert.equal(trail.children.at(-1).attributes["aria-current"], "page");
  await fire(dialog,"cancel");
  assert.equal(panel.scrollTop, 100);
  assert.equal(dialog.open,true);
  assert.equal(dialog.dataset.layout, "panel");
  assert.equal(trail.hidden, true);
  assert.equal(toggle.focused,true);
  toggle.click();
  trail.querySelectorAll("button")[0].click();
  assert.equal(dialog.open,false);
  assert.equal(returned,1);
});

test("an empty or failed capture keeps a direct original link and distinguishes absent article text", async () => {
  const env = setup();
  env.records.set(1, link(1, { content: "", description: "Only a bookmark summary", status: "failed" }));
  await env.reader.open(1);
  assert.match(env.get("reader-content").textContent, /No article text was saved/);
  assert.doesNotMatch(env.get("reader-content").textContent, /Only a bookmark summary/);
  assert.equal(env.get("reader-original").href, "https://example.com/1");
  assert.equal(env.get("reader-original").hidden, false);
  assert.equal(env.get("reader-notebook").hidden, true);
});

test("show in text restores an anchored passage without losing the article position in a notebook switch", async () => {
  const env = setup();
  env.annotations.set(1, [
    { id: 11, quote: "Text", start: 0, end: 4, note: "Remember this", color: "yellow" },
    { id: 12, quote: "Old", start: 0, end: 3, color: "blue", stale: true },
  ]);
  await env.reader.open(1);
  env.sections[1].click();
  const rows = env.get("annotation-list").children;
  const show = rows[0].children.at(-1).children.find(node => node.textContent === "Show in text");
  assert.ok(show);
  assert.equal(rows[1].children.at(-1).children.some(node => node.textContent === "Show in text"), false);
  show.click();
  const mark = env.get("reader-content").children[0];
  assert.equal(mark.focused, true);
  assert.equal(mark.scrollOptions.block, "center");
  assert.equal(env.get("reader-notebook").hidden, true);
});
