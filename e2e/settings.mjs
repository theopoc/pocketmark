export { openWorkspaceActions } from './navigation.mjs';
import { clickNavigation, openNavigation } from './navigation.mjs';
import assert from 'node:assert/strict';

export async function selectSettings(page, section) {
  await clickNavigation(page, `[data-settings-section="${section}"]`);
  await page.locator(`[data-settings-panel="${section}"]`).waitFor({ state: 'visible' });
}

// Compare Settings with the real library, so a separate oversized scale cannot return.
export async function settingsDensityJourney(page) {
  const viewport = page.viewportSize();
  const initialTheme = await page.locator('html').getAttribute('data-theme');
  const libraryURL = new URL(page.url());
  libraryURL.searchParams.delete('settings');
  const sections = ['api-keys', '2fa', 'sessions', 'password', 'backup', 'sync', 'mobile'];
  for (const theme of ['dark', 'light']) for (const width of [1280, 1024, 901, 900, 390, 320]) {
    await page.goto(libraryURL.href);
    await page.locator('#library-content').waitFor({ state: 'visible' });
    await page.setViewportSize({ width, height: 800 });
    if (await page.locator('html').getAttribute('data-theme') !== theme)
      await page.locator('.main-content > .topbar [data-theme-toggle]').click();
    await openNavigation(page);
    const reference = await page.evaluate(() => {
      const item = document.querySelector('#library-navigation [data-filter].active') || document.querySelector('[data-filter="all"]');
      const font = node => { const s = getComputedStyle(node); return [s.fontSize, s.fontFamily, s.fontWeight, s.lineHeight]; };
      return {
        menuFont: font(item), menuHeight: getComputedStyle(item).minHeight,
        icon: item.querySelector('.icon').getBoundingClientRect().width,
        brand: getComputedStyle(document.querySelector('#sidebar .brand')).fontSize,
        mark: document.querySelector('#sidebar .brand-mark').getBoundingClientRect().toJSON(),
        header: document.querySelector('.main-content > .topbar').getBoundingClientRect().height,
        title: font(document.querySelector('#page-title')),
        rail: document.querySelector('#sidebar').getBoundingClientRect().width,
      };
    });
    await clickNavigation(page, '#settings-button');
    for (const section of sections) {
      await selectSettings(page, section);
      const actual = await page.evaluate(section => {
        const item = document.querySelector(`[data-settings-section="${section}"]`);
        const font = node => { const s = getComputedStyle(node); return [s.fontSize, s.fontFamily, s.fontWeight, s.lineHeight]; };
        return {
          menuFont: font(item), menuHeight: getComputedStyle(item).minHeight,
          icon: item.querySelector('.icon').getBoundingClientRect().width,
          brand: getComputedStyle(document.querySelector('.settings-topbar .brand')).fontSize,
          mark: document.querySelector('.settings-topbar .brand-mark').getBoundingClientRect().toJSON(),
          header: document.querySelector('.settings-topbar').getBoundingClientRect().height,
          title: font(document.querySelector(`[data-settings-panel="${section}"] h2`)),
          rail: document.querySelector('#settings-navigation').getBoundingClientRect().width,
        };
      }, section);
      assert.deepEqual(actual.menuFont, reference.menuFont, `${theme}/${width}/${section}: navigation typography matches the library`);
      assert.equal(actual.icon, reference.icon);
      assert.equal(actual.brand, reference.brand);
      assert.equal(actual.mark.width, reference.mark.width);
      assert.equal(actual.mark.height, reference.mark.height);
      assert.equal(actual.header, reference.header);
      assert.deepEqual(actual.title, reference.title, `${section}: page heading matches the library`);
      if (width > 900) {
        assert.equal(actual.menuHeight, reference.menuHeight);
        assert.equal(actual.rail, reference.rail);
      } else assert.ok(parseFloat(actual.menuHeight) >= 44, 'compact phone menus retain touch targets');
    }
  }
  await page.goto(libraryURL.href);
  await page.locator('#library-content').waitFor({ state: 'visible' });
  await page.setViewportSize(viewport);
  if (await page.locator('html').getAttribute('data-theme') !== initialTheme)
    await page.locator('.main-content > .topbar [data-theme-toggle]').click();
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
  await settingsDensityJourney(page);
  await clickNavigation(page, '#settings-button');
  assert.equal(await page.locator('#settings-page').evaluate(node => node.tagName), 'SECTION');
  assert.equal(await page.locator('dialog[open]').count(), 0);
  assert.equal(await page.locator('#library-navigation').isVisible(), false);
  assert.equal(await page.locator('[data-settings-section]').count(), 7);
  assert.equal(await page.locator('#settings-section-picker').count(), 0);
  const viewport = page.viewportSize();
  const initialTheme = await page.locator('html').getAttribute('data-theme');
  const sections = ['api-keys', '2fa', 'sessions', 'password', 'backup', 'sync', 'mobile'];
  for (const theme of ['dark', 'light']) {
    if (await page.locator('html').getAttribute('data-theme') !== theme)
      await page.locator('.settings-topbar [data-theme-toggle]').click();
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate(async () => {
        await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
      });
      await page.waitForFunction(() => {
        const active = document.querySelector('[data-settings-section][aria-current="page"]');
        const item = active.getBoundingClientRect(), menu = active.closest('nav').getBoundingClientRect();
        return item.left >= menu.left && item.right <= menu.right + 1;
      });
      const labels = await page.locator('[data-settings-section]').allTextContents();
      const header = await page.locator('.settings-topbar').boundingBox();
      for (const section of sections) {
        await selectSettings(page, section);
        assert.equal(new URL(page.url()).searchParams.get('settings'), section);
        assert.equal(await page.locator('[data-settings-panel]:visible').count(), 1);
        assert.equal(await page.locator('#settings-navigation').isVisible(), true);
        assert.deepEqual(await page.locator('[data-settings-section]').allTextContents(), labels);
        assert.equal(await page.locator('[data-settings-section][aria-current="page"]').count(), 1);
        assert.equal(await page.locator(`[data-settings-section="${section}"]`).getAttribute('aria-current'), 'page');
        assert.deepEqual(await page.locator('.settings-topbar').boundingBox(), header);
        assert.equal(await page.locator('.main-content > .topbar').isVisible(), false);
        assert.equal(await page.locator(`[data-settings-panel="${section}"] h2`).evaluate(n => n === document.activeElement), true);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${theme}/${width}/${section} overflows`);
        assert.ok(await page.locator(`[data-settings-section="${section}"]`).evaluate(n => {
          const item = n.getBoundingClientRect(), menu = n.closest('nav').getBoundingClientRect();
          return item.left >= menu.left && item.right <= menu.right + 1;
        }), `active ${section} is visible in the menu at ${width}px`);
        await page.reload();
        await page.locator(`[data-settings-panel="${section}"]`).waitFor({ state: 'visible' });
        assert.equal(await page.locator(`[data-settings-section="${section}"]`).getAttribute('aria-current'), 'page');
      }
    }
  }
  await page.setViewportSize(viewport);
  if (await page.locator('html').getAttribute('data-theme') !== initialTheme)
    await page.locator('.settings-topbar [data-theme-toggle]').click();
  await selectSettings(page, 'api-keys');
  // Long destinations must not stretch or move the shared desktop menu.
  await page.setViewportSize({ width: 1280, height: 720 });
  await selectSettings(page, 'api-keys');
  const menuBefore = await page.locator('#settings-navigation').boundingBox();
  const backBefore = await page.locator('#settings-navigation [data-settings-back]').boundingBox();
  const sessionsURL = new URL('/api/sessions', page.url()).href;
  const longSessions = route => route.fulfill({ json: Array.from({ length: 8 }, (_, id) => ({ id, current: id === 0, device: 'Chrome/156 Linux' })) });
  await page.route(sessionsURL, longSessions);
  await selectSettings(page, 'sessions');
  await page.locator('#sessions-refresh').click();
  await page.locator('#sessions-list .token-row').nth(7).waitFor();
  assert.deepEqual(await page.locator('#settings-navigation').boundingBox(), menuBefore);
  assert.deepEqual(await page.locator('#settings-navigation [data-settings-back]').boundingBox(), backBefore);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  assert.equal(await page.locator('.settings-topbar').evaluate(n => n.getBoundingClientRect().top), 0);
  assert.ok(await page.locator('#settings-navigation [data-settings-back]').evaluate(n => n.getBoundingClientRect().bottom <= innerHeight));
  await page.unroute(sessionsURL, longSessions);
  await selectSettings(page, 'mobile');
  await page.setViewportSize({ width: 1280, height: 390 });
  await page.reload();
  await page.locator('[data-settings-panel="mobile"]').waitFor({ state: 'visible' });
  await page.waitForFunction(() => {
    const active = document.querySelector('[data-settings-section="mobile"]');
    const item = active.getBoundingClientRect(), menu = active.closest('nav').getBoundingClientRect();
    return item.top >= menu.top && item.bottom <= Math.min(menu.bottom, innerHeight);
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => {
    const active = document.querySelector('[data-settings-section="mobile"]');
    const item = active.getBoundingClientRect(), menu = active.closest('nav').getBoundingClientRect();
    return item.left >= menu.left && item.right <= menu.right + 1;
  });
  assert.equal(await page.locator('#mobile-title').evaluate(n => n === document.activeElement), true, 'resizing reveals the active item without moving focus');
  await page.setViewportSize(viewport);
  await selectSettings(page, 'api-keys');
  // Optional character shortcuts must stay off in settings and persist per browser.
  await page.locator('#api-keys-title').focus();
  await page.keyboard.press('n');
  assert.equal(await page.locator('#bookmark-dialog').isVisible(), false);
  await selectSettings(page, 'mobile');
  await page.locator('#keyboard-shortcuts').uncheck();
  await page.reload();
  await page.locator('#keyboard-shortcuts').waitFor();
  assert.equal(await page.locator('#keyboard-shortcuts').isChecked(), false);
  await clickNavigation(page, '#settings-navigation [data-settings-back]');
  await page.locator('#page-title').focus();
  await page.keyboard.press('n');
  assert.equal(await page.locator('#bookmark-dialog').isVisible(), false);
  assert.equal(await page.locator('#add-bookmark [data-shortcut-hint]').isVisible(), false);
  await openSettings(page, 'mobile');
  await page.locator('#keyboard-shortcuts').check();
  const legacy = new URL(page.url());
  legacy.searchParams.set('settings', '2fa');
  await page.goto(legacy.href);
  await page.locator('#mfa-settings-title').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#mfa-settings-title').evaluate(node => document.activeElement === node && node.getBoundingClientRect().top >= 0 && node.getBoundingClientRect().top < innerHeight), true);
  await selectSettings(page, 'backup');
  await page.reload();
  await page.locator('[data-settings-panel="backup"]').waitFor({ state: 'visible' });
  await selectSettings(page, '2fa');
  await page.goBack();
  await page.locator('[data-settings-panel="backup"]').waitFor({ state: 'visible' });
  await page.goForward();
  await page.locator('[data-settings-panel="2fa"]').waitFor({ state: 'visible' });
  await clickNavigation(page, '#settings-navigation [data-settings-back]');
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
