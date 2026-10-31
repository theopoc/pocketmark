"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");
const { create } = require("./static/tag-picker.js"), workspace = require("./static/workspace.js");
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
class Event {
  constructor(type, values = {}) { Object.assign(this, { type, bubbles: false, detail: 0 }, values); }
  preventDefault() { this.defaultPrevented = true; } stopPropagation() { this.stopped = true; }
}
// Minimal event/DOM adapter for both shipped form hosts. Timers and network are controlled.
class Element {
  constructor(tag, document) { Object.assign(this, { tagName: tag.toUpperCase(), document, children: [], parentNode: null, events: new Map(), attributes: {}, dataset: {}, style: {}, className: "", value: "", hidden: false, open: false, offsetHeight: 20, text: "" }); }
  get form() { return this.closest("form"); }
  set textContent(text) { this.text = String(text); this.children = []; } get textContent() { return this.text + this.children.map(node => node.textContent).join(""); }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); } }
  remove() { if (this.parentNode) { const items = this.parentNode.children; items.splice(items.indexOf(this), 1); this.parentNode = null; } }
  insertBefore(node, reference) { node.remove(); node.parentNode = this; this.children.splice(this.children.indexOf(reference), 0, node); }
  before(node) { this.parentNode.insertBefore(node, this); } after(node) { const parent = this.parentNode, next = parent.children[parent.children.indexOf(this) + 1]; if (next) parent.insertBefore(node, next); else parent.append(node); }
  replaceChildren(...nodes) { for (const child of [...this.children]) child.remove(); this.text = ""; this.append(...nodes); }
  addEventListener(type, fn) { if (!this.events.has(type)) this.events.set(type, []); this.events.get(type).push(fn); }
  dispatchEvent(event) { if (!event.target) event.target = this; for (const fn of this.events.get(event.type) || []) fn(event); if (event.bubbles && !event.stopped) this.parentNode?.dispatchEvent(event); return !event.defaultPrevented; }
  setAttribute(key, value) { this.attributes[key] = String(value); } removeAttribute(key) { delete this.attributes[key]; }
  closest(tag) { for (let node = this; node; node = node.parentNode) if (tag.startsWith(".") ? node.className.split(" ").includes(tag.slice(1)) : node.tagName === tag.toUpperCase()) return node; return null; }
  contains(node) { for (; node; node = node.parentNode) if (node === this) return true; return false; }
  querySelectorAll(selector) { assert.ok(selector.startsWith('.')); const name = selector.slice(1), result = []; for (const child of this.children) { if (child.className.split(' ').includes(name)) result.push(child); result.push(...child.querySelectorAll(selector)); } return result; }
  focus() { if (this.document.activeElement === this) return; const previous = this.document.activeElement; this.document.activeElement = this; previous?.dispatchEvent(new Event('focusout', { bubbles: true, relatedTarget: this })); this.dispatchEvent(new Event('focus')); }
  click() { this.dispatchEvent(new Event('click', { bubbles: true })); }
  getBoundingClientRect() { return { top: 30, bottom: 350, left: 0 }; } scrollIntoView() { this.scrolled = true; }
  reset() { this.dispatchEvent(new Event('reset')); } close() { this.open = false; queueMicrotask(() => this.dispatchEvent(new Event('close'))); }
}
function setup(handler) {
  const html = fs.readFileSync(`${__dirname}/static/index.html`, 'utf8'), tasks = new Map(), calls = [], labels = new Map(), hosts = new Map(); let sequence = 0;
  const document = { roots: [], createElement(tag) { return new Element(tag, document); }, querySelector(selector) { return labels.get(selector.match(/for="([^"]+)"/)[1]); }, getElementById(id) { const search = node => node.id === id ? node : node.children.map(search).find(Boolean); return this.roots.map(search).find(Boolean) || null; } };
  const browser = { document, Event, matchMedia: () => ({ matches: true }), addEventListener() {}, setTimeout(fn) { const key = ++sequence; tasks.set(key, fn); return key; }, clearTimeout(key) { tasks.delete(key); } };
  const drafts = workspace.createDrafts();
  for (const id of ['bookmark-tags', 'bulk-tags']) {
    assert.ok(html.includes(`id="${id}"`));
    const dialog = new Element('dialog', document), form = new Element('form', document), source = new Element('input', document), label = new Element('label', document); source.id = id; dialog.open = true;
    document.roots.push(dialog); dialog.append(form); form.append(label, source); labels.set(id, label);
    form.addEventListener('input', () => drafts.put(id, { notes: 'Keep note', tags: source.value }, {}));
    const picker = create({ id, api: async path => { calls.push(path); return handler ? handler(path) : path.includes('browse') ? { tags: [{ name: 'reference', count: 2 }], total: 1 } : [{ name: 'reference', count: 2 }]; }, icon: () => new Element('svg', document) }, browser);
    hosts.set(id, { picker, dialog, form, source, input: document.getElementById(id + '-query'), panel: form.querySelectorAll('.tag-picker-panel')[0], list: form.querySelectorAll('.tag-picker-options')[0], retry: form.querySelectorAll('.tag-picker-retry')[0], field: form.querySelectorAll('.tag-picker-field')[0] });
  }
  const flush = async () => { const pending = [...tasks.values()]; tasks.clear(); await Promise.all(pending.map(fn => fn())); };
  const fire = (node, type, values = {}) => { const event = new Event(type, { bubbles: true, ...values }); node.dispatchEvent(event); return event; };
  return { host: hosts.get('bookmark-tags'), bulk: hosts.get('bulk-tags'), calls, document, drafts, flush, fire, browser };
}
test('both form hosts use independent selections, labels and native reset events', () => {
  const { host, bulk } = setup(); host.picker.set(['saved']); bulk.picker.set(['bulk']);
  assert.equal(host.source.value, 'saved'); assert.equal(bulk.source.value, 'bulk'); assert.equal(host.input.attributes.role, 'combobox');
  assert.equal(host.input.attributes['aria-controls'], host.list.id);
  host.form.reset(); assert.equal(host.source.value, ''); assert.equal(bulk.source.value, 'bulk');
});
test('typing and comma paste retain Unicode tags and bubble draft input without losing notes', () => {
  const env = setup(), { host, fire } = env; host.picker.set(['saved']); host.input.value = 'go, café, 読書'; fire(host.input, 'input');
  assert.equal(host.source.value, 'saved, go, café, 読書'); assert.equal(host.input.value, '読書');
  fire(host.input, 'keydown', { key: 'Tab' }); assert.equal(host.input.value, '');
  assert.deepEqual(env.drafts.get('bookmark-tags'), { notes: 'Keep note', tags: 'saved, go, café, 読書' });
});
test('IME Enter does not choose or submit while composition is active', () => {
  const { host, fire } = setup(); host.input.value = '読書'; fire(host.input, 'input', { isComposing: true });
  const composing = fire(host.input, 'keydown', { key: 'Enter', isComposing: true }); assert.equal(composing.defaultPrevented, undefined); assert.equal(host.input.value, '読書');
  fire(host.input, 'compositionend'); const committed = fire(host.input, 'keydown', { key: 'Enter' });
  assert.equal(committed.defaultPrevented, true); assert.equal(host.source.value, '読書'); assert.equal(host.input.value, '');
});
test('keyboard suggestions expose active option and choose it; Escape consumes no stale option', async () => {
  const env = setup(), { host, fire } = env; host.input.focus(); await env.flush();
  fire(host.input, 'keydown', { key: 'ArrowDown' }); assert.equal(host.input.attributes['aria-activedescendant'], 'bookmark-tags-option-0');
  fire(host.input, 'keydown', { key: 'Enter' }); assert.equal(host.source.value, 'reference');
  host.input.value = 'custom'; fire(host.input, 'input'); await env.flush(); fire(host.input, 'keydown', { key: 'ArrowDown' });
  const escaped = fire(host.input, 'keydown', { key: 'Escape' }); assert.equal(escaped.stopped, true); assert.equal(host.input.attributes['aria-expanded'], 'false');
  fire(host.input, 'keydown', { key: 'Enter' }); assert.equal(host.source.value, 'reference, custom');
});
test('backspace focuses the last chip and Delete removes it without removing other tags', () => {
  const env = setup(), { host, fire } = env; host.picker.set(['first', 'second']); host.input.focus();
  fire(host.input, 'keydown', { key: 'Backspace' }); const remove = host.field.querySelectorAll('.tag-picker-remove').at(-1); assert.equal(env.document.activeElement, remove);
  fire(remove, 'keydown', { key: 'Delete' }); assert.equal(host.source.value, 'first');
});
test('reversed suggestion responses cannot replace the current query', async () => {
  const first = deferred(), second = deferred(), env = setup(path => path.endsWith('q=old') ? first.promise : second.promise), { host, fire } = env;
  host.input.value = 'old'; fire(host.input, 'input'); const a = env.flush();
  host.input.value = 'new'; fire(host.input, 'input'); const b = env.flush();
  second.resolve({ tags: [{ name: 'new-tag', count: 2 }], total: 1 }); await b;
  first.resolve({ tags: [{ name: 'old-tag', count: 2 }], total: 1 }); await a;
  assert.match(host.list.textContent, /new-tag/); assert.doesNotMatch(host.list.textContent, /old-tag/);
});
test('closed or reset dialogs ignore late suggestions and a queued close cannot hide a reopened picker', async () => {
  const request = deferred(), env = setup(() => request.promise), { host } = env;
  host.input.focus(); const pending = env.flush(); host.dialog.close(); host.form.reset();
  host.dialog.open = true; host.input.value = 'reopened'; env.fire(host.input, 'input');
  request.resolve([{ name: 'old', count: 1 }]); await pending;
  assert.equal(host.panel.hidden, false); assert.equal(host.list.children.length, 0); assert.equal(host.input.value, 'reopened');
});
test('suggestion failures offer retry and preserve typed and selected tags', async () => {
  let failing = true; const env = setup(async () => { if (failing) throw Error('Offline'); return { tags: [], total: 0 }; }), { host } = env;
  host.picker.set(['saved']); host.input.focus(); host.input.value = 'custom'; env.fire(host.input, 'input'); await env.flush();
  assert.equal(host.retry.hidden, false); assert.equal(host.source.value, 'saved, custom');
  env.fire(host.input, 'keydown', { key: 'Tab' }); host.retry.focus();
  assert.equal(host.panel.hidden, false); assert.equal(host.input.value, 'custom');
  failing = false; host.retry.click(); await env.flush(); assert.equal(host.retry.hidden, true); assert.match(host.list.textContent, /custom/);
});
test('focus leaving the field commits pending text and closes suggestions', () => {
  const env = setup(), { host } = env; host.input.focus(); host.input.value = 'pending'; env.fire(host.input, 'input');
  env.bulk.input.focus(); assert.equal(host.source.value, 'pending'); assert.equal(host.panel.hidden, true); assert.equal(host.input.value, '');
});
test('late failed suggestions cannot reopen a closed dialog or enable retry', async () => {
  const request = deferred(), env = setup(() => request.promise), { host } = env;
  host.input.focus(); const pending = env.flush(); host.dialog.close(); request.reject(Error('Offline')); await pending;
  assert.equal(host.panel.hidden, true); assert.equal(host.retry.hidden, true);
});
test('suggestion rendering stays bounded without truncating selected tags', async () => {
  const env = setup(() => ({ tags: Array.from({ length: 30 }, (_, i) => ({ name: 'option-' + i, count: 1 })), total: 300 })), { host } = env;
  const tags = Array.from({ length: 100 }, (_, i) => 'selected-' + i); host.picker.set(tags); host.input.value = 'query'; env.fire(host.input, 'input'); await env.flush();
  assert.equal(host.list.children.length, 13); assert.equal(host.field.querySelectorAll('.tag-picker-chip').length, 100); assert.equal(host.source.value, [...tags, 'query'].join(', '));
});
test('the shipped shell loads and caches the selector before app without private data', () => {
  const html = fs.readFileSync(`${__dirname}/static/index.html`, 'utf8'), scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(match => match[1]);
  assert.ok(scripts.includes('/tag-picker.js')); assert.ok(scripts.indexOf('/tag-picker.js') < scripts.indexOf('/app.js'));
  const context = vm.createContext({ self: { addEventListener() {} } }); vm.runInContext(fs.readFileSync(`${__dirname}/static/sw.js`, 'utf8'), context);
  assert.equal(vm.runInContext('ASSETS.includes("/tag-picker.js")', context), true); assert.equal(vm.runInContext('ASSETS.some(path => path === "/" || path.startsWith("/api/"))', context), false);
});

test('suggestions use the scrolling form body rather than the larger dialog bounds', async () => {
  const env = setup(), { host } = env;
  const scroller = new Element('div', env.document); scroller.className = 'bookmark-form-body';
  const picker = host.field.parentNode; host.form.append(scroller); scroller.append(picker);
  host.dialog.getBoundingClientRect = () => ({ top: 0, bottom: 900 });
  scroller.getBoundingClientRect = () => ({ top: 200, bottom: 500 });
  host.field.getBoundingClientRect = () => ({ top: 220, bottom: 264 });
  host.input.focus(); await env.flush();
  assert.equal(host.panel.dataset.side, 'below');
  assert.equal(host.list.style.maxHeight, '176px');
  host.field.getBoundingClientRect = () => ({ top: 380, bottom: 424 });
  env.fire(host.dialog, 'scroll');
  assert.equal(host.panel.dataset.side, 'above');
  assert.equal(host.list.style.maxHeight, '120px');
  scroller.getBoundingClientRect = () => ({ top: 350, bottom: 460 });
  env.fire(host.dialog, 'scroll');
  assert.equal(host.panel.dataset.side, 'inline');
});
