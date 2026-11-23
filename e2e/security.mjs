import { clickNavigation, openNavigation } from './navigation.mjs';
// Real HTTP/browser regression. Uses only the disposable instance's synthetic owner.
import assert from 'node:assert/strict';
import { selectSettings, settingsNavigationJourney } from './settings.mjs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

async function chooseOption(page, id, label) {
  const trigger = page.locator(`#${id}-trigger`);
  await trigger.click();
  assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
  await page.locator(`#${id}-options`).getByRole('option', { name: label, exact: true }).click();
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
}

// Hold a real, successful server result after commit; reauthentication challenges
// and newer list requests continue through the normal HTTP path.
async function holdKeyResponse(page, url, method) {
  let receive, release, captured = false;
  const ready = new Promise(resolve => { receive = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const handler = async route => {
    if (route.request().method() !== method || captured) return route.fallback();
    const response = await route.fetch();
    if (response.ok()) {
      captured = true;
      receive();
      await barrier;
    }
    await route.fulfill({ response });
    await response.dispose();
  };
  await page.route(url, handler);
  return {ready, release, remove: () => page.unroute(url, handler)};
}

async function assertKeyRouteProtected(page) {
  await page.evaluate(() => new Promise(resolve => {
    window.addEventListener('popstate', () => requestAnimationFrame(resolve), {once: true});
    history.back();
  }));
  assert.equal(new URL(page.url()).searchParams.get('settings'), 'api-keys');
  assert.equal(await page.locator('#key-dialog').isVisible(), true);
  assert.equal(await page.evaluate(() => {
    const e = new Event('beforeunload', {cancelable:true});
    window.dispatchEvent(e); return e.defaultPrevented;
  }), true);
}

// Records every key API response the page receives so a timeout can say whether
// the list read lacked the peer's key or the local change never reached the server.
function recordKeyResponses(page, url) {
  const events = [], started = Date.now(), prefix = url('/api/tokens');
  const handler = async response => {
    try {
      const request = response.request();
      if (!response.url().startsWith(prefix)) return;
      const event = {ms: Date.now() - started, method: request.method(), path: new URL(response.url()).pathname, status: response.status()};
      events.push(event);
      if (request.method() === 'GET' && response.ok()) {
        event.keys = (await response.json()).map(({id, name, active}) => `${id}:${name}:${active}`);
      }
    } catch {
      // Diagnostics must never change the result of the check they describe.
    }
  };
  page.on('response', handler);
  return {events, stop: () => page.off('response', handler)};
}

async function describeKeyPage(page) {
  const timeout = new Promise(resolve => setTimeout(resolve, 2000, 'unavailable'));
  return Promise.race([timeout, page.evaluate(() => ({
    rows: [...document.querySelectorAll('#token-list tr[data-token-id]')].map(row => row.textContent.replace(/\s+/g, ' ').trim()),
    switches: [...document.querySelectorAll('#token-list [role=switch]')].map(node => `${node.getAttribute('aria-checked')}${node.disabled ? ' disabled' : ''}`),
    error: document.querySelector('#token-list [role=alert], #tokens-error')?.textContent?.trim() || '',
    active: document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName,
    search: document.querySelector('#token-list input[type=search], #token-list [role=searchbox]')?.value ?? null,
  }))]);
}

async function checkConcurrentKeyChanges(page, peer, url, key, password) {
  const recorder = recordKeyResponses(page, url);
  try {
    await verifyConcurrentKeyChanges(page, peer, url, key, password, recorder.events);
  } finally {
    recorder.stop();
  }
}

async function verifyConcurrentKeyChanges(page, peer, url, key, password, events) {
  await page.getByRole('searchbox', {name:'Find a key by name or role'}).fill('');
  const request = peer.request, endpoint = url('/api/tokens/' + key.id);
  assert.equal((await request.post(url('/api/reauth'), {data:{password}})).status(), 200);
  assert.equal((await request.patch(endpoint, {data:{name:'Peer renamed key'}})).status(), 200);
  const created = await request.post(url('/api/tokens'), {data:{name:'Peer reader', profile:'read', expiresAt:0}});
  assert.equal(created.status(), 201);
  const peerKey = await created.json();
  const row = page.locator(`tr[data-token-id="${key.id}"]`);
  const toggle = row.getByRole('switch');
  // A local PATCH of access must also retrieve another session's name and row.
  await toggle.focus(); await toggle.press('Space');
  try {
    await row.getByText('Peer renamed key', {exact:true}).waitFor();
    await page.getByText('Peer reader', {exact:true}).waitFor();
  } catch (error) {
    console.error('Key API responses since this check began:', JSON.stringify(events));
    console.error('Key page:', JSON.stringify(await describeKeyPage(page).catch(() => 'unavailable')));
    throw error;
  }
  assert.equal(await page.locator('#token-count').textContent(), '2');
  await page.waitForFunction(id => document.activeElement === document.querySelector(`tr[data-token-id="${id}"] [role=switch]`), key.id);
  assert.equal(await page.locator('[data-settings-key-count]').first().textContent(), '1 active');
  // A subsequent local rename must preserve the peer's independent access change.
  assert.equal((await request.patch(endpoint, {data:{active:true}})).status(), 200);
  await row.getByRole('button', {name:'Manage Peer renamed key'}).click();
  const inspector = page.locator('#key-dialog');
  await inspector.getByRole('button', {name:'Rename Peer renamed key'}).click();
  await inspector.locator('#token-rename').fill(key.name);
  await inspector.getByRole('button', {name:'Save name'}).click();
  await page.waitForFunction(() => document.querySelector('#key-dialog [role=switch]')?.getAttribute('aria-checked') === 'true');
  await inspector.getByRole('button', {name:'Close dialog'}).click();
  assert.equal(await page.locator('[data-settings-key-count]').first().textContent(), '2 active');
  // A filtered-out input needs a reachable focus destination.
  await page.getByRole('button', {name:'Active',exact:true}).click();
  await toggle.focus(); await toggle.press('Space');
  await row.waitFor({state:'detached'});
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Find a key by name or role');
  assert.equal((await request.patch(url('/api/tokens/'+peerKey.id), {data:{active:false}})).status(), 200);
  assert.equal((await request.delete(url('/api/tokens/'+peerKey.id))).status(), 200);
  await page.getByRole('button', {name:'All keys',exact:true}).click();
  await toggle.click();
  await page.waitForFunction(() => document.querySelector('#token-count')?.textContent === '1');
}

export async function securityJourney({ browser, page, base, username, password, recoveryCode }) {
  const url = path => new URL(path, base).href;
  const request = page.request;
  const settle = async () => { await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))); }); };
  const expireConfirmation = () => {
    if (!process.env.E2E_DATABASE_URL) return false;
    assert.equal(base.hostname, '127.0.0.1');
    execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', process.env.E2E_DATABASE_URL, '-c', 'UPDATE sessions SET confirmed_at=0']);
    return true;
  };
  const peer = await browser.newContext({ userAgent: 'Synthetic second browser / security regression' });
  try {
    assert.equal((await peer.request.post(url('/api/login'), { data: { username, password } })).status(), 200);
    assert.equal((await peer.request.post(url('/api/mfa/verify'), { data: { code: recoveryCode } })).status(), 200);
    await clickNavigation(page, '#settings-button');
    await settingsNavigationJourney(page);
    await selectSettings(page, 'sessions');
    await page.locator('#sessions-list .session-card').nth(1).waitFor();
    assert.equal(await page.locator('#sessions-list').getByText('127.0.0.1', { exact: true }).count(), 2);
    const currentSession = page.locator('#sessions-list .session-card').filter({ hasText: 'Current session' });
    const otherSession = page.locator('.session-others-list .session-card').first();
    await otherSession.getByTitle('View session details').click();
    const details = page.locator('#session-details-dialog');
    await details.getByText('Raw browser description').click();
    await details.getByText('Synthetic second browser / security regression', { exact: true }).waitFor();
    await details.getByText('Expires', { exact: true }).waitFor();
    await details.getByRole('button', { name: 'Close' }).click();
    await currentSession.getByRole('button', { name: /^Sign out / }).click();
    await page.locator('#logout-dialog #logout-cancel').click();
    assert.equal((await request.get(url('/api/session'))).status(), 200);
    await page.setViewportSize({ width: 320, height: 700 });
    for (const [section, selectors] of [['api-keys', ['#token-name', '.akd-card']], ['sessions', ['#sessions-refresh']], ['backup', ['#scheduled-backups .bk-recovery']]]) {
      await selectSettings(page, section);
      if (section === 'api-keys') await page.locator('#token-create').click();
      for (const selector of selectors) assert.ok(await page.locator(selector).first().evaluate(node => node.getBoundingClientRect().height >= 44), `${selector} has a mobile touch target`);
      if (section === 'api-keys') await page.locator('#key-dialog').getByRole('button', { name: 'Cancel' }).click();
    }
    assert.ok(await page.locator('#settings-page').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1), 'mobile settings do not overflow');
    await page.setViewportSize({ width: 1280, height: 720 });
    await openNavigation(page);
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Backup & restore' }).click();
    assert.equal(await page.locator('#backup-title').evaluate(node => document.activeElement === node), true);
    await openNavigation(page);
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'API keys' }).click();
    assert.equal(await page.locator('#api-keys-title').evaluate(node => document.activeElement === node), true);
    if (process.env.E2E_SCREENSHOTS) {
      await mkdir(process.env.E2E_SCREENSHOTS, { recursive: true });
      for (const [name, width, height, theme] of [['desktop', 1280, 1000, 'dark'], ['mobile', 390, 844, 'dark'], ['mobile-light', 390, 844, 'light']]) {
        await page.setViewportSize({ width, height });
        await page.evaluate(theme => { if (document.documentElement.dataset.theme !== theme) document.querySelector('[data-theme-toggle]').click(); }, theme);
        await selectSettings(page, '2fa');
        await page.locator('#mfa-settings-title').evaluate(node => node.scrollIntoView({ block: 'start' }));
        assert.ok(await page.locator('#settings-page').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1), `${name} MFA settings overflow`);
        await settle();
        await page.screenshot({ path: join(process.env.E2E_SCREENSHOTS, `mfa-settings-${name}.png`), fullPage: false });
      }
      await page.setViewportSize({ width: 1280, height: 1000 });
      await page.evaluate(() => { if (document.documentElement.dataset.theme !== 'dark') document.querySelector('[data-theme-toggle]').click(); });
    }
    await selectSettings(page, 'api-keys');
    await page.locator('#token-create').click();
    await page.locator('#token-name').fill('Abandoned key');
    await page.locator('.akd-card').filter({hasText: 'Full Access'}).click();
    await page.locator('.akd-expiry-option').filter({hasText: 'Never'}).click();
    await page.getByRole('button', {name: 'Cancel', exact: true}).click();
    await page.locator('#token-create').click();
    assert.equal(await page.locator('#token-name').inputValue(), '');
    assert.equal(await page.locator('[name="token-profile"]:checked').inputValue(), 'read');
    assert.equal(await page.locator('[name="token-expiry"]:checked').inputValue(), '30');
    await page.locator('#token-name').fill('Synthetic extension');
    await page.locator('.akd-card').filter({hasText: 'Editor'}).click();
    assert.equal(await page.locator('[name="token-profile"]:checked').inputValue(), 'capture');
    await page.setViewportSize({ width: 320, height: 700 });
    await page.waitForFunction(() => !document.querySelector('#token-form button[type=submit]').disabled);
    const failCreate = route => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic failure' }) });
    await page.route('**/api/tokens', failCreate, { times: 1 });
    await page.locator('#token-form').getByRole('button', { name: 'Create key', exact: true }).click();
    await page.locator('#tokens-error').filter({ hasText: 'Synthetic failure' }).waitFor();
    assert.equal(await page.locator('#token-name').inputValue(), 'Synthetic extension');
    assert.equal(await page.locator('[name="token-profile"]:checked').inputValue(), 'capture');
    assert.equal(await page.locator('#tokens-error').evaluate(node => document.activeElement === node && node.getBoundingClientRect().top >= 0 && node.getBoundingClientRect().top < innerHeight), true);
    await page.setViewportSize({ width: 1280, height: 720 });
    const expired = expireConfirmation();
    if (expired) {
      // Cancelling stale-password verification releases the lock without issuing a key.
      await page.locator('#token-form').getByRole('button', {name:'Create key',exact:true}).click();
      await page.locator('#reauth-cancel').click();
      await page.locator('#tokens-error').filter({hasText:'cancelled'}).waitFor();
      assert.equal(await page.locator('#token-name').inputValue(), 'Synthetic extension');
      assert.equal(await page.evaluate(() => !window.dispatchEvent(new Event('beforeunload',{cancelable:true}))), false);
    }
    const heldCreate = await holdKeyResponse(page, url('/api/tokens'), 'POST');
    await page.locator('#token-form').getByRole('button', { name: 'Create key', exact: true }).click();
    if (expired) {
      await page.locator('#reauth-dialog').waitFor({ state: 'visible' });
      await page.locator('#reauth-password').fill(password);
      await page.locator('#reauth-submit').click();
    }
    await heldCreate.ready;
    await assertKeyRouteProtected(page);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#token-form').isVisible(), true);
    const leavingKey = page.waitForEvent('dialog', {predicate: d => d.type() === 'beforeunload'});
    const reloadKey = page.reload({waitUntil:'domcontentloaded'}).catch(() => {});
    await (await leavingKey).dismiss(); await reloadKey;
    await page.route(url('/api/tokens'), r => r.fulfill({status:503, json:{error:'Synthetic list failure'}}), {times:1});
    heldCreate.release();
    await page.locator('#new-token').waitFor({ state: 'visible' });
    await heldCreate.remove();
    await assertKeyRouteProtected(page);
    assert.equal(await page.locator('#reauth-dialog').isVisible(), false);
    const original = await page.locator('#new-token-value').inputValue();
    assert.equal(original.length, 64);
    assert.equal(await page.locator('#new-token-value').getAttribute('type'), 'password');
    const keys = await (await request.get(url('/api/tokens'))).json();
    const key = keys.find(key => key.name === 'Synthetic extension');
    assert.equal(key.profile, 'capture'); assert.ok(key.expiresAt > Date.now() / 1000);
    // Text selection can finish on the backdrop. It must preserve the receipt.
    const field = await page.locator('#new-token-value').boundingBox();
    await page.mouse.move(field.x + 10, field.y + field.height / 2);
    await page.mouse.down(); await page.mouse.move(1, 1); await page.mouse.up();
    assert.equal(await page.locator('#confirm-action-dialog').isVisible(), false);
    assert.equal(await page.locator('#new-token-value').inputValue(), original);
    await page.keyboard.press('Escape');
    await page.locator('#confirm-action-cancel').click();
    assert.equal(await page.locator('#new-token-value').inputValue(), original);
    await page.locator('#key-dialog').getByRole('button', { name: 'Done' }).click();
    await page.getByRole('button',{name:'Retry loading keys'}).click();
    assert.equal(await page.locator('#new-token-value').count(), 0);
    const keyRow = page.locator('#token-list tr[data-token-id]').filter({ hasText: 'Synthetic extension' });
    const keySummary = keyRow.getByRole('button', { name: 'Manage Synthetic extension' });
    const inspector = page.locator('#key-dialog');
    const revoke = inspector.getByRole('button', { name: 'Revoke Synthetic extension' });
    const access = keyRow.getByRole('switch', { name: 'Key access for Synthetic extension' });
    assert.equal(await access.getAttribute('aria-checked'), 'true');
    assert.equal(await keyRow.getByRole('cell', { name: 'Editor', exact: true }).count(), 1);
    const query = page.getByRole('searchbox', {name:'Find a key by name or role'});
    await query.fill('not a key');
    await page.getByRole('heading', {name:'No matching keys'}).waitFor();
    await page.getByRole('button', {name:'Clear filters'}).click();
    await query.fill('editor');
    await keySummary.press('Enter');
    await inspector.getByRole('heading', { name: 'Synthetic extension' }).waitFor();
    assert.equal(await revoke.isDisabled(), true);
    await inspector.press('Escape');
    await inspector.waitFor({state:'detached'});
    await keySummary.press('Space');
    const rename = inspector.getByRole('button', {name:'Rename Synthetic extension'});
    await rename.click();
    await inspector.locator('#token-rename').press('Escape');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Rename Synthetic extension');
    assert.equal((await request.delete(url('/api/links/99999'), { headers: { Authorization: `Bearer ${original}` } })).status(), 403);
    expireConfirmation();
    const heldRotate = await holdKeyResponse(page, url('/api/tokens/'+key.id+'/rotate'), 'POST');
    const heldList = await holdKeyResponse(page, url('/api/tokens'), 'GET');
    await page.getByRole('button', { name: 'Rotate key for Synthetic extension', exact: true }).click();
    await page.locator('#confirm-action-submit').click();
    if (expired) {
      await page.locator('#reauth-dialog').waitFor({ state: 'visible' });
      await page.locator('#reauth-password').fill(password);
      await page.locator('#reauth-submit').click();
    }
    await heldRotate.ready;
    await assertKeyRouteProtected(page);
    heldRotate.release();
    await page.locator('#new-token-value').waitFor();
    await heldRotate.remove();
    await heldList.ready;
    await page.waitForFunction(old => document.getElementById('new-token-value')?.value && document.getElementById('new-token-value').value !== old, original);
    const rotated = await page.locator('#new-token-value').inputValue();
    assert.equal((await request.get(url('/api/session'), { headers: { Authorization: `Bearer ${original}` } })).status(), 401);
    assert.equal((await request.get(url('/api/session'), { headers: { Authorization: `Bearer ${rotated}` } })).status(), 200);
    await inspector.getByRole('button', {name:'Done'}).click();
    await access.click();
    await page.waitForFunction(() => document.querySelector('#token-list [role=switch]')?.getAttribute('aria-checked') === 'false');
    assert.equal((await request.get(url('/api/session'), { headers: { Authorization: `Bearer ${rotated}` } })).status(), 401);
    // The GET started by rotation predates the later disable; delivering it last
    // must never turn the switch back on.
    const oldRead = page.waitForResponse(r => r.url() === url('/api/tokens') && r.request().method() === 'GET');
    heldList.release(); await oldRead; await heldList.remove();
    await page.evaluate(() => new Promise(resolve=>requestAnimationFrame(resolve)));
    assert.equal(await access.getAttribute('aria-checked'), 'false');
    await keySummary.click();
    await revoke.click();
    await page.locator('#confirm-action-cancel').click();
    await inspector.getByRole('switch').click();
    await page.waitForFunction(() => document.querySelector('#key-dialog [role=switch]')?.getAttribute('aria-checked') === 'true');
    assert.equal(await revoke.isDisabled(), true);
    await inspector.getByRole('button', {name:'Close dialog'}).click();
    await page.waitForFunction(id => document.activeElement?.id === `manage-key-${id}`, key.id);

    await checkConcurrentKeyChanges(page, peer, url, key, password);

    // The backup link always requests password confirmation, even after login.
    await selectSettings(page, 'backup');
    await page.getByRole('button', { name: /^Download & restore/ }).click();
    await page.getByRole('link', { name: 'Download full backup', exact: true }).click();
    await page.locator('#reauth-dialog').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => document.activeElement.id), 'reauth-password');
    await page.locator('#reauth-password').fill('incorrect-password');
    await page.locator('#reauth-submit').click();
    await page.locator('#reauth-error').filter({ hasText: 'Incorrect password' }).waitFor();
    if (process.env.E2E_SCREENSHOTS) {
      await mkdir(process.env.E2E_SCREENSHOTS, { recursive: true });
      await settle();
      await page.screenshot({ path: join(process.env.E2E_SCREENSHOTS, 'confirmation-error.png'), fullPage: false });
    }
    await page.locator('#reauth-password').fill(password);
    const download = page.waitForEvent('download');
    await page.locator('#reauth-submit').click();
    assert.match((await download).suggestedFilename(), /backup.*zip/);
    await page.waitForFunction(() => document.getElementById('reauth-password').value === '');
    assert.equal(await page.locator('#reauth-password').inputValue(), '');
    await page.getByRole('dialog', { name: 'Download & restore' }).getByRole('button', { name: 'Close', exact: true }).click();

    await selectSettings(page, 'sessions');
    await page.locator('#session-idle-open').click();
    await chooseOption(page, 'session-idle', '1 hour');
    assert.equal(await page.locator('#session-idle').inputValue(), '60');
    await page.locator('#session-idle-form').getByRole('button', { name: 'Save timeout' }).click();
    await page.locator('#sessions-feedback').filter({ hasText: 'Inactivity timeout saved' }).waitFor();
    const sessions = await (await request.get(url('/api/sessions'))).json();
    assert.equal(sessions.find(session => session.current).idleTimeoutMinutes, 60);
    await page.reload();
    await page.waitForFunction(() => document.getElementById('session-idle').value === '60');
    assert.equal((await page.locator('#session-idle-trigger').textContent()).trim(), '1 hour', 'programmatic session updates synchronize the visible selector after reload');
    const expiresAt = Math.floor(Date.now() / 1000) + 2;
    assert.equal((await request.post(url('/api/tokens'), { data: { name: 'Synthetic expired key', profile: 'read', expiresAt } })).status(), 201);
    await page.waitForFunction(expiry => Date.now() >= expiry * 1000, expiresAt);
    await page.locator('#settings-page [data-settings-back]:visible').click();
    await page.locator('#settings-page').waitFor({ state: 'hidden' });
    await clickNavigation(page, '#settings-button');
    await selectSettings(page, 'api-keys');
    const expiredRow = page.locator('#token-list tr[data-token-id]').filter({ hasText: 'Synthetic expired key' });
    await expiredRow.waitFor();
    assert.equal(await page.locator('#token-count').textContent(), '2');
    assert.equal(await page.locator('#token-count').getAttribute('title'), '2 of 32 keys');
    assert.equal(await page.locator('[data-settings-key-count]').first().textContent(), '1 active');
    assert.equal(await expiredRow.getByRole('switch').innerText(), 'Expired');
    assert.equal(await expiredRow.getByRole('switch').getAttribute('aria-checked'), 'true');
    await expiredRow.getByRole('button', {name:'Manage Synthetic expired key'}).click();
    assert.equal(await inspector.getByRole('button', {name:'Revoke Synthetic expired key'}).isDisabled(), true);
    assert.equal(await inspector.getByRole('button', {name:'Rotate key for Synthetic expired key'}).count(), 0);
    await inspector.getByRole('button', {name:'Close dialog'}).click();
    if (process.env.E2E_SCREENSHOTS) {
      await expiredRow.scrollIntoViewIfNeeded(); await settle();
      await page.screenshot({ path: join(process.env.E2E_SCREENSHOTS, 'expired-key.png'), fullPage: false });
      for (const [name, width, height, theme] of [['desktop', 1280, 1000, 'dark'], ['mobile', 390, 844, 'dark'], ['mobile-light', 390, 844, 'light']]) {
        await page.setViewportSize({ width, height });
        await page.evaluate(theme => { if (document.documentElement.dataset.theme !== theme) document.querySelector('[data-theme-toggle]').click(); }, theme);
        await selectSettings(page, 'api-keys');
        await page.evaluate(() => window.scrollTo(0, 0));
        assert.ok(await page.locator('#settings-page').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1), `${name} settings overflow`);
        await settle();
        await page.screenshot({ path: join(process.env.E2E_SCREENSHOTS, `${name}.png`), fullPage: false });
        await selectSettings(page, 'sessions');
        await page.locator('#sessions-title').scrollIntoViewIfNeeded();
        await settle();
        await page.screenshot({ path: join(process.env.E2E_SCREENSHOTS, `${name}-sessions.png`), fullPage: false });
        await page.locator('#session-idle-open').click();
        await page.locator('#session-idle-form').scrollIntoViewIfNeeded();
        await settle();
        await page.screenshot({ path: join(process.env.E2E_SCREENSHOTS, `${name}-timeout.png`), fullPage: false });
        await page.locator('#session-idle-cancel').click();
      }
      await page.setViewportSize({ width: 1280, height: 1000 });
    }
    await selectSettings(page, 'sessions');
    await page.locator('#sessions-others').click();
    await page.locator('#confirm-action-submit').click();
    await page.locator('#sessions-feedback').filter({ hasText: 'All other browsers' }).waitFor();
    assert.equal((await peer.request.get(url('/api/session'))).status(), 401);
    assert.equal((await request.get(url('/api/session'))).status(), 200);
    await selectSettings(page, 'api-keys');
    await access.click();
    await keySummary.click();
    await revoke.click();
    await page.locator('#confirm-action-submit').click();
    await keyRow.waitFor({state: 'detached'});
    assert.equal((await (await request.get(url('/api/tokens'))).json()).some(token => token.id === key.id), false);
    // Clicking outside must cancel without starting a download or retaining the password.
    await selectSettings(page, 'backup');
    await page.getByRole('button', { name: /^Download & restore/ }).click();
    await page.getByRole('link', { name: 'Download full backup', exact: true }).click();
    await page.locator('#reauth-password').fill('not-submitted');
    await page.mouse.click(0, 0);
    await page.waitForFunction(() => document.getElementById('reauth-password').value === '');
    assert.equal(await page.locator('#reauth-password').inputValue(), '');
    await page.getByRole('dialog', { name: 'Download & restore' }).getByRole('button', { name: 'Close', exact: true }).click();
    await page.locator('#settings-page [data-settings-back]:visible').click();
    assert.equal(await page.locator('#new-token-value').count(), 0);
  } finally { await peer.close(); }
}
