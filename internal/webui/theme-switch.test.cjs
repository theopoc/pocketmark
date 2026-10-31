const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('./static/theme-switch.js');

test('rapid toggles retain the latest request before a browser snapshot applies', async () => {
  let callback, finish, skipped = 0, current = 'dark'; const classes = new Set();
  const document = { documentElement: { classList: { add: c => classes.add(c), remove: c => classes.delete(c) } }, startViewTransition(fn) { callback = fn; return { ready: Promise.resolve(), finished: new Promise(r => { finish = r; }), skipTransition() { skipped++; } }; } };
  const theme = create({ initial: 'dark', apply: value => { current = value; } }, { document, matchMedia: () => ({ matches: false }) });
  theme.set('light'); theme.set('dark');
  assert.equal(theme.requested, 'dark'); assert.equal(current, 'dark'); assert.equal(skipped, 1);
  callback(); finish(); await new Promise(setImmediate);
  assert.equal(current, 'dark'); assert.equal(classes.size, 0);
});
test('reduced-motion and unsupported browsers apply synchronously', () => {
  for (const reduced of [true, false]) {
    let current;
    const theme = create({ apply: v => { current = v; } }, { document: {}, matchMedia: () => ({ matches: reduced }) });
    theme.set('light'); assert.equal(current, 'light');
  }
});
