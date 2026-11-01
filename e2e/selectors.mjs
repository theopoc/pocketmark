// Disposable real-browser coverage for the shared select component and actual app markup.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const root = new URL('../internal/webui/static/', import.meta.url);
const html = (await readFile(new URL('index.html', root), 'utf8'))
  .replace(/<script\b[^>]*>\s*<\/script>/g, '')
  .replace(/<link\b[^>]*>/g, '');
const browser = await chromium.launch(process.env.E2E_CHROMIUM_EXECUTABLE
  ? { executablePath: process.env.E2E_CHROMIUM_EXECUTABLE }
  : { channel: 'chromium' });
try {
  for (const theme of ['dark', 'light']) for (const width of [1280, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 720 }, reducedMotion: 'reduce' });
    await page.setContent(html);
    await page.addStyleTag({ path: new URL('style.css', root).pathname });
    await page.addStyleTag({ path: new URL('secondary.css', root).pathname });
    await page.addStyleTag({ path: new URL('select.css', root).pathname });
    await page.addScriptTag({ path: new URL('select.js', root).pathname });
    await page.evaluate(theme => {
      document.documentElement.dataset.theme = theme;
      document.getElementById('app-view').hidden = false;
      const select = document.getElementById('bookmark-collection');
      select.replaceChildren(new Option('Inbox', ''), new Option('Reading corner', '1'), new Option('— Articles', '2'));
      PocketmarkSelect.enhanceAll(document);
      document.getElementById('bookmark-dialog').showModal();
    }, theme);
    assert.equal(await page.locator('.app-select-trigger').count(), 9, 'all visible app selects are enhanced');
    assert.equal(await page.locator('#bulk-collection-trigger').count(), 0, 'hidden bulk picker remains untouched');
    const trigger = page.getByRole('combobox', { name: 'Collection', exact: true });
    await page.locator('label[for="bookmark-collection-trigger"]').click();
    assert.equal(await trigger.evaluate(element => element === document.activeElement), true, 'label focuses custom control');
    if (await trigger.getAttribute('aria-expanded') === 'true') await trigger.press('Escape');
    await page.evaluate(() => {
      const select = document.getElementById('bookmark-collection');
      window.selectorEvents = []; select.addEventListener('input', () => window.selectorEvents.push('input')); select.addEventListener('change', () => window.selectorEvents.push('change'));
    });
    await trigger.click();
    assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
    const panel = page.locator('#bookmark-collection-options');
    assert.equal(await panel.getByRole('option').count(), 3);
    const rect = await panel.boundingBox();
    assert.ok(rect.x >= 0 && rect.x + rect.width <= width + 1 && rect.y >= 0 && rect.y + rect.height <= 721, `menu outside viewport: ${JSON.stringify(rect)}`);
    if (width < 600) assert.ok((await trigger.boundingBox()).height >= 44, 'phone target height');
    await trigger.press('ArrowDown');
    assert.equal(await trigger.getAttribute('aria-activedescendant'), 'bookmark-collection-option-1');
    await trigger.press('Enter');
    assert.equal(await page.locator('#bookmark-collection').inputValue(), '1');
    assert.deepEqual(await page.evaluate(() => window.selectorEvents), ['input', 'change'], 'selection emits native form events');
    assert.equal(await trigger.innerText(), 'Reading corner');
    await trigger.press('Enter');
    await trigger.press('Escape');
    assert.equal(await page.locator('#bookmark-dialog').evaluate(dialog => dialog.open), true, 'Escape closes menu before dialog');
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    await page.evaluate(() => {
      const select = document.getElementById('bookmark-collection');
      select.replaceChildren(new Option('Inbox', ''), new Option('New collection', '3'));
      select.value = '3';
    });
    await page.waitForFunction(() => document.getElementById('bookmark-collection-trigger').textContent.trim() === 'New collection');
    await page.evaluate(() => {
      const select = document.getElementById('bookmark-collection'); select.value = ''; PocketmarkSelect.sync(select);
    });
    assert.equal(await trigger.innerText(), 'Inbox', 'programmatic value changes can be synchronized');
    await page.evaluate(() => {
      const select = document.getElementById('bookmark-collection'); select.value = '3'; PocketmarkSelect.sync(select); select.form.reset();
    });
    await page.waitForFunction(() => document.getElementById('bookmark-collection-trigger').textContent.trim() === 'Inbox');
    await page.evaluate(() => { document.getElementById('bookmark-collection').disabled = true; });
    await page.waitForFunction(() => document.getElementById('bookmark-collection-trigger').disabled);
    await page.evaluate(() => { document.getElementById('bookmark-collection').disabled = false; });
    await page.waitForFunction(() => !document.getElementById('bookmark-collection-trigger').disabled);
    await page.evaluate(() => {
      const form = document.getElementById('bookmark-form'), fieldset = document.createElement('fieldset'), select = document.createElement('select');
      select.id = 'select-fieldset-test'; select.setAttribute('aria-label', 'Test select'); select.add(new Option('One', '1')); fieldset.append(select); form.append(fieldset); PocketmarkSelect.enhance(select); fieldset.disabled = true;
    });
    await page.waitForFunction(() => document.getElementById('select-fieldset-test-trigger').disabled);
    await page.evaluate(() => { document.getElementById('select-fieldset-test').closest('fieldset').disabled = false; });
    await page.waitForFunction(() => !document.getElementById('select-fieldset-test-trigger').disabled);
    await trigger.click();
    if (process.env.E2E_SCREENSHOTS) {
      await mkdir(process.env.E2E_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: join(process.env.E2E_SCREENSHOTS, `select-${theme}-${width}.png`) });
    }
    await page.close();
  }
  console.log('Selector keyboard, synchronization and viewport checks passed in both themes.');
} finally { await browser.close(); }
