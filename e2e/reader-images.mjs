import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Two independently addressed images are visible to the source page. Only
// one publisher opts into anonymous CORS reads by the HTML capture.
export async function readerImageCapture(browser) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const png = await readFile(new URL('../extension/icon-16.png', import.meta.url));
    const corsReads = [];
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') return route.fulfill({contentType:'text/html', body:
        '<meta charset="windows-1252"><main><img alt="Chart" src="https://media.example.test/chart.png"><img alt="Photo" src="https://media.example.test/photo.png">' +
        '<div role="img" aria-label="Legend" style="height:1rem;background-image:url(/legend.png)"> <!-- legend --> </div></main>'});
      const allowed = url.pathname === '/chart.png';
      // Playwright supplies an allowing CORS header when a mocked response
      // omits it. Set an unrelated origin to exercise an actual denial.
      const headers = {'Access-Control-Allow-Origin':allowed ? '*' : 'https://other.example.test'};
      if (route.request().resourceType() === 'fetch') {
        corsReads.push(url.pathname);
        if (allowed) await page.evaluate(() => {
          // The source can change while the extension waits for the CDN.
          document.querySelector('main').prepend(new Image(), document.createElement('div'));
          document.querySelector('main div').setAttribute('role', 'img');
        });
      }
      return route.fulfill({contentType:'image/png', headers, body:png});
    });
    await page.goto('https://article.example.test/');
    await page.evaluate(() => Promise.all([...document.images].map(img => img.decode())));
    await page.addScriptTag({content:await readFile(new URL('../extension/capture.js', import.meta.url), 'utf8')});
    const {images, legend, charsets} = await page.evaluate(async () => {
      const {html} = await snapshotPage();
      const template = document.createElement('template');
      template.innerHTML = html;
      return {images:[...template.content.querySelectorAll('img')].map(img => img.getAttribute('src')),
        charsets:[...template.content.querySelectorAll('meta[charset]')].map(meta => meta.getAttribute('charset')),
        legend:template.content.querySelector('[aria-label="Legend"]').getAttribute('data-src')};
    });
    assert.deepEqual(corsReads.sort(), ['/chart.png', '/legend.png', '/photo.png']);
    assert.equal(images[0], 'data:image/png;base64,' + png.toString('base64'));
    assert.equal(images[1], null);
    assert.equal(legend, images[0]);
    assert.deepEqual(charsets, ['utf-8']);
  } finally {
    await context.close();
  }
}
