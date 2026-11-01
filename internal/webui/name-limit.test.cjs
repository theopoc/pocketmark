const { test } = require('node:test');
const assert = require('node:assert/strict');
const { describe, create } = require('./static/name-limit.js');

test('collection names enforce the server UTF-8 byte limit without a counter', () => {
  for (const name of ['', 'a'.repeat(120), 'é'.repeat(60), '😀'.repeat(30), ' 😀 ']) {
    assert.equal(describe(name).valid, true);
    assert.equal(describe(name).text, '');
  }
  for (const name of ['a'.repeat(121), 'é'.repeat(61), '😀'.repeat(31)]) {
    assert.equal(describe(name).valid, false);
    assert.match(describe(name).text, /name is too long/i);
  }
});

test('the error appears only above the limit and clears after correction', () => {
  let onInput, validity;
  const input = { value: '', addEventListener: (_, listener) => { onInput = listener; }, setCustomValidity: message => { validity = message; } };
  const hint = { textContent: '' };
  create(input, hint);
  assert.equal(hint.textContent, '');
  input.value = 'a'.repeat(120); onInput();
  assert.equal(hint.textContent, ''); assert.equal(validity, '');
  input.value += 'a'; onInput();
  assert.match(hint.textContent, /name is too long/i); assert.equal(validity, hint.textContent);
  input.value = 'é'.repeat(60); onInput();
  assert.equal(hint.textContent, ''); assert.equal(validity, '');
});
