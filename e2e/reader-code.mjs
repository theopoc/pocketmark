import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

export const readerCodeFixture = `
  <svg aria-hidden="true"><title/></svg>
  <div class="language-sh"><pre><code class="highlight"><span style="display:block"><span hidden>1 </span>build_app</span><span style="display:block"><span aria-hidden="true">2 </span>  run_app</span></code></pre></div>
  <pre><code><span class="line">first_line</span>
<span class="line"></span>
<span class="line">last_line</span>
</code></pre>
  <pre><code><span data-pocketmark-code-layout="block"><span data-pocketmark-code-layout="hidden">4 </span>captured_one</span><span data-pocketmark-code-layout="block">captured_two</span></code></pre>
  <table>
    <tr><td aria-hidden="true">1</td><td><code>let n = 3;</code></td></tr>
    <tr><td aria-hidden="true">2</td><td><code>  n++;</code></td></tr>
  </table>
  <table><tr><th>Priority</th><th>Command</th></tr><tr><td>1</td><td><code>ordinary_cell</code></td></tr></table>
  <!-- <b style="display:none"> -->
  <script type="text/plain">const sample = '<tag style="display:none">';</script>
  <pre><span title='example > style="literal"' data-pocketmark-style-0="display:none" StYlE = "display:block">literal &lt;tag style="value"&gt;</span><span STYLE=display:block>  &amp; done</span></pre>
`;

export async function checkReaderCode(article) {
  const sourcePage = await article.page().context().browser().newPage();
  try {
    await sourcePage.setContent('<style>.custom-row{display:block}.custom-gutter{display:none}</style><pre><span class="custom-row"><b class="custom-gutter">1 </b>one</span><span class="custom-row">two</span></pre>');
    await sourcePage.addScriptTag({path: fileURLToPath(new URL('../extension/capture.js', import.meta.url))});
    const captured = await sourcePage.evaluate(async () => {
      const {html} = await snapshotPage();
      const template = document.createElement('template');
      template.innerHTML = html;
      return [...template.content.querySelectorAll('pre *')].map(node => node.getAttribute('data-pocketmark-code-layout'));
    });
    assert.deepEqual(captured, ['block', 'hidden', 'block']);
  } finally {
    await sourcePage.close();
  }
  for (const expected of ['build_app\n  run_app', 'first_line\n\nlast_line\n', 'captured_one\ncaptured_two', 'let n = 3;\n  n++;', 'literal <tag style="value">\n  & done']) {
    const block = article.locator('.reader-article-code').filter({hasText: expected.split('\n')[0]});
    assert.equal(await block.locator('pre code').innerText(), expected);
    const copied = await block.evaluate(async wrapper => {
      const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
      let text;
      Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {
        async writeText(value) { text = value; }
      }});
      try {
        wrapper.querySelector('[aria-label="Copy code"]').click();
        await Promise.resolve();
        return text;
      } finally {
        if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor);
        else delete navigator.clipboard;
      }
    });
    assert.equal(copied, expected);
  }
  assert.equal(await article.locator('.reader-article-code').filter({hasText: 'build_app'}).getByText('SH', {exact: true}).count(), 1);
  assert.equal(await article.locator('table td code').filter({hasText: 'ordinary_cell'}).count(), 1);
}
