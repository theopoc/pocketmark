const { test } = require('node:test');
const assert = require('node:assert/strict');
const { describe } = require('./static/name-limit.js');

test('collection names count Unicode characters while enforcing the server byte budget', () => {
  assert.equal(describe('a'.repeat(120)).valid, true);
  assert.equal(describe('é'.repeat(60)).valid, true);
  assert.equal(describe('é'.repeat(61)).valid, false);
  assert.equal(describe('😀'.repeat(30)).valid, true);
  assert.equal(describe('😀'.repeat(31)).valid, false);
  assert.match(describe(' 😀 ').text, /^1 character · 4%/);
  assert.match(describe('').text, /^0 characters · 0%/);
});
