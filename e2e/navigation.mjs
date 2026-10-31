import assert from 'node:assert/strict';

export async function openNavigation(page) {
  const desktop = await page.evaluate(() => matchMedia('(min-width: 901px) and (hover: hover) and (pointer: fine)').matches);
  if (desktop) {
    await page.mouse.move(2, 200);
    await page.locator('#sidebar-mode').focus();
  } else if (!await page.locator('#navigation-dialog').evaluate(node => node.open)) {
    await page.locator('#open-navigation').click();
  }
}

export async function openWorkspaceActions(page) {
  await openNavigation(page);
  if (!await page.locator('#workspace-popover').evaluate(node => node.matches(':popover-open'))) {
    await page.locator('#workspace-button').click();
  }
  await page.locator('#workspace-popover').waitFor({ state: 'visible' });
}

export async function clickNavigation(page, selector) {
  if (['#import-button', '#export-button', '#settings-button', '#logout-button'].includes(selector)) {
    await openWorkspaceActions(page);
  } else await openNavigation(page);
  await page.locator(selector).click();
}

// Exercise every actual dialog template, including nested overlays, with native pointer events.
export async function dialogDismissalJourney(page) {
  const original = page.viewportSize();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const ids = await page.locator('dialog').evaluateAll(nodes => nodes.map(node => node.id));
    for (const id of ids) {
      if (id === 'navigation-dialog' && width > 900) continue;
      const dialog = page.locator(`#${id}`);
      await dialog.evaluate(node => node.showModal());
      // Wait for the entry animation before measuring the visible boundary.
      await dialog.evaluate(async node => { await Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => {}))); });
      const bounds = await dialog.boundingBox();
      assert.ok(bounds, `${id}: dialog is visible at ${width}px`);
      const outside = bounds.x > 1 ? { x: 0, y: 0 } : bounds.x + bounds.width < width - 1 ? { x: width - 1, y: 0 } : null;
      if (!outside) {
        await dialog.evaluate(node => new Promise(resolve => { node.addEventListener('close', resolve, { once: true }); node.close(); }));
        continue;
      }
      await page.mouse.click(bounds.x + 1, bounds.y + 1);
      assert.equal(await dialog.evaluate(node => node.open), true, `${id}: inside click stays open at ${width}px`);
      await page.mouse.move(bounds.x + 1, bounds.y + 1);
      await page.mouse.down();
      await page.mouse.move(outside.x, outside.y);
      await page.mouse.up();
      assert.equal(await dialog.evaluate(node => node.open), true, `${id}: dragging outside stays open at ${width}px`);
      await page.mouse.click(outside.x, outside.y);
      await dialog.waitFor({ state: 'hidden' });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('#help-dialog').evaluate(node => node.showModal());
  await page.locator('#export-dialog').evaluate(node => {
    // Exercise older browsers without requestClose and a prevented cancellation.
    node.requestClose = undefined;
    node.addEventListener('cancel', event => event.preventDefault(), { once: true });
    node.showModal();
  });
  await page.mouse.click(0, 0);
  assert.equal(await page.locator('#export-dialog').evaluate(node => node.open), true, 'cancellation guards also work without requestClose');
  await page.mouse.click(0, 0);
  await page.locator('#export-dialog').waitFor({ state: 'hidden' });
  await page.locator('#export-dialog').evaluate(node => { delete node.requestClose; });
  assert.equal(await page.locator('#help-dialog').evaluate(node => node.open), true, 'only the top dialog closes');
  await page.locator('#help-dialog').evaluate(node => new Promise(resolve => { node.addEventListener('close', resolve, { once: true }); node.close(); }));
  await page.setViewportSize(original);
  await page.locator('#main-content').focus();
  await page.mouse.move(original.width / 2, original.height / 2);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

export async function navigationJourney(page) {
  const original = page.viewportSize();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.mouse.move(500, 400);
  assert.equal(await page.locator('#sidebar').isVisible(), false);
  await page.mouse.move(2, 400);
  await page.locator('#sidebar').waitFor({ state: 'visible' });
  await page.locator('#sidebar-mode').click();
  assert.equal(await page.locator('#sidebar-mode').getAttribute('aria-pressed'), 'true');
  await page.mouse.move(600, 400);
  await page.reload();
  assert.equal(await page.locator('#sidebar-mode').getAttribute('aria-pressed'), 'true');
  await page.locator('#sidebar-mode').click();
  await page.locator('#sidebar').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => document.activeElement.id), 'open-navigation');
  await page.mouse.move(600, 400);
  await page.mouse.move(2, 400);
  await page.locator('#sidebar').waitFor({ state: 'visible' });
  await page.locator('#sidebar-mode').click();
  await page.locator('#sidebar-mode').focus();
  await page.keyboard.press('Enter');
  await page.locator('#sidebar').waitFor({ state: 'hidden' });
  await page.mouse.move(600, 400);
  await page.mouse.move(2, 400);
  await page.locator('#sidebar').waitFor({ state: 'visible' });
  await page.locator('#sidebar-mode').click();
  await page.mouse.move(600, 400);
  await page.locator('#sidebar-mode').focus();
  await page.keyboard.press('Enter');
  await page.locator('#sidebar').waitFor({ state: 'hidden' });
  await page.mouse.move(2, 400);
  await page.locator('#sidebar').waitFor({ state: 'visible' });
  await page.locator('#main-content').click({ position: { x: 500, y: 200 } });
  await page.mouse.move(600, 400);
  await page.locator('#sidebar').waitFor({ state: 'hidden' });
  await page.locator('#open-navigation').click();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'sidebar-mode');
  await page.locator('#main-content').focus();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await page.locator('#sidebar').waitFor({ state: 'hidden' });
    await openNavigation(page);
    assert.equal(await page.locator('#open-navigation').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'close-navigation');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.closest('dialog')?.id), 'navigation-dialog');
    await page.keyboard.press('Escape');
    await page.locator('#navigation-dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#open-navigation').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'open-navigation');
    await openNavigation(page);
    await page.mouse.click(width - 5, 400);
    await page.locator('#navigation-dialog').waitFor({ state: 'hidden' });
    await openWorkspaceActions(page);
    await page.keyboard.press('Escape');
    await page.locator('#workspace-popover').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#navigation-dialog').evaluate(node => node.open), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'workspace-button');
    await clickNavigation(page, '#logout-button');
    await page.getByRole('alertdialog', { name: 'Sign out of Pocketmark?' }).waitFor();
    assert.equal(await page.locator('#navigation-dialog').evaluate(node => node.open), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'logout-cancel');
    await page.keyboard.press('Escape');
    await page.locator('#logout-dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#app-view').isVisible(), true);
  }
  await page.setViewportSize(original);
  await page.locator('#add-bookmark').click();
  await page.locator('#bookmark-title').fill('Unsaved sign-out draft');
  await page.mouse.click(0, 0);
  await page.locator('#bookmark-dialog').waitFor({ state: 'hidden' });
  await clickNavigation(page, '#logout-button');
  assert.match(await page.locator('#logout-description').textContent(), /discard the unsaved drafts/);
  await page.locator('#logout-cancel').click();
  await page.locator('#add-bookmark').click();
  assert.equal(await page.locator('#bookmark-title').inputValue(), 'Unsaved sign-out draft');
  await page.locator('#discard-bookmark-draft').click();
  await page.locator('#confirm-action-submit').click();
  await page.locator('#bookmark-dialog .close-dialog').first().click();
  await clickNavigation(page, '#logout-button');
  let attempts = 0;
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/logout', async route => {
    attempts++;
    await held;
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Sign-out unavailable. Try again.' }) });
  });
  await page.locator('#logout-confirm').click();
  assert.equal(await page.locator('#logout-confirm').isDisabled(), true);
  assert.equal(await page.locator('#logout-cancel').isDisabled(), true);
  await page.keyboard.press('Escape');
  await page.mouse.click(0, 0);
  assert.equal(await page.locator('#logout-dialog').evaluate(node => node.open), true);
  release();
  await page.locator('#logout-error').filter({ hasText: 'The server could not complete this action' }).waitFor();
  assert.equal(attempts, 1);
  assert.equal(await page.locator('#logout-confirm').isEnabled(), true);
  await page.unroute('**/api/logout');
  await page.locator('#logout-cancel').click();
}
