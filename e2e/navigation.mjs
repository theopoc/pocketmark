import assert from 'node:assert/strict';

export async function openNavigation(page) {
  if (!await page.locator('#navigation-dialog').evaluate(node => node.open)) {
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

export async function navigationJourney(page) {
  const original = page.viewportSize();
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    assert.equal(await page.locator('#sidebar').isVisible(), false);
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
  await page.locator('#bookmark-dialog .close-dialog').first().click();
  await clickNavigation(page, '#logout-button');
  assert.match(await page.locator('#logout-description').textContent(), /discard the unsaved drafts/);
  await page.locator('#logout-cancel').click();
  await page.locator('#add-bookmark').click();
  assert.equal(await page.locator('#bookmark-title').inputValue(), 'Unsaved sign-out draft');
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#discard-bookmark-draft').click();
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
  assert.equal(await page.locator('#logout-dialog').evaluate(node => node.open), true);
  release();
  await page.locator('#logout-error').filter({ hasText: 'The server could not complete this action' }).waitFor();
  assert.equal(attempts, 1);
  assert.equal(await page.locator('#logout-confirm').isEnabled(), true);
  await page.unroute('**/api/logout');
  await page.locator('#logout-cancel').click();
}
