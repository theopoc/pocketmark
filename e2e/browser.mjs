import { clickNavigation, openNavigation, navigationJourney, dialogDismissalJourney } from './navigation.mjs';
// Real Chromium, real HTTP and SQLite. Run only against the disposable smoke instance.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { selectionJourney } from './selection.mjs';
import { securityJourney } from './security.mjs';
import { openSettings, refreshSessionsBeforeMFA } from './settings.mjs';

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
async function assertRecoveryDownload(page, button, codes) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator(button).click()]);
  assert.equal(download.suggestedFilename(), 'pocketmark-recovery-codes.txt');
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString('utf8'), codes.join('\n') + '\n');
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
      assert.ok(await page.locator('#settings-page').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1), `${name}-${suffix} dialog overflows`);
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
  assert.equal(await page.locator('.skip-link').isVisible(), false, 'library shortcut is unavailable before sign-in');
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
  await assertRecoveryDownload(page, '#mfa-login-download', recoveryCodes);
  await page.locator('#mfa-login-continue').click();
  await page.locator('#app-view').waitFor({ state: 'visible' });
  const libraryURL = page.url();
  await page.locator('.skip-link').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'main-content', 'library shortcut moves keyboard focus to the main content');
  assert.equal(page.url(), libraryURL, 'library shortcut does not add a history entry');
  await navigationJourney(page);
  await dialogDismissalJourney(page);
  await selectionJourney(page);
  const oldSession = (await page.context().cookies()).find(cookie => cookie.name === 'pocketmark');
  await clickNavigation(page, '#logout-button');
  await page.locator('#logout-confirm').click();
  await page.locator('#login-view').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.skip-link').isVisible(), false, 'library shortcut is unavailable after sign-out');
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
    await openSettings(page, '2fa');
    assert.equal(await page.getByText('Generating recovery codes invalidates all previous recovery codes.').isVisible(), true);
    assert.equal(await page.locator('#mfa-manage-form button[value="codes"]').getAttribute('aria-describedby'), 'mfa-codes-warning');
    await page.locator('#mfa-manage-password').fill(password);
    await page.locator('#mfa-manage-form button[value="replace"]').click();
    await page.locator('#mfa-manage-enrollment').waitFor({ state: 'visible' });
    // Closing settings must not spend the recovery grant before confirmation.
    await page.locator('#settings-page [data-settings-back]').click();
    await page.locator('#settings-page').waitFor({ state: 'hidden' });
    await openSettings(page, '2fa');
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
    assert.equal(await page.locator('#settings-page [data-settings-back]').isDisabled(), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#settings-page').isVisible(), true);
    heldReplacement.release();
    await page.locator('#mfa-manage-codes').waitFor({ state: 'visible' });
    await heldReplacement.remove();
    const replacementCodes = (await page.locator('#mfa-manage-codes-value').textContent()).trim().split('\n');
    assert.equal(replacementCodes.length, 10);
    await assertRecoveryDownload(page, '#mfa-manage-download', replacementCodes);
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
      await refreshSessionsBeforeMFA(page);
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
      await openSettings(page, '2fa');
    }
    await page.locator('#mfa-manage-password').fill(password);
    await page.locator('#mfa-manage-code').fill(replacementCodes[4]);
    // A concurrent expired-session response must not hide codes already committed.
    const heldSession = await holdUnauthorized(page, '/api/sessions');
    await refreshSessionsBeforeMFA(page);
    await heldSession.ready;
    const heldCodes = await holdResponse(page, '/api/mfa/recovery-codes');
    await page.locator('#mfa-manage-form button[value="codes"]').click();
    await heldCodes.ready;
    assert.equal(await page.locator('#settings-page [data-settings-back]').isDisabled(), true);
    assert.equal(await page.locator('[data-settings-section="backup"]').isDisabled(), true);
    assert.equal(await page.locator('[data-settings-section="2fa"]').isEnabled(), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#settings-page').isVisible(), true);
    await page.evaluate(() => history.pushState({}, '', '?test=mfa-pending'));
    await page.goBack();
    assert.equal(await page.locator('#settings-page').isVisible(), true);
    const leaving = page.waitForEvent('dialog', { predicate: dialog => dialog.type() === 'beforeunload' });
    const navigation = page.goto(new URL('/?test=leave', base).href).catch(() => {});
    await (await leaving).dismiss();
    await navigation;
    assert.equal(await page.locator('#settings-page').isVisible(), true);
    heldSession.release();
    await page.locator('#mfa-manage-feedback').filter({ hasText: 'Your session expired' }).waitFor();
    assert.equal(await page.locator('#settings-page').isVisible(), true);
    heldCodes.release();
    await page.waitForFunction(() => document.getElementById('mfa-manage-codes-value').textContent.trim().split('\n').length === 10);
    await heldCodes.remove();
    await heldSession.remove();
    freshRecoveryCodes = (await page.locator('#mfa-manage-codes-value').textContent()).trim().split('\n');
    assert.equal(freshRecoveryCodes.length, 10);
    await page.locator('#mfa-manage-feedback').filter({ hasText: 'These recovery codes may have changed' }).waitFor();
    await page.locator('#settings-page [data-settings-back]').click();
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
      await openSettings(page, '2fa');
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
      await refreshSessionsBeforeMFA(page);
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
      await page.locator('#settings-page [data-settings-back]').click();
      await page.locator('#login-view').waitFor({ state: 'visible' });
      await page.reload();
      await page.locator('#app-view').waitFor({ state: 'visible' });
    }
  } finally { await peer.close(); }

  await clickNavigation(page, '#add-collection');
  await page.locator('#collection-name').fill('é'.repeat(61));
  await page.locator('#save-collection').click();
  await page.locator('#collection-error').filter({ hasText: '120 UTF-8 bytes' }).waitFor();
  assert.equal(await page.locator('#collection-name').inputValue(), 'é'.repeat(61));
  assert.equal(await page.locator('#save-collection').isEnabled(), true);
  await page.locator('#collection-dialog').getByRole('button', { name: 'Cancel' }).click();

  // A late collection response must not close or overwrite a newly opened editor.
  for (const succeeds of [true, false]) {
    const held = succeeds ? await holdResponse(page, '/api/collections') : await holdUnauthorized(page, '/api/collections', 'Earlier collection failed', 503);
    await clickNavigation(page, '#add-collection');
    await page.locator('#collection-name').fill(succeeds ? 'Earlier collection' : 'Failed collection');
    await page.locator('#save-collection').click(); await held.ready;
    await page.locator('#collection-dialog').getByRole('button', { name: 'Cancel' }).click();
    await clickNavigation(page, '#add-collection');
    await page.locator('#collection-name').fill('New collection draft');
    assert.equal(await page.locator('#save-collection').isEnabled(), true);
    held.release();
    await page.getByText(succeeds ? 'Collection created.' : 'The server could not complete this action.', { exact: false }).first().waitFor();
    await held.remove();
    assert.equal(await page.locator('#collection-dialog').isVisible(), true);
    assert.equal(await page.locator('#collection-name').inputValue(), 'New collection draft');
    assert.equal(await page.locator('#collection-error').textContent(), '');
    await page.locator('#collection-dialog').getByRole('button', { name: 'Cancel' }).click();
  }
  const pendingCollection = await holdResponse(page, '/api/collections');
  await clickNavigation(page, '#add-collection');
  await page.locator('#collection-name').fill('Collection before save');
  await page.locator('#save-collection').click(); await pendingCollection.ready;
  await page.locator('#collection-name').fill('Collection after save');
  pendingCollection.release();
  await page.getByText('Saved. Your newer collection edits are still open.').waitFor();
  await pendingCollection.remove();
  assert.equal(await page.locator('#collection-name').inputValue(), 'Collection after save');
  await page.locator('#save-collection').click();
  await page.locator('#collection-dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Collection after save', exact: true, includeHidden: true }).waitFor({ state: 'attached' });
  assert.equal(await page.getByRole('button', { name: 'Collection before save', exact: true, includeHidden: true }).count(), 0);

  const original = 'Browser integration bookmark';
  const revised = 'Browser revised bookmark';
  await page.locator('#add-bookmark').click();
  // A private destination is deliberately rejected by the capture worker: no public network.
  await page.locator('#bookmark-url').fill('http://127.0.0.1/e2e-fixture');
  await page.locator('#bookmark-title').fill(original);
  await page.locator('#bookmark-notes').fill('Persisted browser notes');
  const tagSuggestionsFailure = route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
  await page.route('**/api/tags/browse?*', tagSuggestionsFailure);
  await page.locator('#bookmark-tags-query').fill('recovery-tag');
  const retryTags = page.getByRole('button', { name: 'Retry tag suggestions' });
  await retryTags.waitFor({ state: 'visible' });
  await page.locator('#bookmark-tags-query').press('Tab');
  assert.equal(await retryTags.evaluate(node => document.activeElement === node), true, 'keyboard users can reach the retry action');
  await page.unroute('**/api/tags/browse?*', tagSuggestionsFailure);
  await retryTags.press('Enter');
  await retryTags.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#bookmark-tags-query').inputValue(), 'recovery-tag');
  await page.locator('#bookmark-tags-query').fill('');
  await page.locator('#bookmark-tags-query').fill('reading');
  await page.locator('#bookmark-tags-query').press('Enter');
  for (const tag of ['design', 'research', 'archive', 'reference', 'web']) {
    await page.locator('#bookmark-tags-query').fill(tag);
    await page.locator('#bookmark-tags-query').press('Enter');
  }
  await page.locator('#save-bookmark').click();
  const card = title => page.locator('.bookmark-card').filter({ has: page.getByRole('button', { name: title, exact: true }) });
  const openActions = async title => {
    const toggle = card(title).getByRole('button', { name: `Actions for ${title}`, exact: true });
    if (await toggle.isVisible()) await toggle.click();
  };
  await card(original).waitFor();
  await page.getByRole('button', { name: 'Sort bookmarks: Newest first', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Title Z–A', exact: true }).click();
  await page.waitForURL(url => url.searchParams.get('sort') === 'title_desc');
  await page.reload();
  await card(original).waitFor();
  await page.getByRole('button', { name: 'Sort bookmarks: Title Z–A', exact: true }).click();
  assert.equal(await page.getByRole('menuitemradio', { name: 'Title Z–A', exact: true }).getAttribute('aria-checked'), 'true', 'descending title sort survives reload');
  await page.getByRole('menuitemradio', { name: 'Newest first', exact: true }).click();
  await page.waitForURL(url => !url.searchParams.has('sort'));
  await clickNavigation(page, '#help-button');
  await page.locator('#help-search').fill('retry capture');
  const captureHelp = page.locator('#help-topics > details').filter({ hasText: 'Failed or missing captures' });
  assert.equal(await captureHelp.isVisible(), true);
  assert.equal(await captureHelp.evaluate(node => node.open), true);
  await page.locator('#help-search').fill('Floccus sync');
  const syncHelp = page.locator('#help-topics > details').filter({ hasText: 'Extensions & browser sync' });
  assert.equal(await syncHelp.isVisible(), true);
  assert.equal(await syncHelp.evaluate(node => node.open), true);
  await page.locator('#help-dialog').getByRole('button', { name: 'Close help' }).click();
  await page.goto(new URL('/?tag=no-such-tag-e2e', base).href);
  await page.locator('#empty-title').filter({ hasText: 'No bookmarks with this tag' }).waitFor();
  assert.equal(await page.locator('#empty-add').isVisible(), false);
  await page.getByRole('button', { name: 'View all bookmarks', exact: true }).click();
  await card(original).waitFor();
  const moreTags = card(original).getByRole('button', { name: `Show all 6 tags for ${original}` });
  await moreTags.focus();
  await moreTags.press('Enter');
  assert.equal(await card(original).locator('.card-tags button').nth(5).evaluate(node => document.activeElement === node), true, 'expanding tags moves focus to the first revealed tag');
  await page.locator('#refresh-button').evaluate(button => button.click());
  await page.waitForFunction(() => document.querySelector('#bookmark-grid').getAttribute('aria-busy') === 'false');
  assert.equal(await card(original).locator('.card-tags button').nth(5).evaluate(node => document.activeElement === node), true, 'refresh preserves the revealed tag and its focus');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.locator('#view-grid').click();
  assert.equal(await page.locator('.breadcrumb-root').textContent(), 'My library');
  const gridHeader = card(original).locator('.card-top');
  assert.equal(await gridHeader.locator('.card-domain').textContent(), '127.0.0.1');
  assert.equal(await gridHeader.locator('.card-domain').getAttribute('title'), 'http://127.0.0.1/e2e-fixture');
  assert.equal(await gridHeader.locator('.favorite-button').count(), 1, 'grid favorite is in the card header');
  assert.equal(await card(original).locator('.card-footer .card-overflow-actions .card-action').count(), 4, 'grid retains its four footer actions');
  assert.equal(await gridHeader.getByRole('button', { name: `Add to favorites: ${original}` }).getAttribute('aria-pressed'), 'false');
  await card(original).hover();
  await page.waitForFunction(title => {
    const card = [...document.querySelectorAll('.bookmark-card')].find(node => node.textContent.includes(title));
    return card && getComputedStyle(card).transform !== 'none';
  }, original);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(title => {
    const card = [...document.querySelectorAll('.bookmark-card')].find(node => node.textContent.includes(title));
    return card && getComputedStyle(card).transform === 'none';
  }, original);
  await page.locator('#view-list').click();
  assert.equal(await card(original).locator('.card-title-row .favorite-button').count(), 1, 'list view restores its existing favorite position');
  assert.equal(await card(original).locator('.card-body > .card-domain').count(), 1, 'list view restores its existing domain position');
  await page.locator('#add-bookmark').click();
  assert.ok(await page.locator('#bookmark-dialog').evaluate(node => getComputedStyle(node).transitionDuration.split(',').every(value => parseFloat(value) === 0)), 'reduced motion removes dialog transitions');
  await page.locator('#bookmark-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.setViewportSize({ width: 320, height: 700 });
  await page.locator('#view-grid').click();
  assert.ok(await card(original).locator('.card-top').evaluate(node => {
    const header = node.getBoundingClientRect(), star = node.querySelector('.favorite-button').getBoundingClientRect();
    return node.scrollWidth <= node.clientWidth + 1 && star.width >= 44 && star.height >= 44 && star.right <= header.right;
  }), 'the grid header and favorite fit at narrow mobile widths');
  await page.locator('#view-list').click();
  await page.locator('#add-bookmark').click();
  for (const selector of ['#bookmark-dialog .dialog-heading .icon-button', '#save-bookmark', '#bookmark-favorite', '#bookmark-read']) {
    assert.ok(await page.locator(selector).evaluate(node => (node.matches('input') ? node.closest('label') : node).getBoundingClientRect().height >= 44), `${selector} has a mobile touch target`);
  }
  assert.ok(await page.locator('#bookmark-dialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1), 'mobile bookmark form does not overflow');
  await page.locator('#bookmark-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await card(original).focus();
  await page.keyboard.press("Space");
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
  await card(original).getByRole('button', { name: `Add to favorites: ${original}` }).click();
  const undo = page.locator('#toast').getByRole('button', { name: 'Undo' });
  await undo.waitFor({ state: 'visible' });
  await undo.focus();
  await page.waitForTimeout(12500);
  assert.equal(await undo.isVisible(), true, 'the undo action stays available while focused');
  await undo.press('Enter');
  await card(original).getByRole('button', { name: `Add to favorites: ${original}` }).waitFor();
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
  const currentLinks = await (await page.request.get(new URL('/api/links', base).href)).json();
  const originalID = currentLinks.links.find(link => link.title === original).id;
  const readerURL = new URL(`/api/links/${originalID}`, base).href;
  const failReader = route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
  await page.route(readerURL, failReader);
  await card(original).getByRole('button', { name: original, exact: true }).click();
  await page.locator('#reader-dialog').waitFor({ state: 'visible' });
  await page.locator('#reader-retry-open').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#reader-files').isVisible(), false, 'unavailable reader actions are hidden after an opening failure');
  assert.equal(await page.locator('#reader-section-nav').isVisible(), false);
  await page.unroute(readerURL, failReader);
  await page.locator('#reader-retry-open').click();
  await page.locator('#reader-title').filter({ hasText: original }).waitFor();
  assert.equal(await page.locator('#reader-retry-open').isVisible(), false);
  assert.equal(await page.locator('#reader-files').isVisible(), false);
  assert.equal(await page.locator('#reader-formats').isVisible(), true);
  assert.equal(await page.locator('#reader-content').isVisible(), false);
  for (const format of ['html', 'image', 'pdf']) {
    assert.equal(await page.locator(`#reader-format-${format}`).isVisible(), true);
    assert.ok(await page.locator(`#reader-format-${format}`).evaluate(node => node.getBoundingClientRect().height >= 44));
  }
  await page.locator('#reader-options summary').click();
  for (const selector of ['#reader-original', '#reader-notebook-toggle', '#reader-text-mode', '#reader-size']) {
    assert.ok(await page.locator(selector).evaluate(node => node.getBoundingClientRect().height >= 44), `${selector} has a mobile touch target`);
  }
  await page.locator('#reader-notebook-toggle').click();
  await page.locator('#reader-tab-files').click();
  assert.ok(await page.locator('#asset-upload-button').evaluate(node => node.getBoundingClientRect().height >= 44));
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#asset-upload-button').click();
  await (await chooser).setFiles([]);
  await page.getByRole('button', { name: 'Close reader', exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 720 });
  await card(original).getByRole('button', { name: original, exact: true }).click();
  await page.locator('#reader-title').filter({ hasText: original }).waitFor();
  const readerBounds = await page.locator('#reader-dialog').boundingBox();
  await page.mouse.move(readerBounds.x + 50, readerBounds.y + 50);
  await page.mouse.down();
  await page.mouse.move(1, 1);
  await page.mouse.up();
  assert.equal(await page.locator('#reader-dialog').isVisible(), true, 'dragging out of the reader does not close it');
  await page.mouse.click(1, 1);
  await page.locator('#reader-dialog').waitFor({ state: 'hidden' });
  await card(original).getByRole('button', { name: original, exact: true }).click();
  await page.locator('#reader-title').filter({ hasText: original }).waitFor();
  await page.getByRole('button', { name: 'Close reader', exact: true }).click();
  const pagedTags = route => {
    const pageNumber = Number(new URL(route.request().url()).searchParams.get('page'));
    const tags = Array.from({ length: pageNumber === 1 ? 40 : 1 }, (_, index) => ({ name: `tag-${String((pageNumber - 1) * 40 + index).padStart(2, '0')}`, count: 1, letter: 'T' }));
    return route.fulfill({ json: { tags, groups: [{ letter: 'T', count: 41 }], total: 41, page: pageNumber, pageSize: 40 } });
  };
  await page.route('**/api/tags/browse?*', pagedTags);
  await clickNavigation(page, '#all-tags');
  await page.locator('#tags-next').waitFor({ state: 'visible' });
  await page.locator('#tags-next').focus();
  await page.locator('#tags-next').press('Enter');
  await page.locator('#tags-page-label').filter({ hasText: 'Page 2 of 2' }).waitFor();
  assert.equal(await page.locator('#tags-title').evaluate(node => document.activeElement === node), true, 'pagination returns keyboard focus to the directory heading');
  await page.unroute('**/api/tags/browse?*', pagedTags);
  await page.locator('#tags-retry').click();
  await page.locator('#tags-list').getByRole('button', { name: '#reading 1 bookmark' }).waitFor();
  await page.setViewportSize({ width: 320, height: 700 });
  assert.equal(await page.locator('#tags-alphabet').isVisible(), false);
  await page.locator('#tags-search').fill('no-such-tag-e2e');
  await page.locator('#tags-clear-search').waitFor({ state: 'visible' });
  await page.locator('#tags-clear-search').click();
  assert.equal(await page.locator('#tags-search').inputValue(), '');
  assert.equal(await page.locator('#tags-search').evaluate(node => document.activeElement === node), true);
  await page.locator('#tags-list').getByRole('button', { name: '#reading 1 bookmark' }).waitFor();
  await page.locator('#tags-letter-picker').selectOption('R');
  await page.waitForFunction(() => document.activeElement.id === 'tags-letter-R');
  await page.locator('#tags-list').getByRole('button', { name: '#reading 1 bookmark' }).click();
  await card(original).waitFor();
  assert.equal(await page.locator('#active-filters').isVisible(), false, 'the tag view has no redundant removable navigation chip');
  await page.locator('#search').fill('synthetic-filter-check');
  await page.getByRole('button', { name: 'Remove Search: synthetic-filter-check filter', exact: true }).click();
  await page.locator('#active-filters').waitFor({ state: 'hidden' });
  assert.equal(new URL(page.url()).searchParams.get('tag'), 'reading', 'clearing search preserves the tag view');
  await clickNavigation(page, '[data-filter="all"]');
  await page.setViewportSize({ width: 1280, height: 720 });
  const collectionName = 'A deliberately long collection name for mobile navigation';
  const collectionResponse = await page.request.post(new URL('/api/collections', base).href, { data: { name: collectionName, parentId: null } });
  assert.equal(collectionResponse.status(), 201);
  await page.locator('#refresh-button').click();
  await openNavigation(page);
  await page.getByRole('button', { name: collectionName, exact: true }).waitFor();
  assert.ok(await page.getByRole('button', { name: collectionName, exact: true }).evaluate(node => node.getBoundingClientRect().height > 44), 'long collection names wrap on desktop');
  await page.setViewportSize({ width: 320, height: 700 });
  await openNavigation(page);
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
  await openNavigation(page);
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
  await clickNavigation(page, '[data-filter="favorite"]');
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
  const nearMatchResponse = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/links' && url.searchParams.get('q') === 'browzer' && url.searchParams.get('fuzzy') === '1' && response.ok();
  });
  await page.locator('#search').fill('browzer');
  await nearMatchResponse;
  await card(original).waitFor();
  assert.equal(await page.locator('#fuzzy-search').count(), 0, 'near matches are automatic with no toggle');
  await page.locator('#search').fill('absent-e2e-bookmark-42');
  await page.locator('#empty-title').filter({ hasText: 'No bookmarks found' }).waitFor();
  await page.locator('#empty-reset').click();

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
  await page.waitForURL(url => url.searchParams.get('q') === 'Browser revised');
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
  assert.equal(await page.locator('#reader-content').isVisible(), false);
  await page.getByRole('button', { name: 'Open saved HTML', exact: true }).click();
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
  await page.getByRole('button', { name: 'Close preview', exact: true }).click();
  await page.getByRole('button', { name: 'Open saved Screenshot', exact: true }).click();
  await page.waitForFunction(() => { const image = document.querySelector('#asset-viewer-content img'); return image?.complete && image.naturalWidth > 0; });
  const nativeViewer = page.waitForEvent('framenavigated', { predicate: frame => frame.url().startsWith('chrome-extension://') });
  await page.getByRole('button', { name: 'Close preview', exact: true }).click();
  await page.getByRole('button', { name: 'Open saved PDF', exact: true }).click();
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
  await clickNavigation(page, '#logout-button');
  await page.locator('#logout-confirm').click();
  await page.locator('#login-view').waitFor({ state: 'visible' });
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
    await openSettings(page, '2fa');
    const expiredRequest = await holdUnauthorized(page, '/api/sessions');
    await refreshSessionsBeforeMFA(page);
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
