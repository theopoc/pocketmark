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
function authenticatorCode(secret, offsetSeconds = 0) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const bytes = [];
  for (const character of secret) {
    value = (value << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor((Date.now() + offsetSeconds * 1000) / 30000)));
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
    if (name === 'mfa-manage-replacement') {
      await page.locator('#mfa-manage-enrollment').evaluate(node => node.scrollIntoView({ block: 'start' }));
      assert.ok(await page.locator('#settings-dialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1), `${name}-${suffix} dialog overflows`);
    }
    if (name === 'mfa-enrollment' || name === 'mfa-manage-replacement') {
      const key = name === 'mfa-enrollment' ? '#mfa-secret' : '#mfa-manage-secret';
      assert.ok(await page.locator(key).evaluate(field => field.scrollWidth <= field.clientWidth + 1 && field.scrollHeight <= field.clientHeight + 1), `${name}-${suffix} manual key is clipped`);
    }
    await page.screenshot({ path: join(process.env.E2E_SCREENSHOTS, `${name}-${suffix}.png`), fullPage: false });
    if (name === 'mfa-manage-replacement') {
      await page.locator('#mfa-manage-cancel').scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(process.env.E2E_SCREENSHOTS, `${name}-${suffix}-bottom.png`), fullPage: false });
    }
    if (await page.evaluate(() => document.documentElement.scrollHeight > innerHeight + 1)) {
      await page.evaluate(async () => { window.scrollTo(0, document.documentElement.scrollHeight); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
      await page.screenshot({ path: join(process.env.E2E_SCREENSHOTS, `${name}-${suffix}-bottom.png`), fullPage: false });
    }
  }
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.evaluate(() => { if (document.documentElement.dataset.theme !== 'dark') document.querySelector('[data-theme-toggle]').click(); });
}
async function holdResponse(page, path) {
  let received, release;
  const ready = new Promise(resolve => { received = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const url = new URL(path, base).href;
  const handler = async route => {
    const response = await route.fetch();
    received();
    await blocked;
    await route.fulfill({ response });
  };
  await page.route(url, handler);
  return { ready, release, remove: () => page.unroute(url, handler) };
}
async function holdUnauthorized(page, path, message = 'Synthetic expired session', status = 401) {
  let received, release;
  const ready = new Promise(resolve => { received = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const url = new URL(path, base).href;
  const handler = async route => {
    received();
    await blocked;
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: message }) });
  };
  await page.route(url, handler);
  return { ready, release, remove: () => page.unroute(url, handler) };
}
async function holdGatewayFailureAfterCommit(page, path) {
  let received, release;
  const ready = new Promise(resolve => { received = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const url = new URL(path, base).href;
  const handler = async route => {
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    received();
    await blocked;
    await route.fulfill({ status: 504, contentType: 'application/json', body: '{"error":"Synthetic gateway timeout"}' });
  };
  await page.route(url, handler);
  return { ready, release, remove: () => page.unroute(url, handler) };
}
try {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const username = 'ci-owner';
  const password = 'Synthetic-E2E-password-42';
  await page.goto(base.href);
  await page.locator('#login-title').filter({ hasText: 'Create your account' }).waitFor();
  assert.match(await page.locator('#login-description').textContent(), /authenticator app.*recovery codes/i);
  assert.equal(await page.locator('#login-password').getAttribute('aria-describedby'), 'login-password-hint');
  assert.equal(await page.locator('#login-password-hint').isVisible(), true);
  await page.locator('#login-username').fill(username);
  await page.locator('#login-password').fill(password);
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
  const oldSession = (await page.context().cookies()).find(cookie => cookie.name === 'pocketmark');
  await page.locator('#logout-button').click();
  assert.equal(await page.locator('#login-password').getAttribute('aria-describedby'), 'login-help');
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
  let currentSecret, freshRecoveryCodes;
  const peer = await browser.newContext();
  try {
    assert.equal((await peer.request.post(new URL('/api/login', base).href, { data: { username, password } })).status(), 200);
    assert.equal((await peer.request.post(new URL('/api/mfa/verify', base).href, { data: { code: recoveryCodes[2] } })).status(), 200);
    await page.locator('#settings-button').click();
    assert.equal(await page.getByText('Generating recovery codes invalidates all previous recovery codes.').isVisible(), true);
    assert.equal(await page.locator('#mfa-manage-form button[value="codes"]').getAttribute('aria-describedby'), 'mfa-codes-warning');
    await page.locator('#mfa-manage-password').fill(password);
    await page.locator('#mfa-manage-form button[value="replace"]').click();
    await page.locator('#mfa-manage-enrollment').waitFor({ state: 'visible' });
    // Closing settings must not spend the recovery grant before confirmation.
    await page.locator('#settings-dialog').getByRole('button', { name: 'Close', exact: true }).click();
    await page.locator('#settings-dialog').waitFor({ state: 'hidden' });
    await page.locator('#settings-button').click();
    await page.locator('#mfa-manage-password').fill(password);
    await page.locator('#mfa-manage-form button[value="replace"]').click();
    await page.locator('#mfa-manage-enrollment').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#mfa-manage-new-code').getAttribute('inputmode'), 'numeric');
    const replacementSecret = await page.locator('#mfa-manage-secret').inputValue();
    currentSecret = replacementSecret;
    const replacementQR = await page.locator('#mfa-manage-qr').getAttribute('src');
    await page.locator('#mfa-manage-new-code').fill(authenticatorCode(replacementSecret));
    const heldReplacement = await holdResponse(page, '/api/mfa/verify');
    await page.locator('#mfa-manage-verify button[type="submit"]').click();
    await heldReplacement.ready;
    assert.equal(await page.locator('#settings-dialog').getByRole('button', { name: 'Close', exact: true }).isDisabled(), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#settings-dialog').isVisible(), true);
    heldReplacement.release();
    await page.locator('#mfa-manage-codes').waitFor({ state: 'visible' });
    await heldReplacement.remove();
    const replacementCodes = (await page.locator('#mfa-manage-codes-value').textContent()).trim().split('\n');
    assert.equal(replacementCodes.length, 10);
    assert.equal((await peer.request.get(new URL('/api/session', base).href)).status(), 401);
    // A displayed recovery code used for replacement is consumed by the real server.
    const replaceURL = new URL('/api/mfa/replace', base).href;
    const verifyURL = new URL('/api/mfa/verify', base).href;
    await page.locator('#mfa-manage-password').fill(password);
    await page.locator('#mfa-manage-code').fill(replacementCodes[0].replaceAll('-', '').toLowerCase());
    await page.locator('#mfa-manage-form button[value="replace"]').click();
    await page.locator('#mfa-manage-enrollment').waitFor({ state: 'visible' });
    await captureMFA(page, 'mfa-manage-replacement');
    assert.equal((await page.locator('#mfa-manage-codes-value').textContent()).trim(), replacementCodes.slice(1).join('\n'));
    await page.route(verifyURL, route => route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"invalid authentication code"}' }));
    await page.locator('#mfa-manage-new-code').fill('000000');
    await page.locator('#mfa-manage-verify button[type="submit"]').click();
    await page.locator('#mfa-manage-error').filter({ hasText: 'invalid authentication code' }).waitFor();
    assert.equal((await page.locator('#mfa-manage-codes-value').textContent()).trim(), replacementCodes.slice(1).join('\n'));
    await page.locator('#mfa-manage-cancel').click();
    await page.unroute(verifyURL);
    // A failure may follow consumption of the proof, so do not present it as unused.
    await page.route(replaceURL, route => route.fulfill({ status: 429, contentType: 'application/json', body: '{"error":"Synthetic challenge limit"}' }));
    await page.locator('#mfa-manage-password').fill(password);
    await page.locator('#mfa-manage-code').fill(replacementCodes[1]);
    await page.locator('#mfa-manage-form button[value="replace"]').click();
    await page.locator('#mfa-manage-feedback').filter({ hasText: 'may have been used' }).waitFor();
    assert.equal((await page.locator('#mfa-manage-codes-value').textContent()).trim(), replacementCodes.slice(2).join('\n'));
    await page.unroute(replaceURL);
    await page.route(replaceURL, route => route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"invalid or already used authentication code"}' }));
    await page.locator('#mfa-manage-password').fill(password);
    await page.locator('#mfa-manage-code').fill(replacementCodes[2]);
    await page.locator('#mfa-manage-form button[value="replace"]').click();
    await page.locator('#mfa-manage-feedback').filter({ hasText: 'has already been used' }).waitFor();
    assert.equal((await page.locator('#mfa-manage-codes-value').textContent()).trim(), replacementCodes.slice(3).join('\n'));
    await page.unroute(replaceURL);
    const codesURL = new URL('/api/mfa/recovery-codes', base).href;
    await page.route(codesURL, route => route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"invalid or already used authentication code"}' }));
    await page.locator('#mfa-manage-password').fill(password);
    await page.locator('#mfa-manage-code').fill(replacementCodes[3]);
    await page.locator('#mfa-manage-form button[value="codes"]').click();
    await page.locator('#mfa-manage-feedback').filter({ hasText: 'has already been used' }).waitFor();
    assert.equal((await page.locator('#mfa-manage-codes-value').textContent()).trim(), replacementCodes.slice(4).join('\n'));
    await page.unroute(codesURL);
    await page.route(codesURL, route => route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"incorrect password or authentication unavailable"}' }));
    await page.locator('#mfa-manage-password').fill('incorrect-password');
    await page.locator('#mfa-manage-code').fill(replacementCodes[4]);
    await page.locator('#mfa-manage-form button[value="codes"]').click();
    await page.locator('#mfa-manage-error').filter({ hasText: 'incorrect password' }).waitFor();
    assert.equal((await page.locator('#mfa-manage-codes-value').textContent()).trim(), replacementCodes.slice(4).join('\n'));
    await page.unroute(codesURL);
    await page.route(codesURL, route => route.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"Synthetic concurrent change"}' }));
    await page.locator('#mfa-manage-form button[value="codes"]').click();
    await page.locator('#mfa-manage-error').filter({ hasText: 'The change may have completed' }).waitFor();
    assert.equal(await page.locator('#mfa-manage-codes').isHidden(), true);
    await page.unroute(codesURL);
    // A 429 after proof consumption must retain its warning through a concurrent 401.
    for (const sessionFirst of [true, false]) {
      await page.locator('#mfa-manage-password').fill(password);
      await page.locator('#mfa-manage-code').fill(replacementCodes[4]);
      const expired = await holdUnauthorized(page, '/api/sessions');
      await page.locator('#sessions-refresh').click();
      await expired.ready;
      const limited = await holdUnauthorized(page, '/api/mfa/replace', 'Synthetic challenge limit', 429);
      await page.locator('#mfa-manage-form button[value="replace"]').click();
      await limited.ready;
      if (sessionFirst) {
        expired.release();
        await page.locator('#mfa-manage-feedback').filter({ hasText: 'Your session expired' }).waitFor();
        limited.release();
      } else {
        limited.release();
        await page.locator('#mfa-manage-feedback').filter({ hasText: 'may have been used' }).waitFor();
        expired.release();
      }
      await page.locator('#login-view').waitFor({ state: 'visible' });
      await page.locator('#login-error').filter({ hasText: 'may have been used' }).waitFor();
      await limited.remove();
      await expired.remove();
      await page.reload();
      await page.locator('#app-view').waitFor({ state: 'visible' });
      await page.locator('#settings-button').click();
    }
    await page.locator('#mfa-manage-password').fill(password);
    await page.locator('#mfa-manage-code').fill(replacementCodes[4]);
    // A concurrent expired-session response must not hide codes already committed.
    const heldSession = await holdUnauthorized(page, '/api/sessions');
    await page.locator('#sessions-refresh').click();
    await heldSession.ready;
    const heldCodes = await holdResponse(page, '/api/mfa/recovery-codes');
    await page.locator('#mfa-manage-form button[value="codes"]').click();
    await heldCodes.ready;
    assert.equal(await page.locator('#settings-dialog').getByRole('button', { name: 'Close', exact: true }).isDisabled(), true);
    assert.equal(await page.locator('[data-settings-section="backup-title"]').isDisabled(), true);
    assert.equal(await page.locator('[data-settings-section="mfa-settings-title"]').isEnabled(), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#settings-dialog').isVisible(), true);
    await page.evaluate(() => history.pushState({}, '', '?test=mfa-pending'));
    await page.goBack();
    assert.equal(await page.locator('#settings-dialog').isVisible(), true);
    const leaving = page.waitForEvent('dialog', { predicate: dialog => dialog.type() === 'beforeunload' });
    const navigation = page.goto(new URL('/?test=leave', base).href).catch(() => {});
    await (await leaving).dismiss();
    await navigation;
    assert.equal(await page.locator('#settings-dialog').isVisible(), true);
    heldSession.release();
    await page.locator('#mfa-manage-feedback').filter({ hasText: 'Your session expired' }).waitFor();
    assert.equal(await page.locator('#settings-dialog').isVisible(), true);
    heldCodes.release();
    await page.waitForFunction(() => document.getElementById('mfa-manage-codes-value').textContent.trim().split('\n').length === 10);
    await heldCodes.remove();
    await heldSession.remove();
    freshRecoveryCodes = (await page.locator('#mfa-manage-codes-value').textContent()).trim().split('\n');
    assert.equal(freshRecoveryCodes.length, 10);
    await page.locator('#mfa-manage-feedback').filter({ hasText: 'These recovery codes may have changed' }).waitFor();
    await page.locator('#settings-dialog').getByRole('button', { name: 'Close', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('mfa-manage-codes-value').textContent === '');
    assert.equal(await page.locator('#mfa-manage-codes-value').textContent(), '');
    assert.equal(await page.locator('#mfa-manage-secret').inputValue(), '');
    await page.locator('#login-view').waitFor({ state: 'visible' });
    // The 401 was synthetic; reloading uses the still-valid test session.
    await page.reload();
    await page.locator('#app-view').waitFor({ state: 'visible' });

    // An invalid TOTP and another expired-session response can arrive in
    // either order. Previously displayed codes may no longer be valid.
    for (const sessionFirst of [true, false]) {
      await page.locator('#settings-button').click();
      await page.route(codesURL, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ recoveryCodes: replacementCodes.slice(4) }) }));
      await page.locator('#mfa-manage-password').fill(password);
      await page.locator('#mfa-manage-code').fill('123456');
      await page.locator('#mfa-manage-form button[value="codes"]').click();
      await page.locator('#mfa-manage-codes').waitFor({ state: 'visible' });
      await page.unroute(codesURL);
      await page.route(replaceURL, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ secret: replacementSecret, qr: replacementQR }) }));
      await page.locator('#mfa-manage-password').fill(password);
      await page.locator('#mfa-manage-code').fill('123456');
      await page.locator('#mfa-manage-form button[value="replace"]').click();
      await page.locator('#mfa-manage-enrollment').waitFor({ state: 'visible' });
      await page.unroute(replaceURL);
      const expired = await holdUnauthorized(page, '/api/sessions');
      await page.locator('#sessions-refresh').click();
      await expired.ready;
      const invalid = await holdUnauthorized(page, '/api/mfa/verify', 'invalid authentication code');
      await page.locator('#mfa-manage-new-code').fill('000000');
      await page.locator('#mfa-manage-verify button[type="submit"]').click();
      await invalid.ready;
      if (sessionFirst) {
        expired.release();
        await page.locator('#mfa-manage-feedback').filter({ hasText: 'Your session expired' }).waitFor();
        invalid.release();
      } else {
        invalid.release();
        await page.locator('#mfa-manage-error').filter({ hasText: 'invalid authentication code' }).waitFor();
        expired.release();
      }
      await page.locator('#mfa-manage-feedback').filter({ hasText: 'These recovery codes may have changed' }).waitFor();
      assert.equal((await page.locator('#mfa-manage-codes-value').textContent()).trim(), replacementCodes.slice(4).join('\n'));
      await invalid.remove();
      await expired.remove();
      await page.locator('#settings-dialog').getByRole('button', { name: 'Close', exact: true }).click();
      await page.locator('#login-view').waitFor({ state: 'visible' });
      await page.reload();
      await page.locator('#app-view').waitFor({ state: 'visible' });
    }
  } finally { await peer.close(); }

  const original = 'Browser integration bookmark';
  const revised = 'Browser revised bookmark';
  await page.locator('#add-bookmark').click();
  // A private destination is deliberately rejected by the capture worker: no public network.
  await page.locator('#bookmark-url').fill('http://127.0.0.1/e2e-fixture');
  await page.locator('#bookmark-title').fill(original);
  await page.locator('#bookmark-notes').fill('Persisted browser notes');
  await page.locator('#bookmark-tags-query').fill('reading');
  await page.locator('#bookmark-tags-query').press('Enter');
  await page.locator('#save-bookmark').click();
  const card = title => page.locator('.bookmark-card').filter({ has: page.getByRole('button', { name: title, exact: true }) });
  const openActions = async title => {
    const toggle = card(title).getByRole('button', { name: `Actions for ${title}`, exact: true });
    if (await toggle.isVisible()) await toggle.click();
  };
  await card(original).waitFor();
  await page.setViewportSize({ width: 320, height: 700 });
  await card(original).getByRole('checkbox', { name: `Select ${original}` }).check();
  for (const id of ['bulk-open', 'clear-selection']) {
    assert.ok(await page.locator(`#${id}`).evaluate(node => node.getBoundingClientRect().height >= 44), `${id} has a mobile touch target`);
  }
  await page.locator('#bulk-open').click();
  await page.locator('#bulk-action').selectOption('capture');
  assert.ok(await page.locator('#bulk-apply').evaluate(node => {
    const button = node.getBoundingClientRect(), dialog = node.closest('dialog').getBoundingClientRect();
    return button.height >= 44 && button.left >= dialog.left && button.right <= dialog.right;
  }), 'the bulk action fits the mobile dialog');
  await page.locator('#bulk-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('#clear-selection').click();
  for (const [endpoint, input, status, file] of [
    ['**/api/import', '#import-file', '#import-progress', { name: 'bookmarks.json', mimeType: 'application/json', buffer: Buffer.from('{}') }],
    ['**/api/files?*', '#library-file', '#upload-progress', { name: 'fixture.png', mimeType: 'image/png', buffer: Buffer.from('fixture') }],
  ]) {
    let release, notify;
    const requested = new Promise(resolve => { notify = resolve; });
    const delayed = async route => { notify(); await new Promise(resolve => { release = resolve; }); await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }); };
    await page.route(endpoint, delayed);
    await page.locator(input).setInputFiles(file);
    await requested;
    assert.equal(await page.locator(status).isVisible(), true, `${status} is visible during the operation`);
    release();
    await page.locator(status).waitFor({ state: 'hidden' });
    await page.unroute(endpoint, delayed);
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.locator('#all-tags').click();
  await page.locator('#tags-list').getByRole('button', { name: '#reading 1 bookmark' }).waitFor();
  await page.setViewportSize({ width: 320, height: 700 });
  assert.equal(await page.locator('#tags-alphabet').isVisible(), false);
  await page.locator('#tags-letter-picker').selectOption('R');
  await page.waitForFunction(() => document.activeElement.id === 'tags-letter-R');
  await page.locator('#tags-list').getByRole('button', { name: '#reading 1 bookmark' }).click();
  await card(original).waitFor();
  await page.getByRole('button', { name: 'Remove #reading filter' }).click();
  await page.setViewportSize({ width: 1280, height: 720 });
  const collectionName = 'A deliberately long collection name for mobile navigation';
  const collectionResponse = await page.request.post(new URL('/api/collections', base).href, { data: { name: collectionName, parentId: null } });
  assert.equal(collectionResponse.status(), 201);
  await page.locator('#refresh-button').click();
  await page.getByRole('button', { name: collectionName, exact: true }).waitFor();
  await page.setViewportSize({ width: 320, height: 700 });
  await page.locator('#open-navigation').click();
  const collection = page.getByRole('button', { name: collectionName, exact: true });
  assert.ok(await collection.evaluate(node => node.getBoundingClientRect().height > 44), 'long collection names wrap on mobile');
  const confirmation = page.waitForEvent('dialog');
  const deleting = page.getByRole('button', { name: `Delete ${collectionName}`, exact: true }).click();
  const prompt = await confirmation;
  assert.match(prompt.message(), /Direct subcollections move to the library root/);
  await prompt.dismiss(); await deleting;
  assert.equal(await collection.isVisible(), true);
  await page.locator('#close-navigation').click();
  await page.setViewportSize({ width: 1280, height: 720 });
  await collection.click();
  await page.locator('#empty-title').filter({ hasText: 'This collection is empty' }).waitFor();
  await page.locator('#empty-add').click();
  assert.equal(await page.locator('#bookmark-collection option:checked').textContent(), collectionName);
  await page.locator('#bookmark-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('#empty-reset').click();
  await card(original).waitFor();
  const failLibrary = route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
  await page.route('**/api/links?*', failLibrary);
  await page.locator('#refresh-button').click();
  await page.locator('#library-error').getByRole('button', { name: 'Try again' }).waitFor();
  assert.equal(await card(original).isVisible(), true, 'a failed refresh preserves the last results for the same view');
  assert.match(await page.locator('#library-error').textContent(), /Showing the last loaded results/);
  await page.unroute('**/api/links?*', failLibrary);
  await page.locator('#library-error').getByRole('button', { name: 'Try again' }).click();
  await page.locator('#library-error').waitFor({ state: 'hidden' });
  let releaseDelayedFailure;
  let notifyRequest;
  const requested = new Promise(resolve => { notifyRequest = resolve; });
  const delayedFailure = async route => {
    notifyRequest();
    await new Promise(resolve => { releaseDelayedFailure = resolve; });
    await failLibrary(route);
  };
  await page.route('**/api/links?*', delayedFailure);
  await page.locator('[data-filter="favorite"]').click();
  await requested;
  assert.equal(await card(original).isVisible(), false, 'old results are hidden while a different view loads');
  assert.equal(await page.locator('#empty-state').isVisible(), false);
  assert.equal(await page.locator('#page-title').evaluate(node => document.activeElement === node), true, 'focus stays on the new view heading');
  assert.match(await page.locator('#results-label').textContent(), /Loading/);
  releaseDelayedFailure();
  await page.locator('#library-error').getByRole('button', { name: 'Try again' }).waitFor();
  assert.equal(await card(original).isVisible(), false, 'old results do not appear under a failed new filter');
  assert.equal(await page.locator('#empty-state').isVisible(), false, 'a failed request is not presented as an empty view');
  await page.unroute('**/api/links?*', delayedFailure);
  await page.locator('#library-error').getByRole('button', { name: 'Try again' }).click();
  await page.locator('#empty-title').filter({ hasText: 'No favorites yet' }).waitFor();
  assert.equal(await page.locator('#empty-add').isVisible(), false);
  await page.locator('#empty-reset').click();
  await card(original).waitFor();
  await page.locator('#search').fill('browzer');
  await page.locator('#empty-near-matches').waitFor({ state: 'visible' });
  await page.locator('#empty-near-matches').click();
  await card(original).waitFor();
  assert.equal(await page.locator('#fuzzy-search').isChecked(), true);
  await page.locator('#search').fill('absent-e2e-bookmark-42');
  await page.locator('#empty-title').filter({ hasText: 'No bookmarks found' }).waitFor();
  await page.locator('#empty-reset').click();
  assert.equal(await page.locator('#fuzzy-search').isChecked(), false);
  assert.equal(await page.locator('#search').inputValue(), '');
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

  // A gateway timeout can conceal a committed change. The recovery warning
  // must survive an unrelated expired-session response and remain visible.
  for (const sessionFirst of [true, false]) {
    if (sessionFirst) {
      await page.locator('#login-username').fill(username);
      await page.locator('#login-password').fill(password);
      await page.locator('#login-submit').click();
      await page.locator('#mfa-code-form').waitFor({ state: 'visible' });
      await page.locator('#mfa-code').fill(freshRecoveryCodes[0]);
      const verification = page.waitForResponse(response => response.url().endsWith('/api/mfa/verify') && response.request().method() === 'POST');
      await page.locator('#mfa-code-form button').click();
      if ((await verification).status() === 429) {
        // Earlier security journeys deliberately consume the account-wide MFA
        // budget. Wait for its real window instead of bypassing the limiter.
        await new Promise(resolve => setTimeout(resolve, 60000));
        await new Promise(resolve => setTimeout(resolve, 1000));
        await page.locator('#mfa-code-form button').click();
      }
      await page.waitForFunction(() => !document.getElementById('app-view').hidden || document.getElementById('login-error').textContent);
      assert.equal(await page.locator('#login-error').textContent(), '', 'recovery-code login failed');
      await page.locator('#app-view').waitFor({ state: 'visible' });
    } else {
      // The preceding 401 was synthetic; the actual session is still valid.
      await page.reload();
      await page.locator('#app-view').waitFor({ state: 'visible' });
    }
    await page.locator('#settings-button').click();
    const expiredRequest = await holdUnauthorized(page, '/api/sessions');
    await page.locator('#sessions-refresh').click();
    await expiredRequest.ready;
    await page.locator('#mfa-manage-password').fill(password);
    await page.locator('#mfa-manage-code').fill(sessionFirst ? freshRecoveryCodes[1] : authenticatorCode(currentSecret, 30));
    const gatewayFailure = await holdGatewayFailureAfterCommit(page, '/api/mfa/recovery-codes');
    await page.locator('#mfa-manage-form button[value="codes"]').click();
    await gatewayFailure.ready;
    if (sessionFirst) {
      expiredRequest.release();
      await page.locator('#mfa-manage-feedback').filter({ hasText: 'Your session expired' }).waitFor();
      gatewayFailure.release();
    } else {
      gatewayFailure.release();
      await page.locator('#mfa-manage-error').filter({ hasText: 'The change may have completed' }).waitFor();
      expiredRequest.release();
    }
    await page.locator('#login-view').waitFor({ state: 'visible' });
    await page.locator('#login-error').filter({ hasText: 'The change may have completed' }).waitFor();
    await gatewayFailure.remove();
    await expiredRequest.remove();
  }
  assert.deepEqual(errors, [], 'browser must not throw uncaught JavaScript errors');
  console.log('Browser E2E passed: setup, login rejection/login, CRUD, search, reload persistence, image/PDF/HTML previews and isolation, logout.');
} finally {
  await browser.close();
}
