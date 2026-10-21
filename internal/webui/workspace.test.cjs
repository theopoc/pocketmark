const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readRoute, routeSearch, createDrafts, readerSnapshot, tagValues, searchExcerpt } = require('./static/workspace.js');

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
