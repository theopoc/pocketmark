// Isolated extension popup regression: no real account, tabs or server required.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const browser = await chromium.launch(process.env.E2E_CHROMIUM_EXECUTABLE
  ? { executablePath: process.env.E2E_CHROMIUM_EXECUTABLE }
  : { channel: 'chromium' });
try {
  for (const [theme, width, touch] of [['dark', 400, false], ['light', 400, false], ['light', 280, true]]) {
    const context = await browser.newContext({ viewport: { width, height: 560 }, hasTouch: touch, reducedMotion: 'reduce' });
    await context.addInitScript(theme => {
      localStorage.setItem('pocketmark-extension-theme', theme);
      let releaseLoad;
      const waitForLoad = new Promise(resolve => { releaseLoad = resolve; });
      window.releaseLoad = releaseLoad;
      window.chrome = {
        storage: { local: { setAccessLevel: async () => {}, get: async () => ({ server: 'https://library.example', token: 'key' }), set: async () => {} } },
        tabs: { query: async () => [{ id: 3, url: 'https://example.org', title: 'Example page' }] },
        permissions: { contains: async () => true },
        runtime: { sendMessage: async message => ({ ok: true, value: message.type === 'state' ? null
          : message.type === 'load' ? await waitForLoad.then(() => ({ collections: [{ id: 7, name: 'Reading', parentId: null }, { id: 8, name: 'Articles', parentId: 7 }], tags: [{ name: 'news' }, { name: 'notes' }], link: null }))
            : message.type === 'tags' ? { tags: [{ name: 'news' }, { name: 'notes' }] } : null }) },
      };
    }, theme);
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(pathToFileURL(resolve('extension/popup.html')).href);
    await page.locator('#collection-trigger').waitFor({ state: 'attached' });
    assert.equal(await page.locator('#collection-trigger').isDisabled(), true, 'inherits disabled editor while loading');
    await page.evaluate(() => window.releaseLoad());
    await page.waitForFunction(() => !document.getElementById('editor').disabled);
    assert.equal(await page.locator('#collection-trigger').isEnabled(), true, 'becomes usable once loaded');
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
    await page.locator('#collection-trigger').click();
    assert.equal(await page.getByRole('listbox', { name: 'Collection' }).count(), 1);
    assert.equal(await page.locator('.choice-panel [role=option]').count(), 3);
    const panel = await page.locator('.choice-panel').boundingBox();
    assert.ok(panel.x >= 0 && panel.x + panel.width <= width, 'option list fits viewport');
    if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: resolve(process.env.E2E_SCREENSHOTS, `extension-selector-${theme}-${width}.png`) });
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    assert.equal(await page.locator('#collection').inputValue(), '7');
    await page.locator('#new-collection').click();
    assert.equal(await page.locator('#collection-parent-trigger').innerText(), 'Reading');
    await page.locator('#collection-parent-trigger').focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.getByRole('listbox', { name: 'Inside' }).count(), 1);
    await page.keyboard.press('End'); await page.keyboard.press('Enter');
    assert.equal(await page.locator('#collection-parent').inputValue(), '8');
    await page.locator('#tag-input').focus();
    assert.equal(await page.getByRole('listbox', { name: 'Tags' }).count(), 1);
    assert.equal(await page.locator('.choice-panel [role=option]').count(), 2);
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    assert.equal(await page.locator('#selected-tags li').count(), 1);
    assert.equal(await page.locator('#selected-tags li').first().innerText(), 'news');
    await page.locator('#tag-input').fill('manual'); await page.keyboard.press('Enter');
    assert.equal(await page.locator('#selected-tags li').count(), 2);
    assert.deepEqual(errors, []);
    await context.close();
  }
} finally { await browser.close(); }
console.log('Extension selectors: themes, responsive list, loading, keyboard, and tags passed.');
