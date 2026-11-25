export { openWorkspaceActions } from './navigation.mjs';
import { clickNavigation, openNavigation } from './navigation.mjs';
import assert from 'node:assert/strict';

export async function selectSettings(page, section) {
  const railItem = page.locator(`#settings-navigation [data-settings-section="${section}"]`);
  if (await railItem.isVisible()) {
    await railItem.click();
  } else if (!await page.locator(`[data-settings-panel="${section}"]`).isVisible()) {
    const home = page.locator('[data-settings-go="overview"]:visible');
    if (await home.count()) await home.click();
    if (section !== 'overview') {
      const search = page.getByRole('searchbox', { name: 'Search settings' });
      await search.fill(section);
      await page.locator(`[data-settings-go="${section}"]:visible`).first().click();
    }
  }
  await page.locator(`[data-settings-panel="${section}"]`).waitFor({ state: 'visible' });
}

// Compare Settings with the real library, so a separate oversized scale cannot return.
export async function settingsDensityJourney(page) {
  const viewport = page.viewportSize();
  const initialTheme = await page.locator('html').getAttribute('data-theme');
  const libraryURL = new URL(page.url());
  libraryURL.searchParams.delete('settings');
  const sections = ['appearance', 'ai-tagging', 'api-keys', '2fa', 'sessions', 'password', 'backup', 'sync', 'mobile'];
  for (const theme of ['dark', 'light']) for (const width of [1280, 1024, 901, 900, 390, 320]) {
    await page.goto(libraryURL.href);
    await page.locator('#library-content').waitFor({ state: 'visible' });
    await page.setViewportSize({ width, height: 800 });
    if (await page.locator('html').getAttribute('data-theme') !== theme)
      await page.locator('.main-content > .topbar [data-theme-toggle]').click();
    await openNavigation(page);
    const reference = await page.evaluate(() => {
      const item = document.querySelector('#library-navigation [data-filter].active') || document.querySelector('[data-filter="all"]');
      const font = node => { const s = getComputedStyle(node); return [s.fontSize, s.fontFamily, s.fontWeight, s.lineHeight]; };
      return {
        menuFont: font(item), menuHeight: getComputedStyle(item).minHeight,
        icon: item.querySelector('.icon').getBoundingClientRect().width,
        brand: getComputedStyle(document.querySelector('#sidebar .brand')).fontSize,
        mark: document.querySelector('#sidebar .brand-mark').getBoundingClientRect().toJSON(),
        header: document.querySelector('.main-content > .topbar').getBoundingClientRect().height,
        title: font(document.querySelector('#page-title')),
        rail: document.querySelector('#sidebar').getBoundingClientRect().width,
      };
    });
    await clickNavigation(page, '#settings-button');
    for (const section of sections) {
      await selectSettings(page, section);
      const actual = await page.evaluate(section => {
        const item = document.querySelector(`[data-settings-section="${section}"]`);
        const font = node => { const s = getComputedStyle(node); return [s.fontSize, s.fontFamily, s.fontWeight, s.lineHeight]; };
        return {
          menuFont: font(item), menuHeight: getComputedStyle(item).minHeight,
          icon: parseFloat(getComputedStyle(item.querySelector('.icon')).width),
          brand: getComputedStyle(document.querySelector('.settings-topbar .brand')).fontSize,
          mark: document.querySelector('.settings-topbar .brand-mark').getBoundingClientRect().toJSON(),
          header: document.querySelector('.settings-topbar').getBoundingClientRect().height,
          title: font(document.querySelector("[data-settings-panel]:not([hidden]) h1") || document.querySelector("#settings-detail-title")),
          rail: document.querySelector('#settings-navigation').getBoundingClientRect().width,
        };
      }, section);
      assert.deepEqual(actual.menuFont, reference.menuFont, `${theme}/${width}/${section}: navigation typography matches the library`);
      assert.equal(actual.icon, reference.icon);
      assert.equal(actual.brand, reference.brand);
      assert.equal(actual.mark.width, reference.mark.width);
      assert.equal(actual.mark.height, reference.mark.height);
      assert.equal(actual.header, reference.header);
      assert.deepEqual(actual.title, reference.title, `${section}: page heading matches the library`);
      if (width > 900) {
        assert.equal(actual.menuHeight, reference.menuHeight);
        assert.equal(actual.rail, reference.rail);
      } else assert.ok(parseFloat(actual.menuHeight) >= 44, 'compact phone menus retain touch targets');
    }
  }
  await page.goto(libraryURL.href);
  await page.locator('#library-content').waitFor({ state: 'visible' });
  await page.setViewportSize(viewport);
  if (await page.locator('html').getAttribute('data-theme') !== initialTheme)
    await page.locator('.main-content > .topbar [data-theme-toggle]').click();
}

// Exercise the overview with deterministic run states without sending external backups or alerts.
export async function backupOverviewJourney(page) {
  const template = {
    Revision: '', Enabled: true, Cron: '0 3 * * *', Zone: 'Europe/Paris', WindowMinutes: 120,
    RetentionDays: 7, Next: '2026-11-22T02:00:00Z', Mode: 'full', Endpoint: 'https://s3.example.test',
    Region: 'us-east-1', Bucket: 'backups', Prefix: 'owner', HasCredentials: true,
    HasTelegramToken: true, TelegramChatID: '123', Managed: { Endpoint: true },
  };
  const run = {
    ID: '387dfc5c-6e55-4470-8bac-ce59027fc4d9', Trigger: 'scheduled', Status: 'running',
    Stage: 'upload', Config: template, Requested: '2026-11-21T02:00:00Z', Started: '2026-11-21T02:00:10Z',
  };
  const failed = {
    ...run, ID: '78cb3dfd-ad1c-4366-8e58-c8de40d63110', Status: 'failed', Stage: 'retention',
    Started: '2026-11-20T02:00:01Z', VerifiedAt: '2026-11-20T02:03:01Z', Finished: '2026-11-20T02:04:01Z', Notification: 'sent',
  };
  const queued = {
    ...run, ID: 'bab95a7d-1f04-43cb-8505-44be09980a2b', Status: 'queued', Trigger: 'manual',
    Stage: '', Started: '0001-01-01T00:00:00Z',
  };
  let settings = template, runs = [run, failed], submitted;
  const handler = async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/backups') return route.fulfill({ json: { settings, runs } });
    if (path.endsWith('/run')) {
      if (!runs.includes(queued)) runs = [queued, ...runs];
      return route.fulfill({ status: 202, json: { id: queued.ID } });
    }
    if (path.endsWith('/preview')) return route.fulfill({ json: ['2026-11-22T02:00:00Z'] });
    if (path.endsWith('/settings')) {
      submitted = route.request().postDataJSON();
      settings = { ...settings, ...submitted };
      return route.fulfill({ json: { ok: true } });
    }
    await route.abort();
  };
  await page.route('**/api/backups**', handler);
  try {
    await selectSettings(page, 'backup');
    const panel = page.locator('#scheduled-backups');
    await panel.getByText('7 days', { exact: true }).waitFor();
    assert.deepEqual(await panel.getByRole('columnheader', { includeHidden: true }).allTextContents(),
      ['Backup ID', 'Source', 'Duration', 'Result', 'Started']);
    await panel.getByRole('button', { name: 'Back up now' }).click();
    const row = panel.getByRole('row').filter({ has: page.getByRole('button', { name: 'Details for ' + queued.ID }) });
    await row.waitFor();
    assert.equal(await row.locator('td').last().innerText(), '—');
    assert.equal(await row.locator('td').last().evaluate(node => getComputedStyle(node).textAlign), 'right');
    const filter = panel.getByRole('combobox', { name: 'Filter backup history' });
    await filter.press('Enter');
    await filter.press('End');
    await filter.press('Enter');
    await panel.getByRole('button', { name: 'Details for ' + failed.ID }).press('Enter');
    const detail = page.getByRole('dialog', { name: 'Backup details' });
    await detail.getByText('Retention failed').waitFor();
    await detail.getByText(/SHA-256 verified/).waitFor();
    await detail.getByText('Delivered', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await panel.getByRole('button', { name: 'Details for ' + failed.ID }).evaluate(node => document.activeElement === node), true);
    await panel.getByRole('button', { name: 'Configure' }).click();
    const configure = page.getByRole('dialog', { name: 'Configure remote backups' });
    assert.equal(await configure.getByRole('switch').count(), 0);
    const zone = configure.getByRole('combobox', { name: 'Time zone' });
    await zone.press('Enter');
    await configure.getByRole('group', { name: /GMT/ }).first().waitFor();
    await zone.press('ArrowDown');
    await zone.press('Enter');
    await configure.getByLabel('Retention (days)', { exact: false }).fill('9');
    await configure.getByRole('button', { name: 'Storage', exact: true }).click();
    assert.equal(await configure.getByLabel(/S3 API endpoint/).evaluate(node => node.readOnly), true);
    await configure.getByRole('button', { name: 'Telegram', exact: true }).click();
    await configure.getByLabel('Send failure alerts').uncheck();
    await configure.getByRole('button', { name: 'Save settings' }).click();
    await panel.getByText('9 days', { exact: true }).waitFor();
    assert.equal(submitted.ClearTelegram, true);
    assert.equal(submitted.Revision, '');
    assert.equal(submitted.RetentionDays, 9);
    assert.equal(Object.hasOwn(submitted, 'Managed'), false);
  } finally {
    await page.unroute('**/api/backups**', handler);
  }
}

// Configure a real destination through the form and back up to the in-memory
// S3 server started by scripts/smoke_frontend.py (tools/go/fakes3). Runs that
// start the server elsewhere (Docker image smoke) have no endpoint and skip it.
export async function backupRemoteJourney(page) {
  const endpoint = process.env.E2E_S3_ENDPOINT;
  if (!endpoint) return;
  const bucket = process.env.E2E_S3_BUCKET, accessKey = process.env.E2E_S3_ACCESS_KEY;
  // Start from the server's state, not the panel left by the mocked journey.
  await selectSettings(page, 'backup');
  await page.reload();
  await page.locator('[data-settings-panel="backup"]').waitFor({ state: 'visible' });
  const panel = page.locator('#scheduled-backups');
  await panel.getByText('No remote backups yet.').waitFor();
  await panel.getByRole('button', { name: 'Configure' }).click();
  const configure = page.getByRole('dialog', { name: 'Configure remote backups' });
  const contents = configure.getByRole('combobox', { name: 'Backup contents' });
  await contents.press('Enter');
  await contents.press('End');
  await contents.press('Enter');
  await configure.getByText('Include with bookmark metadata').waitFor();
  await configure.getByRole('button', { name: 'Storage', exact: true }).click();
  await configure.getByLabel('S3 API endpoint').fill(endpoint);
  await configure.getByLabel('Bucket', { exact: true }).fill(bucket);
  await configure.getByLabel('Signing region').fill('us-east-1');
  await configure.getByLabel('Object prefix').fill('e2e');
  await configure.getByLabel('Access key ID').fill('E2EUNKNOWNKEY');
  await configure.getByLabel('Secret access key').fill('e2e-secret');
  await configure.getByLabel('Allow HTTP for a private endpoint').check();
  await configure.getByRole('button', { name: 'Test connection' }).click();
  const failure = configure.getByRole('alert').filter({ hasText: 'S3 connection test failed at PutObject (InvalidAccessKeyId).' });
  await failure.waitFor();
  assert.equal((await failure.innerText()).includes('e2e-secret'), false, 'connection error shows the secret');
  await configure.getByLabel('Access key ID').fill(accessKey);
  await configure.getByRole('button', { name: 'Test connection' }).click();
  await configure.getByRole('status').filter({ hasText: 'Connection verified.' }).waitFor();
  await configure.getByRole('button', { name: 'Save settings' }).click();
  await configure.waitFor({ state: 'detached' });
  await panel.getByText(bucket, { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Back up now' }).click();
  // The worker polls every 2 s and the panel every 5 s.
  await panel.getByRole('row').filter({ hasText: 'Custom library' }).filter({ hasText: 'Succeeded' })
    .first().waitFor({ timeout: 60_000 });
  const listing = await (await fetch(`${endpoint}/${bucket}?list-type=2&prefix=e2e/`)).text();
  const keys = [...listing.matchAll(/<Key>([^<]+)<\/Key>/g)].map(m => m[1]);
  assert.equal(keys.filter(key => !key.startsWith('e2e/.probe/')).length, 1, listing);
  assert.equal(keys.some(key => key.startsWith('e2e/.probe/')), false, 'connection probe left behind');
}

export async function settingsNavigationJourney(page) {
  const original = new URL(page.url());
  original.searchParams.delete('settings');
  const context = new URL(original);
  context.searchParams.set('filter', 'favorite');
  context.searchParams.set('q', 'settings navigation');
  context.searchParams.set('sort', 'title');
  await page.goto(context.href);
  await page.locator('#library-content').waitFor({ state: 'visible' });
  await settingsDensityJourney(page);
  await clickNavigation(page, '#settings-button');
  assert.equal(await page.locator('#settings-page').evaluate(node => node.tagName), 'SECTION');
  assert.equal(await page.locator('dialog[open]').count(), 0);
  assert.equal(await page.locator('#library-navigation').isVisible(), false);
  assert.equal(await page.locator('#settings-navigation [data-settings-section]').count(), 10);
  assert.equal(new URL(page.url()).searchParams.get('settings'), 'overview');
  assert.equal(await page.locator('#settings-section-picker').count(), 0);
  const viewport = page.viewportSize();
  const initialTheme = await page.locator('html').getAttribute('data-theme');
  const sections = ['appearance', 'ai-tagging', 'api-keys', '2fa', 'sessions', 'password', 'backup', 'sync', 'mobile'];
  for (const theme of ['dark', 'light']) {
    if (await page.locator('html').getAttribute('data-theme') !== theme)
      await page.locator('.settings-topbar [data-theme-toggle]').click();
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate(async () => {
        await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
      });
      if (width > 900) await page.waitForFunction(() => {
        const active = document.querySelector('[data-settings-section][aria-current="page"]');
        const item = active.getBoundingClientRect(), menu = active.closest('nav').getBoundingClientRect();
        return item.left >= menu.left && item.right <= menu.right + 1;
      });
      const labels = await page.locator('[data-settings-section]').allTextContents();
      const header = await page.locator('.settings-topbar').boundingBox();
      for (const section of sections) {
        await selectSettings(page, section);
        assert.equal(new URL(page.url()).searchParams.get('settings'), section);
        assert.equal(await page.locator('[data-settings-panel]:visible').count(), 1);
        assert.equal(await page.locator('#settings-navigation').isVisible(), width > 900);
        assert.deepEqual(await page.locator('[data-settings-section]').allTextContents(), labels);
        assert.equal(await page.locator('[data-settings-section][aria-current="page"]').count(), 1);
        assert.equal(await page.locator(`[data-settings-section="${section}"]`).getAttribute('aria-current'), 'page');
        assert.deepEqual(await page.locator('.settings-topbar').boundingBox(), header);
        assert.equal(await page.locator('.main-content > .topbar').isVisible(), false);
        assert.equal(await page.locator("#settings-page").getByRole("heading", { level: 1 }).evaluate(n => n === document.activeElement), true);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${theme}/${width}/${section} overflows`);
        if (width > 900) assert.ok(await page.locator(`[data-settings-section="${section}"]`).evaluate(n => {
          const item = n.getBoundingClientRect(), menu = n.closest('nav').getBoundingClientRect();
          return item.left >= menu.left && item.right <= menu.right + 1;
        }), `active ${section} is visible in the menu at ${width}px`);
        await page.reload();
        await page.locator(`[data-settings-panel="${section}"]`).waitFor({ state: 'visible' });
        assert.equal(await page.locator(`[data-settings-section="${section}"]`).getAttribute('aria-current'), 'page');
      }
    }
  }
  await page.setViewportSize(viewport);
  if (await page.locator('html').getAttribute('data-theme') !== initialTheme)
    await page.locator('.settings-topbar [data-theme-toggle]').click();
  await selectSettings(page, 'api-keys');
  // Long destinations must not stretch or move the shared desktop menu.
  await page.setViewportSize({ width: 1280, height: 720 });
  await selectSettings(page, 'api-keys');
  const menuBefore = await page.locator('#settings-navigation').boundingBox();
  const backBefore = await page.locator('.settings-topbar [data-settings-back]').boundingBox();
  const sessionsURL = new URL('/api/sessions', page.url()).href;
  const longSessions = route => route.fulfill({ json: Array.from({ length: 8 }, (_, id) => ({ id, current: id === 0, device: 'Chrome/156 Linux' })) });
  await page.route(sessionsURL, longSessions);
  await selectSettings(page, 'sessions');
  await page.locator('#sessions-refresh').click();
  await page.locator('#sessions-list .session-card').nth(7).waitFor();
  assert.deepEqual(await page.locator('#settings-navigation').boundingBox(), menuBefore);
  assert.deepEqual(await page.locator('.settings-topbar [data-settings-back]').boundingBox(), backBefore);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  assert.equal(await page.locator('.settings-topbar').evaluate(n => n.getBoundingClientRect().top), 0);
  assert.ok(await page.locator('.settings-topbar [data-settings-back]').evaluate(n => n.getBoundingClientRect().bottom <= innerHeight));
  await page.unroute(sessionsURL, longSessions);
  await selectSettings(page, 'mobile');
  await page.setViewportSize({ width: 1280, height: 390 });
  await page.reload();
  await page.locator('[data-settings-panel="mobile"]').waitFor({ state: 'visible' });
  await page.waitForFunction(() => {
    const active = document.querySelector('[data-settings-section="mobile"]');
    const item = active.getBoundingClientRect(), menu = active.closest('nav').getBoundingClientRect();
    return item.top >= menu.top && item.bottom <= Math.min(menu.bottom, innerHeight);
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('[data-settings-go="overview"]:visible').count(), 1);
  assert.equal(await page.locator('#settings-page').getByRole('heading', { level: 1 }).evaluate(n => n === document.activeElement), true);
  await page.setViewportSize(viewport);
  await selectSettings(page, 'api-keys');
  // Optional character shortcuts must stay off in settings and persist per browser.
  await page.locator('#api-keys-title').focus();
  await page.keyboard.press('n');
  assert.equal(await page.locator('#bookmark-dialog').isVisible(), false);
  await selectSettings(page, 'appearance');
  await page.locator('#keyboard-shortcuts').uncheck();
  await page.reload();
  await page.locator('#keyboard-shortcuts').waitFor();
  assert.equal(await page.locator('#keyboard-shortcuts').isChecked(), false);
  await clickNavigation(page, '.settings-topbar [data-settings-back]');
  await page.locator('#page-title').focus();
  await page.keyboard.press('n');
  assert.equal(await page.locator('#bookmark-dialog').isVisible(), false);
  assert.equal(await page.locator('#add-bookmark [data-shortcut-hint]').isVisible(), false);
  await openSettings(page, 'appearance');
  await page.locator('#keyboard-shortcuts').check();
  const legacy = new URL(page.url());
  legacy.searchParams.set('settings', '2fa');
  await page.goto(legacy.href);
  await page.locator('#mfa-settings-title').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#settings-page').getByRole('heading', { level: 1 }).evaluate(node => document.activeElement === node && node.getBoundingClientRect().top >= 0 && node.getBoundingClientRect().top < innerHeight), true);
  await aiTaggingJourney(page);
  await claudeTaggingJourney(page);
  await backupOverviewJourney(page);
  await backupRemoteJourney(page);
  await page.reload();
  await page.locator('[data-settings-panel="backup"]').waitFor({ state: 'visible' });
  await selectSettings(page, '2fa');
  await page.goBack();
  await page.locator('[data-settings-panel="backup"]').waitFor({ state: 'visible' });
  await page.goForward();
  await page.locator('[data-settings-panel="2fa"]').waitFor({ state: 'visible' });
  await clickNavigation(page, '.settings-topbar [data-settings-back]');
  await page.locator('#library-content').waitFor({ state: 'visible' });
  assert.equal(new URL(page.url()).searchParams.has('settings'), false);
  assert.equal(await page.locator('#search').inputValue(), 'settings navigation');
  assert.equal(await page.locator('#sort-toggle').getAttribute('aria-label'), 'Sort bookmarks: Title A–Z');
  assert.equal(new URL(page.url()).searchParams.get('filter'), 'favorite');
  await page.goto(original.href);
  await page.locator('#library-content').waitFor({ state: 'visible' });
  await clickNavigation(page, '#settings-button');
  await page.locator('[data-settings-panel="overview"]').waitFor({ state: 'visible' });
  const find = page.getByRole('searchbox', { name: 'Search settings' });
  await find.fill('webdav');
  await find.press('Enter');
  await page.locator('[data-settings-panel="sync"]').waitFor({ state: 'visible' });
  await page.goBack();
  await find.waitFor();
  assert.equal(await find.inputValue(), 'webdav');
}

// Exercise the hosted-account setup and quota UX without using a personal plan.
export async function aiTaggingJourney(page) {
  const panel = page.locator('[data-settings-panel="ai-tagging"]');
  const state = { enabled: false, connected: false, model: '', eligible: 3, hasTags: false, remaining: 0, scan: { status: 'idle', processed: 0, remaining: 0 } };
  const calls = [], connectionRequests = [];
  const handle = async route => {
    const { pathname } = new URL(route.request().url());
    const name = pathname.split('/').at(-1);
    if (name === 'ai-tagging') return route.fulfill({ json: state });
    calls.push(name);
    const payload = route.request().postDataJSON();
    assert.equal(route.request().method(), 'POST');
    switch (name) {
      case 'connect': connectionRequests.push(payload); return route.fulfill({ json: { url: 'https://auth.openai.com/oauth/authorize' } });
      case 'finish': assert.equal(payload.callback, 'http://127.0.0.1/example'); state.connected = true; state.registered = true; break;
      case 'models': return route.fulfill({ json: { models: [{ id: 'fixture', name: 'Fixture model' }] } });
      case 'model': assert.equal(payload.model, 'fixture'); state.model = payload.model; break;
      case 'test': assert.deepEqual(payload, {}); break;
      case 'enable': state.enabled = true; break;
      case 'scan': state.scan = { status: 'paused', remaining: 2, processed: 1, reason: 'quota' }; state.blocked = 'quota'; break;
      case 'resume': state.blocked = ''; state.scan = { status: 'completed', remaining: 0, processed: 3 }; break;
      case 'pause': state.enabled = false; break;
      case 'disconnect': state.connected = false; state.model = ''; break;
      default: throw Error('Unexpected tagging action ' + name);
    }
    return route.fulfill({ json: {} });
  };
  await page.route('**/api/ai-tagging**', handle);
  try {
    await selectSettings(page, 'ai-tagging');
    const action = name => panel.getByRole('button', { name, exact: true });
    await action('Connect ChatGPT').waitFor();
    assert.equal(await action('Use another ChatGPT account').count(), 0);
    await action('Connect ChatGPT').click();
    assert.equal(await panel.getByRole('link', { name: /Continue with ChatGPT/ }).getAttribute('target'), '_blank');
    await panel.getByLabel('Return address').fill('http://127.0.0.1/example');
    await action('Finish connection').click();
    const picker = panel.getByRole('combobox', { name: 'Tagging model' });
    await picker.press('Enter');
    await picker.press('End');
    await picker.press('Enter');
    await action('Test connection').click();
    await panel.getByText('Connection tested with a fictional bookmark.').waitFor();
    assert.equal(await action('Classify 3 bookmarks').isDisabled(), true);
    await action('Enable automatic tagging').click();
    await action('Classify 3 bookmarks').click();
    await panel.getByText('1 processed · 2 remaining').waitFor();
    assert.equal(await panel.getByRole('link', { name: /Manage plan usage/ }).getAttribute('href'), 'https://chatgpt.com/settings/usage');
    await action('Resume tagging').click();
    await panel.getByText('Scan complete', { exact: true }).waitFor();
    await action('Pause automatic tagging').click();
    await action('Disconnect').click();
    await action('Reconnect ChatGPT').click();
    await action('Cancel').click();
    await action('Use another ChatGPT account').click();
    await panel.getByLabel('Return address').fill('http://127.0.0.1/example');
    await action('Finish connection').click();
    await panel.getByRole('combobox', { name: 'Tagging model' }).waitFor();
    assert.equal(await action('Use another ChatGPT account').count(), 0);
    assert.deepEqual(connectionRequests, [{}, {}, { newAccount: true }]);
    assert.deepEqual(calls, ['connect', 'finish', 'models', 'model', 'test', 'enable', 'scan', 'resume', 'pause', 'disconnect', 'connect', 'connect', 'finish', 'models']);
  } finally {
    await page.unroute('**/api/ai-tagging**', handle);
  }
}

export async function openSettings(page, section = 'api-keys') {
  if (!await page.locator('#settings-page').isVisible()) await clickNavigation(page, '#settings-button');
  await selectSettings(page, section);
}

// Leave the sessions request in flight while the owner works in 2FA.
export async function refreshSessionsBeforeMFA(page) {
  await selectSettings(page, 'sessions');
  await page.locator('#sessions-refresh').click();
  await selectSettings(page, '2fa');
}

// The Claude provider takes an owner-supplied API key and preselects a model.
export async function claudeTaggingJourney(page) {
  const panel = page.locator('[data-settings-panel="ai-tagging"]');
  const state = { provider: 'chatgpt', claude: { connected: false }, enabled: false, connected: false, model: '', eligible: 3, hasTags: false, remaining: 0, scan: { status: 'idle', processed: 0, remaining: 0 } };
  const calls = [];
  const handle = async route => {
    const { pathname } = new URL(route.request().url());
    const name = pathname.split('/').at(-1);
    if (name === 'ai-tagging') return route.fulfill({ json: state });
    calls.push(name);
    const payload = route.request().postDataJSON();
    switch (name) {
      case 'connect-claude':
        if (payload.apiKey !== 'sk-ant-fixture-key') return route.fulfill({ status: 400, json: { error: 'Anthropic did not accept this API key' } });
        Object.assign(state, { provider: 'claude', claude: { connected: true }, model: 'claude-haiku-5-5' });
        break;
      case 'models': return route.fulfill({ json: { models: [{ id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' }, { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }] } });
      case 'model': assert.equal(payload.model, 'claude-sonnet-5-5'); state.model = payload.model; break;
      case 'disconnect': assert.deepEqual(payload, { provider: 'claude' }); Object.assign(state, { claude: { connected: false }, model: '' }); break;
      default: throw Error('Unexpected tagging action ' + name);
    }
    return route.fulfill({ json: { ok: true } });
  };
  await page.route('**/api/ai-tagging**', handle);
  try {
    await selectSettings(page, 'ai-tagging');
    const action = name => panel.getByRole('button', { name, exact: true });
    const provider = panel.getByRole('combobox', { name: 'Tagging provider' });
    await provider.waitFor();
    await provider.press('Enter');
    await provider.press('End');
    await provider.press('Enter');
    await panel.getByText('ChatGPT plan stays active until the API key is saved.').waitFor();
    const key = panel.getByLabel('Anthropic API key');
    assert.equal(await key.getAttribute('type'), 'password');
    assert.equal(await action('Save API key').isDisabled(), true);
    await key.fill('rejected-key-value');
    await action('Save API key').click();
    await panel.getByText('Anthropic did not accept this API key').waitFor();
    // A rejected key keeps the field for correction and offers no unrelated refresh.
    assert.equal(await key.inputValue(), 'rejected-key-value');
    assert.equal(await action('Refresh status').count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'ai-api-key');
    await key.fill('sk-ant-fixture-key');
    await action('Save API key').click();
    const models = panel.getByRole('combobox', { name: 'Tagging model' });
    await models.waitFor();
    assert.match(await models.textContent(), /Claude Haiku 5\.5/);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'ai-model-trigger');
    await models.press('Enter');
    await models.press('End');
    await models.press('Enter');
    await panel.getByText('Model saved.').waitFor();
    await action('Disconnect').click();
    await panel.getByLabel('Anthropic API key').waitFor();
    assert.deepEqual(calls, ['connect-claude', 'connect-claude', 'models', 'model', 'disconnect']);
  } finally {
    await page.unroute('**/api/ai-tagging**', handle);
  }
}
