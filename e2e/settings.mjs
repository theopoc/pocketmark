export { openWorkspaceActions } from './navigation.mjs';
import { clickNavigation } from './navigation.mjs';
import assert from 'node:assert/strict';

export async function selectSettings(page, section) {
  if (page.viewportSize().width <= 900) await page.locator('#settings-section-picker').selectOption(section);
  else await clickNavigation(page, `[data-settings-section="${section}"]`);
  await page.locator(`[data-settings-panel="${section}"]`).waitFor({ state: 'visible' });
}

export async function settingsNavigationJourney(page) {
  const original = new URL(page.url());
  original.searchParams.delete('settings');
  const context = new URL(original);
  context.searchParams.set('filter', 'favorite');
  context.searchParams.set('q', 'settings navigation');
  context.searchParams.set('sort', 'title');
  await page.goto(context.href);
  await page.locator('#library-content').waitFor({ state: 'visible' });
  await clickNavigation(page, '#settings-button');
  assert.equal(await page.locator('#settings-page').evaluate(node => node.tagName), 'SECTION');
  assert.equal(await page.locator('dialog[open]').count(), 0);
  assert.equal(await page.locator('#library-navigation').isVisible(), false);
  assert.equal(await page.locator('[data-settings-section]').count(), 7);
  assert.equal(await page.locator('[data-settings-section="2fa"]').textContent(), '2FA');
  for (const section of ['2fa', 'sessions', 'backup', 'password', 'sync', 'mobile', 'api-keys']) {
    await selectSettings(page, section);
    assert.equal(new URL(page.url()).searchParams.get('settings'), section);
    assert.equal(await page.locator('[data-settings-panel]:visible').count(), 1);
  }
  await selectSettings(page, 'backup');
  await page.reload();
  await page.locator('[data-settings-panel="backup"]').waitFor({ state: 'visible' });
  await selectSettings(page, '2fa');
  await page.goBack();
  await page.locator('[data-settings-panel="backup"]').waitFor({ state: 'visible' });
  await page.goForward();
  await page.locator('[data-settings-panel="2fa"]').waitFor({ state: 'visible' });
  await page.locator('[data-settings-back]:visible').click();
  await page.locator('#library-content').waitFor({ state: 'visible' });
  assert.equal(new URL(page.url()).searchParams.has('settings'), false);
  assert.equal(await page.locator('#search').inputValue(), 'settings navigation');
  assert.equal(await page.locator('#sort-toggle').getAttribute('aria-label'), 'Sort bookmarks: Title A–Z');
  assert.equal(new URL(page.url()).searchParams.get('filter'), 'favorite');
  await page.goto(original.href);
  await page.locator('#library-content').waitFor({ state: 'visible' });
  await clickNavigation(page, '#settings-button');
  await page.locator('[data-settings-panel="api-keys"]').waitFor({ state: 'visible' });
}

export async function openSettings(page, section = 'api-keys') {
  if (!await page.locator('#settings-page').isVisible()) await clickNavigation(page, '#settings-button');
  await selectSettings(page, section);
}

// Leave the sessions request in flight while the owner works in 2FA.
export async function refreshSessionsBeforeMFA(page) {
  await selectSettings(page, 'sessions');
  await page.locator('#sessions-refresh').click();
  await selectSettings(page, '2fa');
}
