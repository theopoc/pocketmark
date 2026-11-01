import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const root = new URL('../internal/webui/static/', import.meta.url);
const html = (await readFile(new URL('index.html', root), 'utf8'))
  .replace(/<script\b[^>]*>\s*<\/script>/g, '')
  .replace(/<link\b[^>]*>/g, '');
const browser = await chromium.launch(process.env.E2E_CHROMIUM_EXECUTABLE
  ? { executablePath: process.env.E2E_CHROMIUM_EXECUTABLE } : { channel: 'chromium' });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  await page.setContent(html);
  await page.addStyleTag({ path: new URL('style.css', root).pathname });
  await page.evaluate(() => {
    const app = document.querySelector('#app-view');
    app.hidden = false;
    const rail = document.createElement('div');
    rail.className = 'sidebar-rail';
    app.insertBefore(rail, document.querySelector('#main-content'));
    rail.append(document.querySelector('#sidebar'));
    document.querySelector('#workspace-popover').addEventListener('beforetoggle', event => {
      if (event.newState !== 'open') return;
      const anchor = document.querySelector('#workspace-button').getBoundingClientRect();
      event.target.style.left = `${anchor.left}px`;
      event.target.style.top = `${anchor.bottom + 4}px`;
    });
  });
  await page.mouse.move(2, 200);
  await page.locator('#workspace-button').click();
  const before = await page.locator('#main-content').evaluate(el => el.getBoundingClientRect().left);
  await page.locator('#import-button').hover();
  const after = await page.locator('#main-content').evaluate(el => el.getBoundingClientRect().left);
  assert.equal(after, before, 'workspace menu hover must not move the main content');
  assert.equal(before, 280, 'the open sidebar reserves its width');
  assert.equal(await page.locator('#sidebar').isVisible(), true, 'the sidebar remains visible');
  await page.keyboard.press('Escape');
  await page.locator('#workspace-popover').waitFor({ state: 'hidden' });
  await page.locator('#main-content').focus();
  await page.mouse.move(600, 400);
  assert.equal(await page.locator('#main-content').evaluate(el => el.getBoundingClientRect().left), 0, 'the content expands again after the menu closes');
  console.log('Workspace popover keeps the desktop layout stable.');
} finally { await browser.close(); }
