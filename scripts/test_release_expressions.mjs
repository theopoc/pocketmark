import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const { Parser, Lexer, Evaluator, data } = await import(pathToFileURL(process.env.ACTIONS_EXPRESSIONS_PATH).href);
const workflow = readFileSync(process.env.RELEASE_WORKFLOW_PATH || '.github/workflows/release.yml', 'utf8');
const expression = workflow.match(/^ +PR_NUMBER: \$\{\{ (.+) \}\}$/m)?.[1];
assert.ok(expression, 'release workflow must expose its PR-number expression');

function evaluate(pr) {
  const outputs = new data.Dictionary(...(pr === undefined ? [] : [{ key: 'pr', value: new data.StringData(pr) }]));
  const context = new data.Dictionary({ key: 'steps', value: new data.Dictionary(
    { key: 'release', value: new data.Dictionary({ key: 'outputs', value: outputs }) },
  ) });
  const parsed = new Parser(new Lexer(expression).lex().tokens, ['steps'], []).parse();
  return new Evaluator(parsed, context).evaluate().coerceString();
}

test('release creation with no next PR leaves an empty PR number', () => {
  assert.equal(evaluate(''), '');
});

test('manual and tag runs with no Release Please output remain valid', () => {
  assert.equal(evaluate(undefined), '');
});

test('an opened release PR retains its number for CI dispatch', () => {
  assert.equal(evaluate(JSON.stringify({ number: 24 })), '24');
});

test('malformed non-empty output fails rather than selecting a PR', () => {
  assert.throws(() => evaluate('invalid-json'));
});
