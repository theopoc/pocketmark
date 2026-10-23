import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const { Parser, Lexer, Evaluator, data } = await import(pathToFileURL(process.env.ACTIONS_EXPRESSIONS_PATH).href);
const workflow = readFileSync(process.env.DEPENDABOT_WORKFLOW_PATH || '.github/workflows/dependabot-auto-merge.yml', 'utf8');
const jobCondition = workflow.match(/^    if: >-\n((?:      .+\n)+)/m)?.[1].trim();
const updateCondition = workflow.match(/^        if: >-\n((?:          .+\n)+)/m)?.[1].trim();
assert.ok(jobCondition, 'auto-merge must check the PR author and repository');
assert.ok(updateCondition, 'auto-merge must filter update types');

function value(input) {
  if (typeof input === 'boolean') return new data.BooleanData(input);
  if (typeof input === 'string') return new data.StringData(input);
  return new data.Dictionary(...Object.entries(input).map(([key, entry]) => ({ key, value: value(entry) })));
}

function evaluate(expression, context) {
  const parsed = new Parser(new Lexer(expression).lex().tokens, Object.keys(context), []).parse();
  return new Evaluator(parsed, value(context)).evaluate().value;
}

function eligiblePR({ author = 'dependabot[bot]', repository = 'theopoc/pocketmark', draft = false } = {}) {
  return evaluate(jobCondition, { github: {
    repository: 'theopoc/pocketmark',
    event: { pull_request: { user: { login: author }, head: { repo: { full_name: repository } }, draft } },
  } });
}

test('only non-draft Dependabot PRs from the same repository are eligible', () => {
  assert.equal(eligiblePR(), true);
  assert.equal(eligiblePR({ author: 'theopoc' }), false);
  assert.equal(eligiblePR({ author: 'github-actions[bot]' }), false);
  assert.equal(eligiblePR({ repository: 'someone/fork' }), false);
  assert.equal(eligiblePR({ draft: true }), false);
});

test('minor and patch updates are allowed; major, missing and unknown metadata fail closed', () => {
  // fetch-metadata reports the highest semver change across a grouped PR.
  for (const [updateType, expected] of [
    ['version-update:semver-minor', true],
    ['version-update:semver-patch', true],
    ['version-update:semver-major', false],
    ['', false],
    ['unknown', false],
  ]) {
    assert.equal(evaluate(updateCondition, { steps: { metadata: { outputs: { 'update-type': updateType } } } }), expected, updateType);
  }
  assert.equal(evaluate(updateCondition, { steps: { metadata: { outputs: {} } } }), false);
});

test('write-enabled automation queues squash merge at the verified head without executing PR code', () => {
  assert.match(workflow, /run: gh pr merge --auto --squash --match-head-commit "\$PR_HEAD" "\$PR_URL"/);
  assert.match(workflow, /PR_HEAD: \$\{\{ github.event.pull_request.head.sha \}\}/);
  assert.doesNotMatch(workflow, /uses: actions\/checkout|gh pr checkout|--admin|skip-verification|skip-commit-verification/);
});
