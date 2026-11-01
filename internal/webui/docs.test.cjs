const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

const source = readFileSync(`${__dirname}/static/api-docs/docs.js`, 'utf8');

async function loadDocs({ responseOK = true, invalidJSON = false, bundle = true } = {}) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      hidden: false, attributes: {}, events: {},
      setAttribute(key, value) { this.attributes[key] = value; },
      getAttribute(key) { return this.attributes[key] ?? null; },
      addEventListener(event, handler) { this.events[event] = handler; },
      querySelector(selector) { return element(selector === '.operation-filter-input' ? 'filter' : 'auth-close'); },
      querySelectorAll() { return []; },
    });
    return elements.get(id);
  }
  element('docs-error').hidden = true;
  const document = {
    documentElement: { dataset: { theme: 'dark' } },
    getElementById: element,
    querySelector: element,
  };
  let config;
  let mutation;
  let reloads = 0;
  const requests = [];
  const spec = { openapi: '3.0.3', paths: {} };
  const SwaggerUIBundle = bundle ? Object.assign(options => { config = options; options.onComplete(); }, { presets: { apis: {} } }) : undefined;
  vm.runInNewContext(source, {
    document,
    PocketmarkThemeSwitch: { create: options => require("./static/theme-switch.js").create(options, { document }) },
    window: { SwaggerUIBundle },
    MutationObserver: class { constructor(callback) { mutation = callback; } observe() { mutation(); } disconnect() {} },
    localStorage: { setItem() { throw new Error('storage denied'); } },
    location: { reload() { reloads++; } },
    fetch: async (...args) => {
      requests.push(args);
      return { ok: responseOK, json: async () => { if (invalidJSON) throw new Error('invalid JSON'); return spec; } };
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  return { elements, document, config, requests, spec, reloads: () => reloads, mutation: () => mutation(), element };
}

test('docs use the local spec without external validation, URL overrides or saved authorization', async () => {
  const { config, requests, spec, elements } = await loadDocs();
  assert.equal(requests.length, 1);
  assert.equal(requests[0][0], '/api-docs/openapi.json');
  assert.equal(config.spec, spec);
  assert.equal(config.validatorUrl, null);
  assert.equal(config.persistAuthorization, false);
  assert.equal(config.queryConfigEnabled, false);
  assert.equal(config.tryItOutEnabled, false);
  assert.equal(elements.get('docs-status').hidden, true);
  assert.equal(elements.get('swagger-ui').attributes['aria-busy'], 'false');
  assert.equal(elements.get('filter').attributes['aria-label'], 'Filter API operations');
  assert.equal(elements.get('auth-close').attributes['aria-label'], 'Close authorizations');
  const wrap = config.plugins[0]().statePlugins.auth.wrapSelectors.definitionsToAuthorize;
  const bearer = { has: () => false };
  const cookie = { has: () => true };
  assert.deepEqual(Array.from(wrap(() => [bearer, cookie])()), [bearer]);
});

test('docs explain load failures and offer retry or the raw specification', async () => {
  for (const options of [{ responseOK: false }, { invalidJSON: true }, { bundle: false }]) {
    const view = await loadDocs(options);
    assert.equal(view.elements.get('docs-error').hidden, false);
    assert.equal(view.elements.get('docs-status').hidden, true);
    assert.equal(view.elements.get('swagger-ui').attributes['aria-busy'], 'false');
    view.elements.get('docs-retry').events.click();
    assert.equal(view.reloads(), 1);
  }
});

test('theme switching remains usable when browser storage is denied', async () => {
  const { elements, document } = await loadDocs();
  const button = elements.get('docs-theme');
  button.events.click();
  assert.equal(document.documentElement.dataset.theme, 'light');
  assert.equal(button.attributes['aria-pressed'], 'false');
  assert.equal(button.textContent, 'Light');
  button.events.click();
  assert.equal(document.documentElement.dataset.theme, 'dark');
  assert.equal(button.attributes['aria-pressed'], 'true');
});

test('late-rendered API fields get names without replacing existing labels', async () => {
  const view = await loadDocs();
  const fields = ['unnamed', 'explicit', 'associated', 'native'].map(view.element);
  fields[1].setAttribute('aria-label', 'Existing name');
  fields[2].setAttribute('aria-labelledby', 'parameter-label');
  fields[3].labels = [{}];
  const example = view.element('example');
  view.elements.get('swagger-ui').querySelectorAll = selector => selector === 'tr[data-param-name]' ? [{
    dataset: { paramName: 'favorite', paramIn: 'query' }, querySelectorAll: () => fields,
  }] : [example];
  view.mutation(); view.mutation();
  assert.equal(fields[0].attributes['aria-label'], 'favorite (query)');
  assert.equal(fields[1].attributes['aria-label'], 'Existing name');
  assert.equal(fields[2].attributes['aria-label'], undefined);
  assert.equal(fields[3].attributes['aria-label'], undefined);
  assert.equal(example.attributes.tabindex, '0');
  assert.equal(example.attributes.role, 'region');
  assert.equal(example.attributes['aria-label'], 'API example');
});

test('operation permalinks open a closed operation while preserving open and modified clicks', async () => {
  const { config } = await loadDocs();
  const React = { createElement: (type, props, ...children) => ({ type, props, children }) };
  const wrapper = config.plugins[1]({ React }).wrapComponents.OperationSummary(() => {});
  const values = { isDeepLinkingEnabled: true, method: 'get', path: '/api/links', tag: 'Reading & tags', operationId: 'find/links' };
  let opened = 0;
  const render = isShown => wrapper({ operationProps: { get: key => values[key] }, isShown, toggleShown: () => opened++ });
  const link = render(false).children[1];
  assert.equal(link.type, 'a');
  assert.equal(link.props.href, '#/Reading%20%26%20tags/find%2Flinks');
  link.props.onClick({ button: 0 });
  assert.equal(opened, 1);
  render(true).children[1].props.onClick({ button: 0 });
  for (const modifier of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey']) link.props.onClick({ button: 0, [modifier]: true });
  link.props.onClick({ button: 1 });
  assert.equal(opened, 1);
});
