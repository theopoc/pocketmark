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

const sourceCondition = workflow.match(/^  source:\n[\s\S]*?^    if: >-\n((?:      .+\n)+)/m)?.[1].trim();
assert.ok(sourceCondition, 'release source selection must use an event condition');

function actionData(value) {
  if (value === null || value === undefined) return new data.Null();
  if (typeof value === 'string') return new data.StringData(value);
  if (typeof value === 'boolean') return new data.BooleanData(value);
  if (typeof value === 'number') return new data.NumberData(value);
  if (Array.isArray(value)) return new data.Array(...value.map(actionData));
  return new data.Dictionary(...Object.entries(value).map(([key, item]) => ({ key, value: actionData(item) })));
}

function selectsRelease(eventName, changes = {}) {
  const pullRequest = {
    merged: true,
    head: { repo: { full_name: 'example/pocketmark' } },
    labels: [{ name: 'autorelease: pending' }],
    ...changes,
  };
  const context = actionData({ github: {
    event_name: eventName,
    repository: 'example/pocketmark',
    event: { pull_request: pullRequest },
  } });
  const parsed = new Parser(new Lexer(sourceCondition).lex().tokens, ['github'], []).parse();
  return new Evaluator(parsed, context).evaluate().value;
}

test('only a merged release PR from this repository starts release validation', () => {
  assert.equal(selectsRelease('pull_request'), true);
  assert.equal(selectsRelease('pull_request', { merged: false }), false);
  assert.equal(selectsRelease('pull_request', { labels: [] }), false);
  assert.equal(selectsRelease('pull_request', { head: { repo: { full_name: 'other/fork' } } }), false);
  assert.equal(selectsRelease('pull_request', { head: { repo: null } }), false);
});

test('ordinary pushes only prepare a PR; explicit dispatch can verify or resume', () => {
  assert.equal(selectsRelease('push'), false);
  assert.equal(selectsRelease('workflow_dispatch'), true);
});
