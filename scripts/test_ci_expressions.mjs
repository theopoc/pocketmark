import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const { Parser, Lexer, Evaluator, data } = await import(pathToFileURL(process.env.ACTIONS_EXPRESSIONS_PATH).href);
const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');

function enabled(job, full, extension) {
  const section = workflow.split(`\n  ${job}:\n`)[1]?.split(/\n  [\w-]+:\n/)[0];
  // Stop at the next job rather than relying on copied workflow conditions.
  const expression = section?.match(/^    if: (.+)$/m)?.[1];
  assert.ok(expression, `${job} must explicitly select its scope`);
  const parsed = new Parser(new Lexer(expression).lex().tokens, ['needs'], []).parse();
  const outputs = new data.Dictionary(
    { key: 'full', value: new data.StringData(full) },
    { key: 'extension', value: new data.StringData(extension) },
  );
  const context = new data.Dictionary({ key: 'needs', value: new data.Dictionary({
    key: 'changes', value: new data.Dictionary({ key: 'outputs', value: outputs }),
  }) });
  return new Evaluator(parsed, context).evaluate().value;
}

test('documentation never starts Go or extension jobs; extension-only starts its own job', () => {
  for (const [full, extension] of [['false', 'false'], ['false', 'true'], ['true', 'true'], ['', '']]) {
    for (const job of ['quality', 'test', 'build']) {
      assert.equal(enabled(job, full, extension), full === 'true', job);
    }
    assert.equal(enabled('extension', full, extension), extension === 'true');
  }
});
