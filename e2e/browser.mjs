// Real Chromium, real HTTP and SQLite. Run only against the disposable smoke instance.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = new URL(process.env.E2E_BASE_URL);
assert.equal(base.hostname, '127.0.0.1', 'E2E requires a disposable loopback instance');
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const username = 'ci-owner';
  const password = 'Synthetic-E2E-password-42';
  await page.goto(base.href);
  await page.locator('#login-username').fill(username);
  await page.locator('#login-password').fill(password);
  await page.locator('#login-confirm').fill(password);
  await page.locator('#login-submit').click();
  await page.locator('#app-view').waitFor({ state: 'visible' });

  await page.locator('#logout-button').click();
  await page.locator('#login-username').fill(username);
  await page.locator('#login-password').fill('incorrect-password');
  await page.locator('#login-submit').click();
  await page.waitForFunction(() => document.getElementById('login-error').textContent.length > 0);
  await page.locator('#login-password').fill(password);
  await page.locator('#login-submit').click();
  await page.locator('#app-view').waitFor({ state: 'visible' });

  const original = 'Browser integration bookmark';
  const revised = 'Browser revised bookmark';
  await page.locator('#add-bookmark').click();
  // A private destination is deliberately rejected by the capture worker: no public network.
  await page.locator('#bookmark-url').fill('http://127.0.0.1/e2e-fixture');
  await page.locator('#bookmark-title').fill(original);
  await page.locator('#bookmark-notes').fill('Persisted browser notes');
  await page.locator('#save-bookmark').click();
  const card = title => page.locator('.bookmark-card').filter({ has: page.getByRole('button', { name: title, exact: true }) });
  const openActions = async title => {
    const toggle = card(title).getByRole('button', { name: `Actions for ${title}`, exact: true });
    if (await toggle.isVisible()) await toggle.click();
  };
  await card(original).waitFor();
  await page.locator('#search').fill('absent-e2e-bookmark-42');
  await page.locator('#empty-title').filter({ hasText: 'No bookmarks found' }).waitFor();
  await page.locator('#search').fill('Browser integration');
  await card(original).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.bookmark-card').length === 1);
  await openActions(original);
  await card(original).getByRole('button', { name: `Edit bookmark: ${original}`, exact: true }).click();
  await page.locator('#bookmark-title').fill(revised);
  await page.locator('#save-bookmark').click();
  await page.locator('#bookmark-dialog').waitFor({ state: 'hidden' });
  await page.locator('#search').fill('Browser revised');
  await card(revised).waitFor();
  await page.reload();
  await card(revised).waitFor();
  await openActions(revised);
  await card(revised).getByRole('button', { name: `Edit bookmark: ${revised}`, exact: true }).click();
  assert.equal(await page.locator('#bookmark-notes').inputValue(), 'Persisted browser notes');
  await page.locator('#bookmark-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  await card(revised).getByRole('button', { name: `Delete bookmark: ${revised}`, exact: true }).click();
  await card(revised).waitFor({ state: 'detached' });
  await page.reload();
  await page.locator('#empty-title').filter({ hasText: 'No bookmarks found' }).waitFor();
  await page.locator('#logout-button').click();
  await page.reload();
  await page.locator('#login-view').waitFor({ state: 'visible' });
  assert.deepEqual(errors, [], 'browser must not throw uncaught JavaScript errors');
  console.log('Browser E2E passed: setup, login rejection/login, CRUD, search, reload persistence, logout.');
} finally {
  await browser.close();
}
