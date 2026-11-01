// Disposable UI evidence across engines. This is test tooling, never served by Pocketmark.
import assert from 'node:assert/strict';
import { chromium, firefox, webkit, request } from 'playwright';
import { createHmac, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { openNavigation, clickNavigation } from './navigation.mjs';

const base = new URL(process.env.E2E_BASE_URL);
assert.equal(base.hostname, '127.0.0.1', 'Use a fresh disposable loopback instance');
const output = process.env.E2E_EVIDENCE_DIR;
assert.ok(output, 'E2E_EVIDENCE_DIR must point outside the repository');
await mkdir(output, { recursive: true });
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const axeSource = await readFile(join(root, 'e2e/node_modules/axe-core/axe.min.js'), 'utf8');
const evidence = { engines: [], accessibility: [], motion: [], limitations: ['No physical phone or on-screen keyboard', 'No spoken screen reader', 'WebKit here is not Safari qualification', 'Extension uses a Chrome API adapter; native capture has separate tests'] };
const fixturePath = process.env.E2E_FIXTURE_FILE;
let fixture;
try { if (fixturePath) fixture = JSON.parse(await readFile(fixturePath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (fixture) assert.equal(fixture.base, base.href, 'A cached fixture belongs to this exact disposable instance');
const api = await request.newContext({ baseURL: base.href, storageState: fixture?.storageState });
const password = fixture?.password || randomBytes(24).toString('hex');
async function post(path, data, extra = {}) {
  const res = await api.post(path, { data, ...extra });
  assert.ok(res.ok(), `${path}: HTTP ${res.status()}`);
  return res.json();
}
function code(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let value = 0, bits = 0; const bytes = [];
  for (const character of secret) { value = (value << 5) | alphabet.indexOf(character); bits += 5; if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); } }
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac('sha1', Buffer.from(bytes)).update(counter).digest(); const off = digest.at(-1) & 15;
  return String((digest.readUInt32BE(off) & 0x7fffffff) % 1000000).padStart(6, '0');
}
let link, storageState;
if (fixture) {
  assert.ok((await api.get('/api/session')).ok(), 'Cached fixture session must remain valid');
  ({ link, storageState } = fixture);
} else {
  await post('/api/setup', { username: 'ui-coverage', password });
  const enrollment = await post('/api/mfa/enroll', {});
  await post('/api/mfa/verify', { code: code(enrollment.secret) });
  const collection = await post('/api/collections', { name: 'Reading & references' });
  link = await post('/api/links', { url: 'https://example.com/design', title: 'Design notes for a personal library', description: 'A synthetic bookmark used only for interface validation.', notes: 'Keep the original context close.', collectionId: collection.id, tags: ['design', 'reading'], favorite: true });
  await post('/api/links', { url: 'https://example.com/empty', title: 'A bookmark without a saved copy', tags: ['research'] });
  await post('/api/files?name=library-notes.html', '<!doctype html><html><head><title>Library notes</title></head><body><h1>Library notes</h1><p>A saved document for interface verification.</p></body></html>', { headers: { 'Content-Type': 'text/html' } });
  storageState = await api.storageState();
  fixture = { base: base.href, password, secret: enrollment.secret, link, storageState };
  if (fixturePath) await writeFile(fixturePath, JSON.stringify(fixture), { mode: 0o600 });
  if (process.env.E2E_AUTH_OUTPUT) await writeFile(process.env.E2E_AUTH_OUTPUT, JSON.stringify({ password, secret: enrollment.secret }), { mode: 0o600 });
}

async function audit(page, label, engine) {
  await page.evaluate(axeSource);
  const result = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } })).violations.map(v => ({ id: v.id, impact: v.impact, targets: v.nodes.map(n => n.target) })));
  evidence.accessibility.push({ engine, surface: label, violations: result });
  // Collect the whole matrix before failing, so one defect does not conceal others.
}
async function shot(page, label, engine) {
  await page.screenshot({ path: join(output, `${engine}-${label}.png`), fullPage: false });
}
async function noOverflow(page, label) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label} overflows`);
}
async function expectThemeColor(locator, property, token) {
  await settleControl(locator);
  assert.ok(await locator.evaluate((node, { property, token }) => {
    const probe = document.createElement('span'); probe.style.color = `var(${token})`; node.append(probe);
    const expected = getComputedStyle(probe).color; probe.remove();
    return getComputedStyle(node)[property] === expected;
  }, { property, token }), `${property} matches ${token}`);
}
async function settleControl(locator) {
  await locator.evaluate(async node => { await Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => {}))); });
}
async function expandedDocumentation(page, theme, engine) {
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(new URL('/api-docs/', base).href);
    await page.locator('#swagger-ui[aria-busy=false]').waitFor();
    await page.locator('.opblock-tag').filter({ hasText: 'Bookmarks' }).click();
    const operation = page.locator('#operations-Bookmarks-listLinks');
    const toggle = operation.locator('.opblock-summary-control');
    await toggle.click();
    assert.equal(await page.locator('.opblock-summary-control a[href], .opblock-summary-control button').count(), 0, 'summary buttons contain no interactive controls');
    await expectThemeColor(operation.locator('tbody .header-col').first(), 'color', '--ink');
    await expectThemeColor(operation.locator('.header-example').first(), 'color', '--muted');
    await expectThemeColor(operation.locator('.authorization__btn path').first(), 'fill', '--ink');
    await operation.locator('.try-out__btn').click();
    for (const parameter of ['favorite', 'unread', 'sort', 'fuzzy']) {
      const field = operation.locator(`tr[data-param-name="${parameter}"] select`);
      await field.waitFor({ state: 'attached' });
      assert.equal(await field.getAttribute('aria-label'), `${parameter} (query)`);
      await operation.getByRole('combobox', { name: `${parameter} (query)` }).waitFor();
    }
    const sort = operation.getByRole('combobox', { name: 'sort (query)' });
    await sort.click();
    await page.getByRole('option', { name: 'oldest', exact: true }).click();
    assert.equal(await operation.locator('tr[data-param-name="sort"] select').inputValue(), 'oldest');
    assert.match(await sort.textContent(), /oldest/);
    await sort.focus(); await sort.press('ArrowDown'); await sort.press('Escape');
    assert.equal(await sort.getAttribute('aria-expanded'), 'false');
    const example = operation.locator('.highlight-code .microlight').first();
    await expectThemeColor(example, 'backgroundColor', '--surface');
    await expectThemeColor(example, 'color', '--ink');
    await example.focus(); await example.press('Tab'); await page.keyboard.press('Shift+Tab');
    assert.ok(await example.evaluate(node => node === document.activeElement), 'API examples accept keyboard focus');
    await expectThemeColor(example, 'outlineColor', '--focus');
    const permalink = operation.getByRole('link', { name: 'Permalink to GET /api/links', exact: true });
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    await permalink.focus(); await permalink.press('Enter');
    assert.match(page.url(), /#\/Bookmarks\/listLinks$/);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'permalink opens its closed operation');
    await permalink.press('Enter');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'permalink preserves an open operation');
    await toggle.focus(); await toggle.press('Space');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    await toggle.press('Enter');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    await audit(page, `${theme}-api-expanded-${width}`, engine);
    await noOverflow(page, 'expanded API documentation');
    await shot(page, `${theme}-api-expanded-${width}`, engine);
    await page.locator('#docs-theme').click();
    await expectThemeColor(operation.locator('tbody .header-col').first(), 'color', '--ink');
    await expectThemeColor(operation.locator('.authorization__btn path').first(), 'fill', '--ink');
    await page.locator('#docs-theme').click();
    if (width === 390) {
      await page.emulateMedia({ forcedColors: 'active' });
      assert.equal(await operation.locator('.authorization__btn path').first().evaluate(node => getComputedStyle(node).forcedColorAdjust), 'auto');
      await page.emulateMedia({ forcedColors: 'none' });
    }
  }
}
const selected = (process.env.E2E_ENGINES || 'chromium,firefox,webkit').split(',');
for (const name of selected) {
  const engine = { chromium, firefox, webkit }[name]; assert.ok(engine, `Unknown engine ${name}`);
  const browser = await engine.launch(name === 'chromium' && process.env.E2E_CHROMIUM_EXECUTABLE ? { executablePath: process.env.E2E_CHROMIUM_EXECUTABLE } : {});
  try {
    evidence.engines.push({ name, version: browser.version() });
    for (const theme of ['dark', 'light']) {
      const context = await browser.newContext({ storageState, viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
      await context.addInitScript(theme => { try { localStorage.setItem('pocketmark-theme', theme); } catch { /* Saved pages have an opaque origin. */ } }, theme);
      const page = await context.newPage(); const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(base.href); await page.locator('#bookmark-grid .bookmark-card').first().waitFor();
      await audit(page, `${theme}-library`, name); await shot(page, `${theme}-library`, name);
      const card = page.locator('.bookmark-card').filter({ has: page.getByRole('button', { name: link.title, exact: true }) });
      assert.equal(await card.locator('.card-actions-toggle').isVisible(), false, 'desktop retains its icon actions');
      assert.equal(await card.locator('.card-overflow-actions .card-action').count(), 4);
      await card.locator('.card-overflow-actions .card-action').nth(1).hover();
      await settleControl(card.locator('.card-overflow-actions .card-action').nth(1));
      const desktopEditHover = await card.locator('.card-overflow-actions .card-action').nth(1).evaluate(node => getComputedStyle(node).color);
      await card.getByRole('button', { name: `Edit bookmark: ${link.title}`, exact: true }).click();
      await page.locator('#bookmark-dialog .close-dialog').first().click();
      await page.locator('#add-bookmark').click();
      for (const size of [[1280, 900], [390, 844], [320, 568], [844, 390]]) {
        await page.setViewportSize({ width: size[0], height: size[1] });
        await noOverflow(page, 'editor');
        assert.ok(await page.locator('#save-bookmark').evaluate(n => { const b = n.getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight; }), 'Save remains visible');
      }
      await audit(page, `${theme}-editor`, name); await shot(page, `${theme}-editor-landscape`, name);
      await page.locator('#bookmark-dialog .close-dialog').first().click();
      await page.setViewportSize({ width: 390, height: 844 });
      await card.locator('.card-actions-toggle').click();
      const editAction = card.locator('.card-overflow-actions .card-action').nth(1);
      await editAction.hover();
      await settleControl(editAction);
      assert.equal(await editAction.evaluate(node => getComputedStyle(node).color), desktopEditHover, 'mobile hover preserves its themed desktop action color');
      const readAction = card.locator('.card-overflow-actions .card-action').first();
      await readAction.click();
      await card.locator('.card-action.read').waitFor();
      await expectThemeColor(card.locator('.card-action.read'), 'color', '--success');
      await page.locator('#toast .toast-action').click();
      await card.locator('.card-action.read').waitFor({ state: 'detached' });
      await page.getByRole('button', { name: 'library-notes.html', exact: true }).click();
      await page.locator('#reader-format-html').waitFor();
      assert.equal(await page.locator('#reader-format-pdf').isVisible(), false);
      await page.locator('#reader-files-toggle').click(); await page.locator('#asset-upload-button').waitFor();
      assert.equal(await page.locator('#reader-notebook').isVisible(), false, 'file management does not open Notes');
      const deleteFile = page.getByRole('button', { name: 'Delete library-notes.html', exact: true });
      await deleteFile.hover(); await expectThemeColor(deleteFile, 'color', '--danger');
      await deleteFile.focus(); await expectThemeColor(deleteFile, 'color', '--danger');
      await audit(page, `${theme}-files`, name); await shot(page, `${theme}-files-mobile`, name);
      await page.getByRole('button', { name: 'Read library-notes.html', exact: true }).click();
      await page.locator('#reader-layout').waitFor();
      assert.equal(await page.locator('#reader-files').isVisible(), false);
      assert.ok(await page.locator('#reader-layout').evaluate(n => n.getBoundingClientRect().top < innerHeight && n === document.activeElement), 'Read reveals and focuses its document');
      await page.locator('#reader-files-toggle').click();
      await page.locator('#reader-files-close').click();
      assert.equal(await page.locator('#reader-files-toggle').evaluate(n => n === document.activeElement), true);
      await page.locator('#reader-notebook-toggle').click(); await page.locator('#reader-notebook').waitFor();
      assert.equal(await page.locator('#reader-section-nav [role=tab]').count(), 2);
      await audit(page, `${theme}-notes`, name);
      await page.getByRole('button', { name: 'Close reader', exact: true }).click();
      await clickNavigation(page, '#settings-button');
      for (const section of ['password', 'api-keys', 'sync', 'mobile']) {
        await clickNavigation(page, `[data-settings-section="${section}"]`);
        await noOverflow(page, section); await audit(page, `${theme}-settings-${section}`, name);
      }
      await shot(page, `${theme}-settings-mobile`, name);
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.goto(new URL('/?settings=2fa', base).href);
      await page.locator('#mfa-settings-title').waitFor();
      assert.ok(await page.locator('#mfa-settings-title').evaluate(n => n === document.activeElement && n.getBoundingClientRect().top >= 12), 'direct settings focus stays inside the viewport');
      await expectThemeColor(page.locator('#mfa-settings-title'), 'outlineColor', '--focus');
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(base.href); await clickNavigation(page, '#help-button');
      await page.locator('#help-search').fill('capture');
      const helpTopic = page.locator('#help-topics summary:visible').first();
      await helpTopic.hover();
      assert.ok(await helpTopic.evaluate(n => getComputedStyle(n).backgroundColor !== 'rgba(0, 0, 0, 0)'), 'Help hover has a visible background');
      await audit(page, `${theme}-help`, name); await shot(page, `${theme}-help-mobile`, name);
      await page.getByRole('button', { name: 'Close help', exact: true }).click();
      await clickNavigation(page, '#add-collection');
      await page.locator('#collection-name').fill('a'.repeat(120));
      assert.equal(await page.locator('#collection-name-hint').isVisible(), false);
      await page.locator('#collection-name').fill('é'.repeat(61));
      assert.equal(await page.locator('#collection-name').evaluate(n => n.checkValidity()), false);
      assert.match(await page.locator('#collection-name-hint').textContent(), /name is too long/i);
      await expectThemeColor(page.locator('#collection-name-hint'), 'color', '--danger');
      await shot(page, `${theme}-collection-error-mobile`, name);
      await page.setViewportSize({ width: 1280, height: 900 });
      await shot(page, `${theme}-collection-error-desktop`, name);
      await page.locator('#collection-name').fill('Corrected');
      assert.equal(await page.locator('#collection-name-hint').isVisible(), false);
      await shot(page, `${theme}-collection-valid-desktop`, name);
      await page.setViewportSize({ width: 390, height: 844 });
      await shot(page, `${theme}-collection-valid-mobile`, name);
      await page.locator('#collection-dialog .close-dialog').first().click();
      await page.goto(new URL('/api-docs/', base).href); await page.locator('#swagger-ui[aria-busy=false]').waitFor();
      await audit(page, `${theme}-api-docs`, name); await noOverflow(page, 'docs'); await shot(page, `${theme}-api-docs-mobile`, name);
      await expandedDocumentation(page, theme, name);
      assert.deepEqual(errors, [], `${name}: JavaScript errors`);
      await context.close();
      const signedOut = await browser.newContext({ viewport: { width: 390, height: 844 } });
      await signedOut.addInitScript(theme => { try { localStorage.setItem('pocketmark-theme', theme); } catch { /* Saved pages have an opaque origin. */ } }, theme);
      const login = await signedOut.newPage(); await login.goto(base.href); await login.locator('#login-submit').waitFor();
      await login.locator('#login-view .theme-toggle').hover();
      await audit(login, `${theme}-login`, name); await shot(login, `${theme}-login-mobile`, name);
      await login.locator('#login-username').fill('ui-coverage'); await login.locator('#login-password').fill(password); await login.locator('#login-submit').click();
      await login.locator('#mfa-code-form').waitFor(); await audit(login, `${theme}-mfa`, name); await shot(login, `${theme}-mfa-mobile`, name);
      await signedOut.close();
    }
    const motionContext = await browser.newContext({ storageState, viewport: { width: 1280, height: 900 }, reducedMotion: 'no-preference' });
    const motion = await motionContext.newPage(); await motion.goto(base.href); await motion.locator('#bookmark-grid .bookmark-card').first().waitFor();
    await motion.waitForLoadState('networkidle');
    const baseline = await motion.evaluate(() => new Promise(resolve => { const values = []; let previous = performance.now(), start = previous; function frame(now) { values.push(now - previous); previous = now; if (now - start < 400) requestAnimationFrame(frame); else resolve(values); } requestAnimationFrame(frame); }));
    const frames = await motion.evaluate(() => new Promise(resolve => {
      const samples = []; let prior = performance.now(), start = prior;
      function frame(now) { samples.push(now - prior); prior = now; if (now - start < 700) requestAnimationFrame(frame); else resolve(samples); }
      requestAnimationFrame(frame);
      document.getElementById('add-bookmark').click();
    }));
    await motion.locator('#bookmark-dialog .close-dialog').first().click();
    await motion.getByRole('button', { name: 'library-notes.html', exact: true }).click();
    await motion.locator('#reader-notebook-toggle').click();
    const notebookDuration = () => motion.locator('#reader-notebook').evaluate(n => Math.max(...getComputedStyle(n).transitionDuration.split(',').map(parseFloat)) * 1000);
    const notebookTransitionMs = await notebookDuration();
    await motion.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await notebookDuration(), 0, 'reduced motion removes the new notebook fade');
    evidence.motion.push({ engine: name, notebookTransitionMs, notebookReducedTransitionMs: 0, idleMaximumFrameMs: Math.round(Math.max(...baseline)), idleFramesOver50ms: baseline.filter(n => n > 50).length, frames: frames.length, maximumFrameMs: Math.round(Math.max(...frames)), framesOver50ms: frames.filter(n => n > 50).length, note: 'Headless local sample, not a device performance guarantee' });
    await motionContext.close();
    const touch = await browser.newContext({ storageState, viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: 'reduce' });
    const touchPage = await touch.newPage(); await touchPage.goto(base.href); await touchPage.locator('#add-bookmark').waitFor();
    await touchPage.locator('#add-bookmark').tap(); await touchPage.locator('#bookmark-dialog').waitFor(); await touchPage.getByRole('button', { name: 'Cancel', exact: true }).tap();
    await touchPage.goto(new URL('/api-docs/', base).href); await touchPage.locator('#swagger-ui[aria-busy=false]').waitFor();
    await touchPage.locator('.opblock-tag').filter({ hasText: 'Bookmarks' }).tap();
    await touchPage.getByRole('link', { name: 'Permalink to GET /api/links', exact: true }).tap();
    assert.match(touchPage.url(), /#\/Bookmarks\/listLinks$/);
    await touchPage.locator('#operations-Bookmarks-listLinks .opblock-body').waitFor();
    await touch.close();
  } finally { await browser.close(); }
}

// Render the shipped popup with a bounded Chrome API adapter, never real account data.
const extensionFiles = new Set(['popup.html', 'popup.css', 'name-limit.js', 'ui-theme.js', 'theme-switch.js', 'popup.js', 'common.js']);
const preview = createServer(async (req, res) => {
  const file = new URL(req.url, 'http://localhost').pathname.slice(1) || 'popup.html';
  if (!extensionFiles.has(file)) { res.writeHead(404); res.end(); return; }
  try { res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html'); res.end(await readFile(join(root, 'extension', file))); }
  catch { res.writeHead(500); res.end(); }
});
await new Promise(resolve => preview.listen(0, '127.0.0.1', resolve));
try {
  const browser = await chromium.launch(process.env.E2E_CHROMIUM_EXECUTABLE ? { executablePath: process.env.E2E_CHROMIUM_EXECUTABLE } : {});
  try {
    for (const state of ['connect', 'editor', 'failed', 'saving', 'done']) {
      for (const theme of ['dark', 'light']) {
        const context = await browser.newContext({ viewport: { width: 400, height: 560 }, reducedMotion: 'reduce' });
        await context.addInitScript(({ state, theme }) => {
          localStorage.setItem('pocketmark-extension-theme', theme);
          const task = ['failed', 'saving', 'done'].includes(state) ? { id: 'fixture', status: { failed: 'paused', saving: 'running', done: 'done' }[state], fields: { title: 'Synthetic saved page', url: 'https://example.com/' }, message: 'Synthetic capture status', items: [] } : null;
          window.chrome = { storage: { local: { setAccessLevel: async () => {}, get: async () => state === 'connect' ? {} : { server: 'http://127.0.0.1:8093', token: 'synthetic-adapter-only' } } }, tabs: { query: async () => [{ id: 1, url: 'https://example.com/', title: 'Synthetic saved page' }] }, permissions: { contains: async () => true }, runtime: { sendMessage: async m => ({ ok: true, value: m.type === 'state' ? task : m.type === 'load' ? { collections: [], tags: [], link: null } : null }) } };
        }, { state, theme });
        const page = await context.newPage(); await page.goto(`http://127.0.0.1:${preview.address().port}/popup.html`); await page.locator('#footer').waitFor();
        assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), theme, 'theme changes the rendered native-control scheme');
        assert.ok(await page.locator('#task').evaluate(n => getComputedStyle(n, '::details-content').transitionDuration.split(',').every(value => parseFloat(value) === 0)), 'reduced motion removes extension disclosure fades');
        if (state === 'editor') {
          await page.locator('#new-collection').click();
          await page.locator('#collection-name').fill('a'.repeat(120));
          assert.equal(await page.locator('#collection-name-hint').isVisible(), false);
          await page.locator('#collection-name').fill('é'.repeat(61));
          assert.equal(await page.locator('#collection-name').evaluate(n => n.checkValidity()), false);
          assert.match(await page.locator('#collection-name-hint').textContent(), /name is too long/i);
          await expectThemeColor(page.locator('#collection-name-hint'), 'color', '--danger');
          await shot(page, `${theme}-extension-collection-error`, 'chromium');
          await page.locator('#collection-name').fill('Corrected');
          assert.equal(await page.locator('#collection-name-hint').isVisible(), false);
          await shot(page, `${theme}-extension-collection-valid`, 'chromium');
          await page.locator('#collection-name').fill('é'.repeat(61));
          await page.locator('#cancel-collection').click();
          assert.equal(await page.locator('#save-form').evaluate(n => n.checkValidity()), true, 'cancelled invalid collection cannot block saving');
        }
        await audit(page, `${theme}-extension-${state}`, 'chromium'); await shot(page, `${theme}-extension-${state}`, 'chromium');
        await context.close();
      }
    }
  } finally { await browser.close(); }
} finally { await new Promise(resolve => preview.close(resolve)); await api.dispose(); }
await writeFile(join(output, 'report.json'), JSON.stringify(evidence, null, 2));
const violations = evidence.accessibility.filter(item => item.violations.length);
console.log(JSON.stringify({ engines: evidence.engines, auditedSurfaces: evidence.accessibility.length, violations, motion: evidence.motion, limitations: evidence.limitations }, null, 2));
assert.equal(violations.length, 0, 'Accessibility findings are recorded in report.json');
