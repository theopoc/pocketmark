import assert from 'node:assert/strict';

export async function navigationLayoutJourney(library) {
  // The Playwright clock applies to its whole browser context.
  const page = await library.context().browser().newPage({
    storageState: await library.context().storageState(),
    viewport: { width: 1280, height: 800 },
    reducedMotion: 'reduce',
  });
  try {
    const start = Date.now();
    await page.clock.install({ time: start });
    await page.goto(library.url());
    await page.locator('#app-view').waitFor();
    await page.mouse.move(600, 400);
    await page.clock.pauseAt(start + 60_000);
    const sidebar = page.locator('#sidebar');
    const mainLeft = () => page.locator('#main-content').evaluate(node => node.getBoundingClientRect().left);

    await page.mouse.move(2, 400);
    await page.clock.fastForward(80);
    assert.equal(await sidebar.isVisible(), false, 'briefly brushing the edge leaves the library alone');
    await page.mouse.move(600, 400);
    await page.clock.fastForward(600);
    assert.equal(await sidebar.isVisible(), false, 'leaving the edge cancels the pending reveal');

    await page.mouse.move(2, 400);
    await page.clock.fastForward(250);
    assert.equal((await sidebar.boundingBox())?.x, 16, 'dwelling at the edge reveals the whole floating panel with reduced motion');
    assert.equal(await mainLeft(), 0, 'temporary navigation overlays the library');
    await page.locator('.api-documentation-link').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'open-navigation');
    assert.equal(await sidebar.isVisible(), false, 'tabbing out uncovers the focused header even with the pointer parked');
    await page.mouse.move(600, 400);
    await page.mouse.move(2, 400);
    await page.clock.fastForward(250);
    await page.mouse.move(600, 400);
    await page.clock.fastForward(150);
    assert.equal((await sidebar.boundingBox())?.x, 16, 'a short detour leaves the panel in place');
    await page.mouse.move(80, 400);
    await page.clock.fastForward(600);
    assert.equal(await sidebar.isVisible(), true, 'returning to the panel cancels its pending close');
    await page.mouse.move(600, 400);
    await page.clock.fastForward(600);
    assert.equal(await sidebar.isVisible(), false, 'staying outside closes the panel');

    await page.locator('#main-content').focus();
    await page.mouse.move(2, 400);
    await page.clock.fastForward(250);
    assert.equal(await sidebar.isVisible(), true);
    await page.keyboard.press('Escape');
    await page.clock.fastForward(600);
    assert.equal(await sidebar.isVisible(), false, 'Escape dismisses hover navigation with the pointer still at the edge');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'main-content', 'hover never steals library focus');

    await page.locator('#open-navigation').press('Enter');
    assert.equal((await sidebar.boundingBox())?.x, 16, 'the keyboard opener bypasses hover delays');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'sidebar-mode');
    await page.locator('#workspace-button').click();
    await page.locator('#import-button').hover();
    await page.clock.fastForward(600);
    assert.equal(await mainLeft(), 0, 'hovering a workspace action leaves the library in place');
    await page.keyboard.press('Escape');
    await page.locator('#workspace-popover').waitFor({ state: 'hidden' });
    assert.equal(await sidebar.isVisible(), true, 'Escape dismisses the workspace menu first');
    await page.keyboard.press('Escape');
    assert.equal(await sidebar.isVisible(), false, 'Escape closes temporary navigation immediately');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'open-navigation');
  } finally {
    await page.close();
  }
}
