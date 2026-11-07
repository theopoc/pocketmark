import assert from 'node:assert/strict';

// Exercise the browser behavior that changes when keyed React nodes survive a
// refresh. Interceptions alter only this disposable browser's responses.
export async function reactJourney(page, base) {
  const previous = page.url();
  const viewport = page.viewportSize();
  const view = await page.locator('#view-grid').getAttribute('aria-pressed') === 'true' ? 'grid' : 'list';
  const created = await page.request.post(new URL('/api/links', base).href, { data: { url: 'https://example.com/react-regression', title: 'React thumbnail retry fixture', tags: [] } });
  assert.equal(created.status(), 201);
  const link = await created.json();
  let requests = 0, failed;
  let faviconRequests = 0, iconsFailed;
  const initialIconFailures = new Promise(resolve => { iconsFailed = resolve; });
  const firstFailure = new Promise(resolve => { failed = resolve; });
  const list = async route => {
    const response = await route.fetch();
    const data = await response.json();
    for (const item of data.links || []) if (item.id === link.id) item.hasThumbnail = true;
    await route.fulfill({ response, json: data });
  };
  const thumbnail = async route => {
    if (++requests === 1) { await route.abort(); failed(); return; }
    await route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5t8AAAAASUVORK5CYII=', 'base64') });
  };
  const stats = async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), pending: 0 } });
  };
  const favicon = async route => {
    if (++faviconRequests <= 2) { await route.abort(); if (faviconRequests === 2) iconsFailed(); return; }
    await route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5t8AAAAASUVORK5CYII=', 'base64') });
  };
  await page.route('**/api/links?*', list);
  await page.route(`**/api/links/${link.id}/thumbnail`, thumbnail);
  await page.route('**/api/stats', stats);
  await page.route(`**/api/links/${link.id}/favicon?*`, favicon);
  try {
    await page.locator('#view-grid').click();
    await page.goto(new URL('/?q=React+thumbnail+retry+fixture', base).href);
    const card = page.locator(`.bookmark-card[data-id="${link.id}"]`);
    await card.waitFor();
    await page.locator('#view-grid').click();
    await firstFailure;
    await card.locator('.card-thumbnail').waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.getElementById('refresh-button').getAttribute('aria-disabled') === 'false');
    await page.locator('#refresh-button').click();
    await card.locator('.card-thumbnail').waitFor();
    await page.waitForFunction(id => document.querySelector(`.bookmark-card[data-id="${id}"] .card-thumbnail`)?.naturalWidth > 0, link.id);
    assert.ok(requests >= 2, 'Refresh retries a transient thumbnail failure');
    await page.locator('#view-list').click();
    await initialIconFailures;
    await page.waitForFunction(() => document.getElementById('refresh-button').getAttribute('aria-disabled') === 'false');
    await page.locator('#refresh-button').click();
    await card.locator('.card-site-mark img').waitFor();
    assert.ok(faviconRequests >= 3, 'Refresh starts a new favicon attempt after the bounded retry is exhausted');
    await page.locator('#view-grid').click();
    await card.locator('.card-title button').click();
    await page.locator('#reader-dialog').waitFor();
    await page.emulateMedia({ media: 'print' });
    assert.equal(await page.locator('#app-view').isVisible(), false, 'printing the reader excludes the library shell');
    assert.equal(await page.locator('#reader-dialog').isVisible(), true);
    await page.emulateMedia({ media: 'screen' });
    await page.locator('#reader-notebook-toggle').click();
    await page.locator('#reader-notes').fill('Disposable React lifecycle note');
    await page.locator('#reader-notes-form').getByRole('button', { name: 'Save notes' }).click();
    await page.locator('#reader-dialog #toast').waitFor();
    assert.equal(await page.locator('#toast').evaluate(node => node.parentElement.id), 'toast-root');
    await page.locator('#reader-dialog').evaluate(dialog => dialog.close());
    await page.waitForFunction(() => document.getElementById('toast-root').parentElement === document.body);
    assert.equal(await page.locator('#toast').evaluate(node => node.parentElement.id), 'toast-root', 'dialog dismissal moves the host, retaining React child ownership');
    await page.setViewportSize({ width: 390, height: 900 });
    await card.focus();
    await page.keyboard.press('Space');
    await page.locator('#bulk-bar').waitFor();
    await card.locator('.favorite-button').click();
    await page.locator('#toast').waitFor();
    const notice = await page.locator('#toast').boundingBox(), bar = await page.locator('#bulk-bar').boundingBox();
    assert.ok(notice.y + notice.height <= bar.y, 'feedback remains above the phone selection actions');
  } finally {
    await page.emulateMedia({ media: 'screen' });
    await page.setViewportSize(viewport);
    await page.unroute('**/api/links?*', list);
    await page.unroute(`**/api/links/${link.id}/thumbnail`, thumbnail);
    await page.unroute('**/api/stats', stats);
    await page.unroute(`**/api/links/${link.id}/favicon?*`, favicon);
    assert.equal((await page.request.delete(new URL(`/api/links/${link.id}`, base).href)).status(), 200);
    await page.goto(previous);
    await page.locator('#view-' + view).click();
  }
}
