// Compare the protected library with the exact same disposable fixture and browser.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const fixture = JSON.parse(await readFile(process.env.E2E_FIXTURE_FILE, 'utf8'));
assert.equal(new URL(fixture.base).hostname, '127.0.0.1');
const output = process.env.E2E_EVIDENCE_DIR, reference = process.env.E2E_REFERENCE_DIR;
assert.ok(output, 'Choose an evidence directory outside the repository');
await mkdir(output, { recursive: true });
const browser = await chromium.launch(process.env.E2E_CHROMIUM_EXECUTABLE ? { executablePath: process.env.E2E_CHROMIUM_EXECUTABLE } : {});
let compared = 0, protectedCompared = 0;
const fullImageDifferences = [];
try {
  for (const theme of ['dark', 'light']) {
    for (const width of [1280, 390, 320]) {
      const context = await browser.newContext({ storageState: fixture.storageState, viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      await context.addInitScript(theme => { localStorage.setItem('pocketmark-theme', theme); }, theme);
      const page = await context.newPage(); await page.goto(fixture.base);
      await page.locator('.bookmark-card').first().waitFor(); await page.evaluate(() => document.fonts.ready);
      async function capture(state) {
        const name = `${theme}-${width}-${state}.png`;
        // Reduced motion retains brief control-color feedback; let its layers settle.
        await page.evaluate(async () => {
          await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
        const bytes = await page.screenshot({ animations: 'disabled' });
        await writeFile(join(output, name), bytes);
        if (reference && !bytes.equals(await readFile(join(reference, name)))) fullImageDifferences.push(name);
        const metrics = await page.locator('#bookmark-grid, .bookmark-card, .card-title, .card-action, #sort-toggle, .search-box').evaluateAll(nodes => nodes.map(n => {
          const r = n.getBoundingClientRect(), style = getComputedStyle(n);
          return { class: n.className, x: r.x, y: r.y, width: r.width, height: r.height,
            font: style.font, color: style.color, background: style.backgroundColor,
            border: style.border, radius: style.borderRadius, padding: style.padding };
        }));
        const metricsName = name.replace('.png', '.json');
        await writeFile(join(output, metricsName), JSON.stringify(metrics));
        if (reference) assert.deepEqual(metrics, JSON.parse(await readFile(join(reference, metricsName), 'utf8')), `Library layout/style changed: ${name}`);
        const frozen = [page.locator('#sort-toggle')];
        if (await page.locator('#sort-menu').isVisible()) frozen.push(page.locator('#sort-menu'));
        for (const card of await page.locator('.bookmark-card').all()) frozen.push(card.locator('.card-actions'), card.locator('.favorite-button'));
        for (let i = 0; i < frozen.length; i++) {
          const controlName = name.replace('.png', `-control-${i}.png`);
          const control = await frozen[i].screenshot({ animations: 'disabled' });
          await writeFile(join(output, controlName), control);
          if (reference) { assert.ok(control.equals(await readFile(join(reference, controlName))), `Protected control changed: ${controlName}`); protectedCompared++; }
        }
        compared++;
      }
      for (const view of ['list', 'grid']) {
        await page.locator(`#view-${view}`).click();
        await page.mouse.move(width / 2, 10);
        await capture(`${view}-rest`);
        const toggle = page.locator('.bookmark-card').last().locator('.card-actions-toggle');
        if (width <= 900) {
          await toggle.click(); await capture(`${view}-actions`); await toggle.click();
        }
        await page.locator('#sort-toggle').click(); await capture(`${view}-sort`);
        await page.locator('#sort-menu').press('Escape');
      }
      await context.close();
    }
  }
} finally { await browser.close(); }
console.log(reference ? JSON.stringify({ states: compared, protectedControlsMatchedByteForByte: protectedCompared, libraryStyleAndLayoutMatched: compared, fullImageDifferences }) : 'Protected-library reference screenshots and layout recorded');
