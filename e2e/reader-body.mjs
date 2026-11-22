import assert from 'node:assert/strict';

// Exercise the article selected and projected from a saved HTML attachment.
export async function readerBodyJourney(page, base) {
  const previous = page.url();
  const title = 'Reader article with editorial asides';
  const link = await page.request.post(new URL('/api/links', base).href, {
    data: { title, url: 'https://example.com/article-with-notes', tags: [] },
  });
  assert.equal(link.status(), 201);
  const { id } = await link.json();
  try {
    // An embedded PNG commonly exceeds the small bound for ordinary layout hints.
    const diagram = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 96;
      canvas.height = 64;
      const ctx = canvas.getContext('2d');
      const pixels = ctx.createImageData(canvas.width, canvas.height);
      crypto.getRandomValues(pixels.data);
      ctx.putImageData(pixels, 0, 0);
      return canvas.toDataURL('image/png');
    });
    assert.ok(diagram.length > 8192);
    const html = `<main>
      <article><h2>Earlier teaser</h2><p>An unrelated article.</p></article>
      <article><header><h1>${title}</h1><p>By Jules.</p></header>
        <p>Lead paragraph outside the marked body.</p>
        <div itemprop="articleBody"><p>Prose about comments in code.</p>
          <aside><h2>Example</h2><pre><code>// comments stay</code></pre></aside>
          <div role="img" aria-label="Embedded CSS diagram" style="background-image:url('${diagram}')"></div>
          <div role="img" aria-label="Remote CSS diagram" style="background-image:url('https://example.invalid/remote-diagram.png')"></div>
          <div role="img" aria-label="Hidden CSS diagram" style="display:none;background-image:url('${diagram}')"></div>
          <div role="img" aria-label="Hidden annotated diagram" data-src="${diagram}" style="background-image:url('${diagram}');visibility:hidden"></div>
          <a href="https://example.invalid/image-page"><span role="img" aria-label="Article diagram" width="64" height="64" data-src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=="></span></a>
          <ol start="4"><li>Fourth step.</li><li value="7">Seventh step.</li></ol>
          <a id="ref" role="doc-noteref" aria-label="Read footnote 1" href="#reader-title">Read the note</a>
          <a href="https://example.com/article-with-notes#reader-title">Absolute reference</a>
          <aside id="reader-title" role="doc-footnote" aria-label="Footnote 1"><p>Editorial footnote.</p>
            <a role="doc-backlink" aria-label="Back to reference" href="#ref">Back</a>
          </aside>
          <section role="doc-endnotes" aria-labelledby="endnotes-title import-button"><h2 id="endnotes-title">More notes</h2>
            <ol><li role="doc-endnote">Additional note.</li></ol>
          </section>
          <div id="comments" class="comments-area"><article><p>Unwanted reader reply.</p></article></div>
          <section itemprop="comment"><p>Unwanted structured reply.</p></section>
          <aside aria-label="Feedback"><p>Unwanted invitation.</p></aside>
          <div class="prevnext"><p>Unwanted next article.</p></div>
        </div>
      </article></main>`;
    const upload = await page.request.post(new URL(`/api/links/${id}/assets?name=article.html`, base).href, {
      headers: { 'Content-Type': 'text/html' }, data: html,
    });
    assert.equal(upload.status(), 201);
    await page.goto(new URL('/?q=Reader+article+with+editorial+asides', base).href);
    await page.locator(`.bookmark-card[data-id="${id}"] .card-title button`).click();
    const article = page.locator('#reader-rich-article');
    await article.getByText('Editorial footnote.', { exact: true }).waitFor();
    const cssDiagram = article.getByRole('img', { name: 'Embedded CSS diagram' });
    assert.deepEqual(await cssDiagram.evaluate(async img => {
      await img.decode();
      return [img.currentSrc, img.naturalWidth, img.naturalHeight];
    }), [diagram, 96, 64]);
    assert.equal(await article.getByRole('img', { name: 'Remote CSS diagram' }).count(), 0);
    assert.equal(await article.locator('img[alt^="Hidden"]').count(), 0);
    const text = await article.innerText();
    assert.doesNotMatch(text, /Hidden CSS diagram|Hidden annotated diagram/);
    for (const exact of ['By Jules.', 'Lead paragraph outside the marked body.', 'Prose about comments in code.', 'Remote CSS diagram'])
      assert.ok(text.includes(exact));
    assert.doesNotMatch(text, /Unwanted|Earlier teaser|An unrelated article/);
    assert.equal(await article.locator('aside pre code').innerText(), '// comments stay');
    const steps = article.locator('ol').filter({ hasText: 'Fourth step.' });
    assert.equal(await steps.getAttribute('start'), '4');
    assert.equal(await steps.locator('li').last().getAttribute('value'), '7');
    const before = page.url();
    const ref = article.locator('[role="doc-noteref"]');
    assert.equal(await ref.getAttribute('aria-label'), 'Read footnote 1');
    await ref.press('Enter');
    const note = article.locator('[role="doc-footnote"]');
    assert.equal(await note.getAttribute('aria-label'), 'Footnote 1');
    assert.deepEqual(await note.evaluate(el => [el === document.activeElement, getComputedStyle(el).outlineStyle, getComputedStyle(el).outlineWidth]), [true, 'solid', '2px']);
    const back = note.locator('[role="doc-backlink"]');
    assert.equal(await back.getAttribute('aria-label'), 'Back to reference');
    await back.press('Enter');
    assert.equal(await ref.evaluate(el => el === document.activeElement), true);
    assert.equal(page.url(), before);
    assert.equal(await page.locator('#reader-title').count(), 1, 'saved IDs cannot shadow application controls');
    assert.equal(await article.getByRole('link', { name: 'Absolute reference' }).getAttribute('href'),
      await ref.getAttribute('href'));
    const endnotes = article.locator('[role="doc-endnotes"]');
    assert.equal(await endnotes.getAttribute('aria-labelledby'), await endnotes.locator('h2').getAttribute('id'));
    assert.equal(await endnotes.locator('[role="doc-endnote"]').innerText(), 'Additional note.');
    const image = article.getByRole('button', { name: 'Enlarge image: Article diagram' });
    assert.equal(await image.evaluate(el => el.closest('a') === null), true);
    const pages = page.context().pages().length;
    for (const activate of [() => image.press('Enter'), () => image.click()]) {
      await activate();
      const zoom = page.getByRole('dialog', { name: 'Article diagram' });
      await zoom.waitFor();
      await zoom.getByRole('button', { name: 'Close image' }).click();
      await zoom.waitFor({ state: 'detached' });
      assert.equal(page.context().pages().length, pages);
      assert.equal(page.url(), before);
    }
  } finally {
    await page.request.delete(new URL(`/api/links/${id}`, base).href);
    await page.goto(previous);
  }
}
