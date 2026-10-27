// Real Chromium, real HTTP and SQLite. Run only against the disposable smoke instance.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { securityJourney } from './security.mjs';

const base = new URL(process.env.E2E_BASE_URL);
assert.equal(base.hostname, '127.0.0.1', 'E2E requires a disposable loopback instance');
// Use full Chromium's headless mode: the headless shell omits the native PDF viewer.
const browser = await chromium.launch(process.env.E2E_CHROMIUM_EXECUTABLE
  ? { executablePath: process.env.E2E_CHROMIUM_EXECUTABLE }
  : { channel: 'chromium' });
function authenticatorCode(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const bytes = [];
  for (const character of secret) {
    value = (value << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}
async function captureMFA(page, name) {
  if (!process.env.E2E_SCREENSHOTS) return;
  await mkdir(process.env.E2E_SCREENSHOTS, { recursive: true });
  for (const [suffix, width, height, theme] of [['desktop', 1280, 1000, 'dark'], ['mobile', 390, 844, 'dark'], ['mobile-light', 390, 844, 'light']]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(theme => { if (document.documentElement.dataset.theme !== theme) document.querySelector('[data-theme-toggle]').click(); }, theme);
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
      window.scrollTo(0, 0);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}-${suffix} overflows`);
    await page.screenshot({ path: join(process.env.E2E_SCREENSHOTS, `${name}-${suffix}.png`), fullPage: false });
    if (await page.evaluate(() => document.documentElement.scrollHeight > innerHeight + 1)) {
      await page.evaluate(async () => { window.scrollTo(0, document.documentElement.scrollHeight); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
      await page.screenshot({ path: join(process.env.E2E_SCREENSHOTS, `${name}-${suffix}-bottom.png`), fullPage: false });
    }
  }
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.evaluate(() => { if (document.documentElement.dataset.theme !== 'dark') document.querySelector('[data-theme-toggle]').click(); });
}
try {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const username = 'ci-owner';
  const password = 'Synthetic-E2E-password-42';
  const unclaimed = await page.request.post(new URL('/api/setup', base).href, { data: { username, password } });
  assert.equal(unclaimed.status(), 403, 'public visitor cannot claim an empty server');
  await page.goto(base.href);
  await page.locator('#login-username').fill(username);
  await page.locator('#login-password').fill(password);
  await page.locator('#login-setup-token').fill(process.env.E2E_SETUP_TOKEN || '');
  await page.locator('#login-confirm').fill(password);
  await page.locator('#login-submit').click();
  await page.locator('#mfa-enrollment').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#mfa-code').getAttribute('inputmode'), 'numeric');
  await captureMFA(page, 'mfa-enrollment');
  const secret = await page.locator('#mfa-secret').inputValue();
  assert.ok(secret.length >= 32);
  await page.locator('#mfa-code').fill(authenticatorCode(secret));
  await page.locator('#mfa-code-form button').click();
  await page.locator('#mfa-login-codes').waitFor({ state: 'visible' });
  await captureMFA(page, 'mfa-recovery');
  const recoveryCodes = (await page.locator('#mfa-login-codes-value').textContent()).trim().split('\n');
  assert.equal(recoveryCodes.length, 10);
  await page.locator('#mfa-login-continue').click();
  await page.locator('#app-view').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#login-setup-token').inputValue(), '');
  const oldSession = (await page.context().cookies()).find(cookie => cookie.name === 'pocketmark');
  await page.locator('#logout-button').click();
  const replay = await page.request.post(new URL('/api/tokens', base).href, { headers: { Cookie: `pocketmark=${oldSession.value}` }, data: { name: 'replayed-session' } });
  assert.equal(replay.status(), 401, 'a signed-out cookie cannot mint API keys');
  await page.locator('#login-username').fill(username);
  await page.locator('#login-password').fill('incorrect-password');
  await page.locator('#login-submit').click();
  await page.waitForFunction(() => document.getElementById('login-error').textContent.length > 0);
  await page.locator('#login-password').fill(password);
  await page.locator('#login-submit').click();
  await page.locator('#mfa-code-form').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#mfa-code').getAttribute('inputmode'), 'text');
  await captureMFA(page, 'mfa-sign-in');
  await page.locator('#mfa-code').fill(recoveryCodes[0]);
  await page.locator('#mfa-code-form button').click();
  await page.locator('#app-view').waitFor({ state: 'visible' });

  await securityJourney({ browser, page, base, username, password, recoveryCode: recoveryCodes[1] });

  // A recovery-code session can replace a lost authenticator without another
  // recovery code, and replacement signs out other browsers.
  const peer = await browser.newContext();
  try {
    assert.equal((await peer.request.post(new URL('/api/login', base).href, { data: { username, password } })).status(), 200);
    assert.equal((await peer.request.post(new URL('/api/mfa/verify', base).href, { data: { code: recoveryCodes[2] } })).status(), 200);
    await page.locator('#settings-button').click();
    assert.equal(await page.getByText('Generating recovery codes invalidates all previous recovery codes.').isVisible(), true);
    assert.equal(await page.locator('#mfa-manage-form button[value="codes"]').getAttribute('aria-describedby'), 'mfa-codes-warning');
    await page.locator('#mfa-manage-password').fill('incorrect-password');
    await page.locator('#mfa-manage-form button[value="replace"]').click();
    await page.locator('#mfa-manage-error').filter({ hasText: 'incorrect password' }).waitFor();
    await page.locator('#mfa-manage-password').fill(password);
    await page.locator('#mfa-manage-form button[value="replace"]').click();
    await page.locator('#mfa-manage-enrollment').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#mfa-manage-new-code').getAttribute('inputmode'), 'numeric');
    const replacementSecret = await page.locator('#mfa-manage-secret').inputValue();
    await page.locator('#mfa-manage-new-code').fill(authenticatorCode(replacementSecret));
    await page.locator('#mfa-manage-verify button').click();
    await page.locator('#mfa-manage-codes').waitFor({ state: 'visible' });
    const replacementCodes = (await page.locator('#mfa-manage-codes-value').textContent()).trim().split('\n');
    assert.equal(replacementCodes.length, 10);
    assert.equal((await peer.request.get(new URL('/api/session', base).href)).status(), 401);
    await page.locator('#mfa-manage-password').fill(password);
    await page.locator('#mfa-manage-code').fill(replacementCodes[0]);
    await page.locator('#mfa-manage-form button[value="codes"]').click();
    await page.waitForFunction(previous => document.getElementById('mfa-manage-codes-value').textContent !== previous, replacementCodes.join('\n'));
    await page.locator('#settings-dialog').getByRole('button', { name: 'Close', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('mfa-manage-codes-value').textContent === '');
    assert.equal(await page.locator('#mfa-manage-codes-value').textContent(), '');
    assert.equal(await page.locator('#mfa-manage-secret').inputValue(), '');
  } finally { await peer.close(); }

  const original = 'Browser integration bookmark';
  const revised = 'Browser revised bookmark';
  await page.locator('#add-bookmark').click();
  // A private destination is deliberately rejected by the capture worker: no public network.
  await page.locator('#bookmark-url').fill('http://127.0.0.1/e2e-fixture');
  await page.locator('#bookmark-title').fill(original);
  await page.locator('#bookmark-notes').fill('Persisted browser notes');
  await page.locator('#save-bookmark').click();
  const card = title => page.locator('.bookmark-card').filter({ has: page.getByRole('button', { name: title, exact: true }) });
  const openActions = async title => {
    const toggle = card(title).getByRole('button', { name: `Actions for ${title}`, exact: true });
    if (await toggle.isVisible()) await toggle.click();
  };
  await card(original).waitFor();
  await page.locator('#search').fill('absent-e2e-bookmark-42');
  await page.locator('#empty-title').filter({ hasText: 'No bookmarks found' }).waitFor();
  await page.locator('#search').fill('Browser integration');
  await card(original).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.bookmark-card').length === 1);
  await openActions(original);
  await card(original).getByRole('button', { name: `Edit bookmark: ${original}`, exact: true }).click();
  await page.locator('#bookmark-title').fill(revised);
  await page.locator('#save-bookmark').click();
  await page.locator('#bookmark-dialog').waitFor({ state: 'hidden' });
  await page.locator('#search').fill('Browser revised');
  await card(revised).waitFor();
  await page.reload();
  await card(revised).waitFor();
  await openActions(revised);
  await card(revised).getByRole('button', { name: `Edit bookmark: ${revised}`, exact: true }).click();
  assert.equal(await page.locator('#bookmark-notes').inputValue(), 'Persisted browser notes');
  await page.locator('#bookmark-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();

  // Preserve synthetic files through real HTTP/SQLite and view them without a
  // download. The HTML intentionally tries scripts, refresh and remote loads.
  const links = await (await page.request.get(new URL('/api/links', base).href)).json();
  const saved = links.links.find(link => link.title === revised);
  assert.ok(saved);
  const fixture = await browser.newPage();
  await fixture.setContent('<h1>Synthetic PDF and image capture</h1>');
  const pdf = await fixture.pdf();
  const png = await fixture.screenshot();
  await fixture.close();
  const html = `<!doctype html><style>h1 { color: rgb(12, 34, 56); } body { background: rgb(245, 240, 230); }</style>
    <h1>Original saved appearance</h1><img id="embedded" src="data:image/png;base64,${png.toString('base64')}">
    <script>parent.previewCompromised = true</script><img src="/preview-leak">
    <iframe src="/preview-frame-leak"></iframe><style>@import url('/preview-style-leak');</style>
    <meta http-equiv="refresh" content="0;url=/preview-navigation-leak"><base href="/preview-base-leak">
    <noscript><a id="noscript-link" href="${new URL('/preview-noscript-leak', base).href}">No-script navigation</a></noscript>
    <a href="/preview-link-leak" target="_top">External link</a><svg xmlns:xlink="http://www.w3.org/1999/xlink"><a href="#safe"><set attributeName="href" to="/preview-svg-leak"/><text y="20">SVG link</text></a><a id="xlink" xlink:href="/preview-xlink-leak"><text y="60">Namespaced link</text></a></svg>` + '<!-- padding -->'.repeat(145000);
  const legacy = Buffer.concat([Buffer.from('<!doctype html><meta charset="windows-1252"><h1>Caf'), Buffer.from([0xe9, 0x20, 0x80]), Buffer.from('</h1>')]);
  let htmlAsset;
  for (const [name, media, data] of [['legacy.html', 'text/html', legacy], ['capture.html', 'text/html', Buffer.from(html)], ['capture.png', 'image/png', png], ['capture.pdf', 'application/pdf', pdf]]) {
    const response = await page.request.post(new URL(`/api/links/${saved.id}/assets?name=${name}`, base).href, { headers: { 'Content-Type': media }, data });
    assert.equal(response.status(), 201, await response.text());
    if (name === 'capture.html') htmlAsset = await response.json();
  }
  let downloads = 0;
  const leakedRequests = [];
  page.on('download', () => downloads++);
  page.on('response', response => { if (new URL(response.url()).pathname.startsWith('/preview-')) leakedRequests.push(response.url()); });
  await card(revised).getByRole('button', { name: revised, exact: true }).click();
  const previews = '**/api/assets/*/view';
  await page.route(previews, route => route.request().method() === 'GET'
    ? route.fulfill({ status: 422, contentType: 'application/json', body: '{"error":"Synthetic preparation failure"}' })
    : route.continue());
  await page.getByRole('button', { name: 'View capture.html', exact: true }).click();
  const viewer = page.locator('#asset-viewer');
  await viewer.waitFor({ state: 'visible' });
  await page.locator('#asset-viewer-status').filter({ hasText: 'Could not open this preview' }).waitFor();
  assert.equal(await page.locator('#asset-viewer-content iframe').count(), 0, 'failed preparation must not open an error document as a capture');
  await page.unroute(previews);
  await page.getByRole('button', { name: 'Retry preview', exact: true }).click();
  const capture = page.frameLocator('#asset-viewer-content iframe').frameLocator('iframe');
  await capture.getByRole('heading', { name: 'Original saved appearance' }).waitFor();
  assert.equal(await capture.locator('h1').evaluate(node => getComputedStyle(node).color), 'rgb(12, 34, 56)');
  assert.equal(await capture.locator('#embedded').evaluate(node => node.complete && node.naturalWidth > 0), true);
  assert.equal(await capture.getByText('External link', { exact: true }).getAttribute('href'), null);
  assert.equal(await capture.locator('set, animate').count(), 0);
  assert.equal(await capture.locator('#xlink').getAttribute('xlink:href'), null);
  await capture.locator('#xlink').click();
  assert.equal(await page.evaluate(() => window.previewCompromised), undefined);
  assert.equal(await page.frameLocator('#asset-viewer-content iframe').locator('iframe').getAttribute('sandbox'), '');
  // noscript is raw text to the tokenizer, but markup to a scriptless browser.
  // The absolute URL avoids a false pass caused by relative blob URL resolution.
  assert.equal(await capture.locator('#noscript-link').getAttribute('href'), new URL('/preview-noscript-leak', base).href);
  // Chromium can reject the navigation before creating a network request, so
  // requestfailed is not a reliable signal. Require the explicit CSP violation.
  await Promise.all([
    page.waitForEvent('console', { predicate: message => /frame-src/.test(message.text()) && /Content Security Policy/.test(message.text()) }),
    capture.locator('#noscript-link').click(),
  ]);
  await page.locator('#asset-viewer-select').selectOption({ label: 'legacy.html' });
  await capture.getByRole('heading', { name: 'Café €' }).waitFor();
  await page.locator('#asset-viewer-select').selectOption({ label: 'capture.png' });
  await page.waitForFunction(() => { const image = document.querySelector('#asset-viewer-content img'); return image?.complete && image.naturalWidth > 0; });
  const nativeViewer = page.waitForEvent('framenavigated', { predicate: frame => frame.url().startsWith('chrome-extension://') });
  await page.locator('#asset-viewer-select').selectOption({ label: 'capture.pdf' });
  await page.waitForFunction(() => document.getElementById('asset-viewer-status').textContent === 'capture.pdf');
  assert.equal(await page.locator('#asset-viewer-content iframe').getAttribute('sandbox'), null);
  await (await nativeViewer).locator('pdf-viewer').waitFor({ state: 'attached' });
  assert.equal(downloads, 0, 'viewing captures must not trigger downloads');
  assert.deepEqual(leakedRequests, [], 'HTML preview must not execute scripts, navigate or fetch external resources');
  // HTML payloads may only render inside the UI's parent CSP boundary. Direct
  // navigation downloads instead of creating a standalone active document.
  const direct = await page.context().newPage();
  const directLeaks = [];
  // CSP-blocked resource attempts can emit request events without reaching HTTP.
  direct.on('response', response => { if (new URL(response.url()).pathname.startsWith('/preview-')) directLeaks.push(response.url()); });
  direct.on('request', request => { if (new URL(request.url()).pathname === '/preview-xlink-leak') directLeaks.push(request.url()); });
  const directURL = new URL(`/api/assets/${htmlAsset.id}/view`, base).href;
  const download = direct.waitForEvent('download');
  await direct.goto(directURL).catch(error => assert.match(error.message, /download|ERR_ABORTED/i));
  assert.equal((await download).suggestedFilename(), 'capture.html');
  assert.equal(direct.url(), 'about:blank');
  assert.deepEqual(directLeaks, [], 'direct HTML payloads must not render or navigate');
  await direct.close();
  await page.getByRole('button', { name: 'Close preview', exact: true }).click();
  await viewer.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#asset-viewer-content').innerHTML(), '');
  await page.getByRole('button', { name: 'Close reader', exact: true }).click();

  page.once('dialog', dialog => dialog.accept());
  await card(revised).getByRole('button', { name: `Delete bookmark: ${revised}`, exact: true }).click();
  await card(revised).waitFor({ state: 'detached' });
  await page.reload();
  await page.locator('#empty-title').filter({ hasText: 'No bookmarks found' }).waitFor();
  await page.locator('#logout-button').click();
  await page.reload();
  await page.locator('#login-view').waitFor({ state: 'visible' });
  assert.deepEqual(errors, [], 'browser must not throw uncaught JavaScript errors');
  console.log('Browser E2E passed: setup, login rejection/login, CRUD, search, reload persistence, image/PDF/HTML previews and isolation, logout.');
} finally {
  await browser.close();
}
