const fs = require('node:fs');
const assert = require('node:assert/strict');
const vm = require('node:vm');

function assertBundledModule(source) {
  const modules = JSON.parse(fs.readFileSync(`${__dirname}/static/app/modules.json`, 'utf8'));
  assert.ok(modules.includes(`src/features/${source}.js`), `${source} is in the compiled application`);
  const html = fs.readFileSync(`${__dirname}/static/index.html`, 'utf8');
  const entry = html.match(/<script type="module" src="([^"]+)"/)[1];
  assert.ok(fs.existsSync(`${__dirname}/static${entry}`), 'the entry referenced by HTML exists');
  const context = vm.createContext({ self: { addEventListener() {} } });
  vm.runInContext(fs.readFileSync(`${__dirname}/static/sw.js`, 'utf8'), context);
  assert.ok(vm.runInContext(`ASSETS.includes(${JSON.stringify(entry)})`, context), 'the worker caches the compiled entry');
  assert.equal(vm.runInContext('ASSETS.some(path => path === "/" || path.startsWith("/api/"))', context), false);
}
module.exports = { assertBundledModule };
