import assert from 'node:assert/strict';

// Real pointer and keyboard events against disposable bookmarks, never a personal library.
export async function selectionJourney(page, screenshots) {
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 1280, height: 1000 });
  const base = new URL(page.url()).origin;
  const created = [];
  for (let i = 1; i <= 5; i++) {
    const response = await page.request.post(`${base}/api/links`, { data: { title: `Selection fixture ${i}`, url: `http://127.0.0.1/e2e-selection-${i}`, description: 'A saved reference for the selection journey.', tags: ['reference'] } });
    assert.equal(response.status(), 201);
    created.push((await response.json()).id);
  }
  await page.goto(`${base}/?sort=title`);
  await page.locator('#bookmark-grid[aria-busy="false"]').waitFor();
  await page.locator("#view-list").click();
  const cards = page.locator('#bookmark-grid .bookmark-card').filter({ hasText: 'Selection fixture' });
  const layout = await cards.first().evaluate(card => {
    const rect = selector => card.querySelector(selector).getBoundingClientRect();
    const title = rect('.card-title'), description = rect('.card-description'), domain = rect('.card-domain'), tags = rect('.card-tags');
    return { aligned: Math.abs(title.x - description.x) < 1,
      ordered: title.y < description.y && description.right <= domain.x && domain.right <= tags.x,
      metadataRow: Math.abs((domain.top + domain.bottom) / 2 - (tags.top + tags.bottom) / 2) < 5 };
  });
  assert.deepEqual(layout, { aligned: true, ordered: true, metadataRow: true }, 'wide list keeps title/description together and domain/tags in separate columns');
  assert.equal(await page.locator('.results-tools #refresh-button').count(), 1, 'Refresh is grouped with selection help and view controls');
  const surface = async (index, modifiers = []) => {
    await cards.nth(index).scrollIntoViewIfNeeded();
    const rect = await cards.nth(index).boundingBox();
    for (const key of modifiers) await page.keyboard.down(key);
    await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height - 6);
    for (const key of modifiers.reverse()) await page.keyboard.up(key);
  };
  const count = async n => {
    await page.waitForFunction(n => document.querySelectorAll('#bookmark-grid .is-selected').length === n, n);
  };
  // Releasing just outside the grid before the drag threshold must discard the gesture.
  const edge = await cards.nth(0).boundingBox();
  await page.mouse.move(edge.x + 1, edge.y + 2); await page.mouse.down();
  await page.mouse.move(edge.x - 1, edge.y + 2); await page.mouse.up();
  await page.mouse.move(edge.x + 30, edge.y + 20);
  assert.equal(await page.locator('.selection-marquee').count(), 0);
  await count(0);
  assert.equal(await cards.locator('input[type=checkbox]').count(), 0);
  await surface(0); await count(1);
  await surface(2, ['Shift']); await count(3);
  await surface(1); await count(2);
  assert.equal(await page.locator('#bulk-bar').isVisible(), true);
  assert.equal(await page.locator('#selected-count').textContent(), '2 selected');
  assert.equal(await page.locator('.results-bar #select-page, .results-bar #bulk-open, .results-bar #clear-selection').count(), 0, 'selection actions live only in the floating bar');
  await page.locator('#bulk-read').click();
  await page.locator('#bulk-status-true').focus(); await page.keyboard.press('Escape');
  assert.equal(await page.locator('#bulk-dialog').isVisible(), false);
  await count(2);
  for (const [button, action] of [['bulk-move', 'move'], ['bulk-tag-action', 'tags']]) {
    await page.locator(`#${button}`).click();
    assert.equal(await page.locator('#bulk-dialog').getAttribute('data-action'), action);
    assert.equal(await page.locator(action === 'tags' ? '#bulk-tags-query' : '#bulk-collection-search').evaluate(node => node === document.activeElement), true, `${action} focuses its visible field`);
    await page.locator('#bulk-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  }
  await page.keyboard.press('Escape'); await count(0);
  await cards.nth(1).focus(); await page.keyboard.press('Space'); await count(1);
  assert.match(await cards.nth(1).getAttribute('aria-label'), /selected/);
  await page.keyboard.press('Escape'); await count(0);
  await cards.nth(0).locator('.card-title button').click({ modifiers: ['Control'] }); await count(1);
  assert.equal(await page.locator('#reader-dialog').isVisible(), false);
  await page.keyboard.press('Escape');
  await cards.nth(0).locator('.card-title button').click();
  await page.locator('#reader-dialog').waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await page.locator('#reader-dialog').waitFor({ state: 'hidden' });
  // Drag from a non-interactive row margin through the next row; the release must not toggle it.
  let first = await cards.nth(0).boundingBox(), second = await cards.nth(1).boundingBox();
  await page.mouse.move(first.x + 2, first.y + 2); await page.mouse.down();
  await page.mouse.move(second.x + second.width - 2, second.y + second.height - 2, { steps: 12 });
  await page.mouse.up(); await count(2);
  assert.equal(await page.locator('.selection-marquee').count(), 0);
  await page.locator('.selection-help summary').click();
  assert.equal(await page.locator('.selection-help-panel').isVisible(), true);
  if (screenshots) await page.screenshot({ path: `${screenshots}/selection-desktop.png` });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.selection-help-panel').isVisible(), false);
  await count(2);
  // Freeze the browser animation clock so exit and sibling motion can be inspected reliably.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => {
    const animate = Element.prototype.animate;
    window.selectionAnimations = [];
    Element.prototype.animate = function (...args) {
      const result = animate.apply(this, args);
      if (this.matches('.bookmark-card,.bookmark-exit-layer')) { result.pause(); window.selectionAnimations.push(result); }
      return result;
    };
    window.restoreSelectionAnimate = () => { Element.prototype.animate = animate; };
  });
  await cards.nth(0).getByRole('button', { name: /^Delete bookmark:/ }).click();
  await page.locator('#delete-bookmark-confirm').click();
  await page.locator('.bookmark-exit-layer').waitFor();
  assert.equal(await page.locator('.bookmark-exit-layer').getAttribute('aria-hidden'), 'true');
  assert.equal(await page.locator('.bookmark-exit-layer').evaluate(node => node.inert), true);
  assert.ok(await page.evaluate(() => window.selectionAnimations.length >= 2), 'removal animates the exit and remaining siblings');
  await page.evaluate(() => { window.restoreSelectionAnimate(); window.selectionAnimations.forEach(animation => animation.finish()); });
  await page.locator('.bookmark-exit-layer').waitFor({ state: 'detached' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('#clear-selection').click();
  await page.locator('#view-grid').click();
  await surface(0); await surface(1, ['Shift']); await count(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.selection-help summary').click();
  assert.ok(await page.locator('.selection-help-panel').evaluate(node => {
    const rect = node.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth;
  }), 'selection help fits a phone');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'selection toolbar fits a phone');
  assert.ok(await page.locator('#bulk-bar').evaluate(node => { const rect = node.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight; }), 'floating actions stay inside the phone viewport');
  if (screenshots) await page.screenshot({ path: `${screenshots}/selection-mobile.png` });
  await page.locator('.selection-help summary').click();
  await page.locator('#bulk-open').click();
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForFunction(() => {
    const r = document.querySelector('#bulk-dialog').getBoundingClientRect();
    return r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
  });
  assert.ok(await page.locator('#bulk-dialog').evaluate(node => {
    const r = node.getBoundingClientRect(); return r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
  }), 'an open phone sheet stays reachable after landscape rotation');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.id === 'select-page');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#bulk-open').click();
  await page.locator('[data-bulk-action="delete"]').click();
  await page.locator('#bulk-apply').click();
  await page.locator('#bulk-dialog').waitFor({ state: 'hidden' });
  await count(0);
  assert.equal(await page.locator('.bookmark-exit-layer').count(), 0, 'reduced motion omits exit layers');
  for (const id of created) await page.request.delete(`${base}/api/links/${id}`);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(base);
  await page.locator('#bookmark-grid[aria-busy="false"]').waitFor();
  await page.locator('#view-list').click();
  await page.setViewportSize(viewport);
}
