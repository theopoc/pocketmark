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
    await page.setViewportSize({ width: 320, height: 700 });
    for (const [section, selectors] of [['api-keys', ['#token-name', '#token-profile-trigger']], ['sessions', ['#sessions-refresh']], ['backup', ['#settings-page a[href="/api/backup"]']]]) {
      await selectSettings(page, section);
      if (section === 'api-keys') await page.locator('#token-create summary').click();
      for (const selector of selectors) assert.ok(await page.locator(selector).evaluate(node => node.getBoundingClientRect().height >= 44), `${selector} has a mobile touch target`);
    }
    assert.ok(await page.locator('#settings-page').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1), 'mobile settings do not overflow');
    await page.setViewportSize({ width: 1280, height: 720 });
    await openNavigation(page);
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Backup & restore' }).click();
    assert.equal(await page.locator('#settings-detail-title').evaluate(node => document.activeElement === node), true);
    await openNavigation(page);
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'API keys' }).click();
    assert.equal(await page.locator('#settings-detail-title').evaluate(node => document.activeElement === node), true);
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
    if (!await page.locator('#token-create').evaluate(node => node.open)) await page.locator('#token-create summary').click();
    await page.locator('#token-name').fill('Abandoned key');
    await chooseOption(page, 'token-profile', 'Full Access');
    await chooseOption(page, 'token-expiry', 'Never');
    await page.locator('#token-create summary').click();
    await page.locator('#token-create summary').click();
    assert.equal(await page.locator('#token-name').inputValue(), '');
    assert.equal(await page.locator('#token-profile').inputValue(), 'read');
    assert.equal(await page.locator('#token-expiry').inputValue(), '30');
    await page.locator('#token-name').fill('Synthetic extension');
    await chooseOption(page, 'token-profile', 'Editor');
    assert.equal(await page.locator('#token-profile').inputValue(), 'capture');
    await page.setViewportSize({ width: 320, height: 700 });
    await page.waitForFunction(() => !document.querySelector('#token-form button[type=submit]').disabled);
    const failCreate = route => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic failure' }) });
    await page.route('**/api/tokens', failCreate, { times: 1 });
    await page.locator('#token-form').getByRole('button', { name: 'Create key', exact: true }).click();
    await page.locator('#tokens-error').filter({ hasText: 'Synthetic failure' }).waitFor();
    assert.equal(await page.locator('#token-name').inputValue(), 'Synthetic extension');
    assert.equal(await page.locator('#token-profile').inputValue(), 'capture');
    assert.equal(await page.locator('#tokens-error').evaluate(node => document.activeElement === node && node.getBoundingClientRect().top >= 0 && node.getBoundingClientRect().top < innerHeight), true);
    await page.setViewportSize({ width: 1280, height: 720 });
    const expired = expireConfirmation();
    await page.locator('#token-form').getByRole('button', { name: 'Create key', exact: true }).click();
    if (expired) {
      await page.locator('#reauth-dialog').waitFor({ state: 'visible' });
      await page.locator('#reauth-password').fill(password);
      await page.locator('#reauth-submit').click();
    }
    await page.locator('#new-token').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#reauth-dialog').isVisible(), false);
    const original = await page.locator('#new-token-value').inputValue();
    assert.equal(original.length, 64);
    assert.equal(await page.locator('#new-token-value').getAttribute('type'), 'password');
    const keys = await (await request.get(url('/api/tokens'))).json();
    const key = keys.find(key => key.name === 'Synthetic extension');
    assert.equal(key.profile, 'capture'); assert.ok(key.expiresAt > Date.now() / 1000);
    const keyRow = page.locator('#token-list tbody[data-token-id]').filter({ hasText: 'Synthetic extension' });
    const keySummary = keyRow.getByRole('button', { name: 'Details for Synthetic extension' });
    assert.equal(await keyRow.getByRole('switch').getAttribute('aria-checked'), 'true');
    assert.equal(await keyRow.getByRole('button', { name: 'Revoke Synthetic extension' }).isDisabled(), true);
    assert.equal(await keyRow.getByRole('cell', { name: 'Editor', exact: true }).count(), 1);
    assert.equal(await keySummary.getAttribute('aria-expanded'), 'false');
    await keySummary.press('Enter');
    assert.equal(await keySummary.getAttribute('aria-expanded'), 'true');
    await keySummary.press('Space');
    assert.equal(await keyRow.getByRole('button', { name: 'Rotate Synthetic extension' }).isVisible(), false);
    await keySummary.click();
    await keyRow.getByRole('button', { name: 'Rename Synthetic extension', exact: true }).click();
    await keyRow.locator('input').press('Escape');
    assert.equal(await keyRow.getByRole('button', { name: 'Rename Synthetic extension', exact: true }).evaluate(n => document.activeElement === n), true);
    assert.equal((await request.delete(url('/api/links/99999'), { headers: { Authorization: `Bearer ${original}` } })).status(), 403);
    expireConfirmation();
    await page.getByRole('button', { name: 'Rotate Synthetic extension', exact: true }).click();
    await page.locator('#confirm-action-submit').click();
    if (expired) {
      await page.locator('#reauth-dialog').waitFor({ state: 'visible' });
      await page.locator('#reauth-password').fill(password);
      await page.locator('#reauth-submit').click();
    }
    await page.waitForFunction(old => document.getElementById('new-token-value').value !== old, original);
    const rotated = await page.locator('#new-token-value').inputValue();
    assert.equal((await request.get(url('/api/session'), { headers: { Authorization: `Bearer ${original}` } })).status(), 401);
    assert.equal((await request.get(url('/api/session'), { headers: { Authorization: `Bearer ${rotated}` } })).status(), 200);
    const access = keyRow.getByRole('switch', { name: 'Access for Synthetic extension' });
    const revoke = keyRow.getByRole('button', { name: 'Revoke Synthetic extension' });
    await access.click();
    await revoke.waitFor();
    await page.waitForFunction(() => !document.querySelector('#token-list [aria-label="Revoke Synthetic extension"]').disabled);
    assert.equal(await access.getAttribute('aria-checked'), 'false');
    assert.equal((await request.get(url('/api/session'), { headers: { Authorization: `Bearer ${rotated}` } })).status(), 401);
    await revoke.click();
    await page.locator('#confirm-action-cancel').click();
    await access.click();
    await page.waitForFunction(() => document.querySelector('#token-list [role=switch]').getAttribute('aria-checked') === 'true');
    assert.equal(await revoke.isDisabled(), true);

    // The backup link always requests password confirmation, even after login.
    await selectSettings(page, 'backup');
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

    await selectSettings(page, 'sessions');
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
    const expiredRow = page.locator('#token-list tbody[data-token-id]').filter({ hasText: 'Synthetic expired key' });
    await expiredRow.waitFor();
    assert.equal(await page.locator('#token-count').textContent(), '2');
    assert.equal(await page.locator('#token-count').getAttribute('title'), '2 of 32 keys');
    assert.equal(await page.locator('[data-settings-key-count]').first().textContent(), '1 active');
    assert.equal(await expiredRow.getByRole('switch').innerText(), 'Expired');
    assert.equal(await expiredRow.getByRole('switch').getAttribute('aria-checked'), 'true');
    assert.equal(await expiredRow.getByRole('button', { name: 'Revoke Synthetic expired key' }).isDisabled(), true);
    assert.equal(await expiredRow.getByRole('button', { name: 'Rotate Synthetic expired key' }).isVisible(), false);
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
        await page.locator('#session-idle-form').scrollIntoViewIfNeeded();
        await settle();
        await page.screenshot({ path: join(process.env.E2E_SCREENSHOTS, `${name}-timeout.png`), fullPage: false });
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
    await revoke.click();
    await page.locator('#confirm-action-submit').click();
    await keyRow.waitFor({state: 'detached'});
    assert.equal((await (await request.get(url('/api/tokens'))).json()).some(token => token.id === key.id), false);
    // Clicking outside must cancel without starting a download or retaining the password.
    await selectSettings(page, 'backup');
    await page.getByRole('link', { name: 'Download full backup', exact: true }).click();
    await page.locator('#reauth-password').fill('not-submitted');
    await page.mouse.click(0, 0);
    await page.waitForFunction(() => document.getElementById('reauth-password').value === '');
    assert.equal(await page.locator('#reauth-password').inputValue(), '');
    await page.locator('#settings-page [data-settings-back]:visible').click();
    await page.waitForFunction(() => document.getElementById('new-token-value').value === '');
    assert.equal(await page.locator('#new-token-value').inputValue(), '');
  } finally { await peer.close(); }
}
