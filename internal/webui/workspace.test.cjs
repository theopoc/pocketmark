const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readRoute, routeSearch, createDrafts, readerSnapshot, tagValues, searchExcerpt, captureFailure, bookmarkIssues, requestFailure } = require('./static/workspace.js');

test('search excerpts preserve untrusted HTML as literal text and truncated matches', () => {
  assert.deepEqual(searchExcerpt('<img src=x> before \x1ecafé\x1f after'), [
    { text: '<img src=x> before ', match: false }, { text: 'café', match: true }, { text: ' after', match: false },
  ]);
  assert.deepEqual(searchExcerpt('…\x1etruncated'), [{ text: '…', match: false }, { text: 'truncated', match: true }]);
  assert.deepEqual(searchExcerpt(''), []);
});

test('collection/search/sort/page survive a reload and a history round trip', () => {
  const first = readRoute('?filter=favorite&q=design');
  const second = readRoute('?filter=collection&collection=42&q=go+patterns&sort=updated&page=3&fuzzy=1');
  assert.deepEqual(readRoute(routeSearch(second)), second);
  assert.deepEqual(readRoute(routeSearch(first)), first);
  assert.equal(second.collection, 42);
  assert.equal(second.page, 3);
  const descending = readRoute('?sort=title_desc');
  assert.equal(descending.sort, 'title_desc');
  assert.deepEqual(readRoute(routeSearch(descending)), descending);
});

test('tags directory retains its query and the library context it returns to', () => {
  const route = readRoute('?filter=inbox&q=reading&view=tags&tagQuery=%C3%A9t%C3%A9&tagPage=6');
  assert.deepEqual(readRoute(routeSearch(route)), route);
  const tag = readRoute('?tag=R%26D+%2F+web&q=cache');
  assert.deepEqual(readRoute(routeSearch(tag)), tag);
  assert.equal(tag.tag, 'R&D / web');
});

test('untrusted URL state has safe defaults and canonical tag destinations', () => {
  assert.equal(readRoute('?filter=collection&collection=-2').filter, 'all');
  assert.equal(readRoute('?filter=collection&collection=1000002').collection, 1000002);
  assert.equal(readRoute('?filter=unknown&page=Infinity&sort=bad').page, 1);
  assert.equal(readRoute('?page=9999999999').page, 1000000);
  assert.equal(readRoute('?filter=favorite&tag=go').filter, 'all');
  assert.equal(routeSearch(readRoute('')), '');
});

test('text-only captures never offer a broken formatted view', () => {
  const link = { id: 7, archiveAvailable: false };
  assert.equal(readerSnapshot(link, []).url, '');
  assert.equal(readerSnapshot({ ...link, archiveAvailable: true }, []).url, '/api/links/7/reader');
  const html = { id: 8, name: 'Page.html', mediaType: 'text/html', size: 2 * 1024 * 1024 };
  assert.equal(readerSnapshot(link, [html]).url, '/api/links/7/reader?asset=8');
  assert.equal(readerSnapshot(link, [{ ...html, size: html.size + 1 }]).url, '');
});

test('closing and reopening preserves a draft without mutating saved values', () => {
  const drafts = createDrafts();
  const saved = { title: 'Go', notes: 'Saved', tags: ['reference'] };
  drafts.put('bookmark:1', { ...saved, notes: 'Unfinished note' }, saved);
  const restored = drafts.get('bookmark:1');
  assert.equal(restored.notes, 'Unfinished note');
  restored.tags.push('changed');
  assert.deepEqual(drafts.get('bookmark:1').tags, ['reference']);
  assert.equal(saved.notes, 'Saved');
  drafts.put('bookmark:1', saved, saved);
  assert.equal(drafts.size, 0);
});

test('saving reader notes preserves unrelated unfinished editor changes', () => {
  const drafts = createDrafts();
  const saved = { title: 'Original', notes: 'Old' };
  drafts.put('bookmark:1', { title: 'Revised title', notes: 'New note' }, saved);
  const updatedSaved = { ...saved, notes: 'New note' };
  drafts.put('bookmark:1', drafts.get('bookmark:1'), updatedSaved);
  assert.deepEqual(drafts.get('bookmark:1'), { title: 'Revised title', notes: 'New note' });
  drafts.delete('bookmark:1');
  assert.equal(drafts.get('bookmark:1'), null);
});

test('tag chips retain selected tags when typing or pasting more names', () => {
  const selected = ['design', 'reference'];
  assert.deepEqual(tagValues(selected, ' web, design, été & 読書, '), ['design', 'reference', 'web', 'été & 読書']);
  assert.deepEqual(selected, ['design', 'reference']);
  assert.deepEqual(tagValues([], ' , , '), []);
});

test('many selected tags and pending text survive draft serialization without truncation', () => {
  const tags = Array.from({ length: 100 }, (_, i) => `tag-${i}`);
  const values = tagValues(tags, 'a-very-long-tag-name, tag-99');
  const drafts = createDrafts();
  drafts.put('bookmark:new', { tags: values }, { tags: [] });
  assert.deepEqual(drafts.get('bookmark:new').tags, [...tags, 'a-very-long-tag-name']);
  assert.equal(tagValues(values).join(', ').split(', ').length, 101);
});


test('drafts recover after reload and saving or signing out removes the stored copy', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const first = createDrafts(storage);
  first.put('bookmark:7', { notes: 'Unfinished note', tags: ['café'] }, { notes: '', tags: [] });
  const reloaded = createDrafts(storage);
  assert.equal(reloaded.get('bookmark:7').notes, 'Unfinished note');
  reloaded.delete('bookmark:7');
  assert.equal(createDrafts(storage).size, 0);
  reloaded.put('bookmark:new', { title: 'Draft' }, { title: '' });
  reloaded.clear();
  assert.equal(createDrafts(storage).size, 0);
});

test('corrupt or denied browser storage does not prevent editing and stale drafts are removed after quota failure', () => {
  let saved = 'not JSON';
  const storage = { getItem: () => saved, setItem() { throw new Error('quota'); }, removeItem() { saved = null; } };
  const drafts = createDrafts(storage);
  assert.equal(drafts.size, 0);
  drafts.put('bookmark:new', { title: 'Retained in memory' }, {});
  assert.equal(drafts.get('bookmark:new').title, 'Retained in memory');
  assert.equal(drafts.persisted, false);
  assert.equal(saved, null);
});

test('capture recovery distinguishes blocked access, absent pages, timeout and protected destinations', () => {
  assert.match(captureFailure('HTTP 403'), /refused access/);
  assert.match(captureFailure('HTTP 404'), /not found/);
  assert.match(captureFailure('context deadline exceeded'), /too long/);
  assert.match(captureFailure('private address rejected'), /network protection/);
  assert.match(captureFailure('page too large'), /size limit/);
  assert.ok(captureFailure('x'.repeat(1000)).length < 260);
});


test('tag search excerpts show decoded names without JSON punctuation', () => {
  assert.deepEqual(searchExcerpt('["frontend","\x1edesign\x1f"]'), [
    { text: 'frontend · ', match: false }, { text: 'design', match: true },
  ]);
  assert.deepEqual(searchExcerpt('["a\\\"b","c\\\\d"]'), [{ text: 'a"b · c\\d', match: false }]);
});


test('bookmark validation catches UTF-8 limits and unsafe URLs before submission', () => {
  const bookmark = { url: 'https://example.com', title: 'Saved page', tags: [] };
  assert.deepEqual(bookmarkIssues(bookmark), {});
  assert.ok(bookmarkIssues({ ...bookmark, url: 'https://user:secret@example.com' }).url);
  assert.ok(bookmarkIssues({ ...bookmark, title: '界'.repeat(342) }).title);
  assert.ok(bookmarkIssues({ ...bookmark, tags: ['界'.repeat(27)] }).tags);
  assert.ok(bookmarkIssues({ ...bookmark, tags: Array.from({ length: 33 }, (_, i) => 'tag' + i) }).tags);
  assert.ok(bookmarkIssues({ ...bookmark, notes: 'x'.repeat(65537) }).notes);
  const longURL = 'https://example.com/' + 'a'.repeat(1500);
  assert.deepEqual(bookmarkIssues({ ...bookmark, url: longURL, title: longURL }), {});
  assert.deepEqual(bookmarkIssues({ ...bookmark, type: 'file', url: 'pocketmark-file:' + 'a'.repeat(64) }), {});
});

test('request failures offer specific recovery while preserving useful validation details', () => {
  assert.match(requestFailure(0), /connection.*server.*Unsaved changes/);
  assert.match(requestFailure(401), /Sign in again.*drafts/);
  assert.match(requestFailure(404), /no longer available.*Refresh/);
  assert.match(requestFailure(500), /server.*try again.*Unsaved changes/);
  assert.equal(requestFailure(400, 'Choose up to 32 tags.'), 'Choose up to 32 tags.');
  assert.equal(requestFailure(429, 'Retry in one minute.'), 'Retry in one minute.');
});
