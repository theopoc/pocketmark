import assert from "node:assert/strict";
import test from "node:test";
import { archiveFragment } from "../src/features/reader-body.js";
import {
  loadReaderArticle,
  readArticleSource,
} from "../src/features/reader-article.js";

const link = { id: 8, archiveAvailable: true };
const maxBytes = 20 * 1024 * 1024;

test("style capture only rewrites attribute names and stops at the structural limit", () => {
  const template = { content: { querySelectorAll: () => [] } };
  const document = {
    implementation: {
      createHTMLDocument: () => ({ createElement: () => template }),
    },
  };
  const literal = '<span style="literal">example</span>';
  const source =
    `<!-- ${literal} --><title/>${literal}</title><script>${literal}</script>` +
    `<svg><foreignObject><title/>${literal}</title></foreignObject><title/></svg>` +
    `<pre title='${literal}'><span StYlE=display:block>` +
    `&lt;tag style="literal"&gt;</span><span/style='display:block'>tail`;
  archiveFragment(document, source, 2);
  const alias = template.innerHTML.match(/data-pocketmark-style-[\d-]+/)[0];
  assert.equal(
    template.innerHTML,
    source.replace("StYlE=", alias + "=").replace("/style=", "/" + alias + "="),
  );
  assert.throws(() => archiveFragment(document, source, 1), RangeError);
});

test("article decoding respects BOMs and legacy charset declarations across stream chunks", async () => {
  const text = "<p>Café €</p>";
  for (const [prolog, bytes] of [
    ['<meta charset="windows-1252">', Buffer.from([67, 97, 102, 233, 32, 128])],
    [
      "<!-- <meta charset=utf-8> --><meta content='text/html; charset=windows-1252' http-equiv=Content-Type>",
      Buffer.from([67, 97, 102, 233, 32, 128]),
    ],
    ['\ufeff<meta charset="windows-1252">', Buffer.from("Café €")],
    ["", Buffer.from("Café €")],
  ]) {
    for (const padding of ["", " ".repeat(1100)]) {
      const source = Buffer.concat([
        Buffer.from(prolog + padding + "<p>"),
        bytes,
        Buffer.from("</p>"),
      ]);
      const stream = new ReadableStream({
        start(controller) {
          for (let i = 0; i < source.length; i += 5)
            controller.enqueue(source.subarray(i, i + 5));
          controller.close();
        },
      });
      const result = await readArticleSource(
        new Response(stream),
        new AbortController().signal,
      );
      assert.equal(result, prolog.replace(/^\ufeff/, "") + padding + text);
    }
  }
});

test("article prefers the newest HTML attachment and otherwise reads the basic capture", async () => {
  const paths = [];
  const controller = new AbortController();
  const context = {
    signal: controller.signal,
    browser: {
      fetch: async (path, { credentials, signal }) => {
        assert.equal(credentials, "same-origin");
        assert.equal(signal, controller.signal);
        paths.push(path);
        return new Response(null, { status: 404 });
      },
    },
  };
  const assets = [
    { id: 3, mediaType: "text/html" },
    { id: 7, mediaType: "image/png" },
    { id: 4, mediaType: "text/html" },
  ];
  assert.equal(await loadReaderArticle(link, assets, context), null);
  assert.equal(await loadReaderArticle(link, [], context), null);
  assert.equal(await loadReaderArticle({ id: 1 }, [], context), null);
  assert.equal(
    await loadReaderArticle(
      link,
      [{ id: 9, mediaType: "text/html", size: maxBytes + 1 }],
      context,
    ),
    null,
  );
  assert.deepEqual(paths, [
    "/api/assets/4",
    "/api/links/8/archive?view=article",
  ]);
});

test("oversized HTML streams cancel before parsing, including when their announced length is small", async () => {
  for (const announced of [0, maxBytes + 1]) {
    let cancelled = false,
      parsed = false;
    const stream = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(256 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const browser = {
      fetch: async () =>
        new Response(stream, {
          headers: { "Content-Length": String(announced) },
        }),
      get document() {
        parsed = true;
        return null;
      },
    };
    assert.equal(
      await loadReaderArticle(link, [], {
        browser,
        signal: new AbortController().signal,
      }),
      null,
    );
    assert.equal(parsed, false);
    assert.equal(cancelled, true);
  }
});

test("cancellation skips stale content but preserves authentication failure", async () => {
  for (const status of [200, 401]) {
    const controller = new AbortController();
    const browser = {
      fetch: async () => {
        controller.abort();
        return { status, ok: status === 200 };
      },
    };
    const load = loadReaderArticle(link, [], {
      browser,
      signal: controller.signal,
    });
    if (status === 401) await assert.rejects(load, { status: 401 });
    else assert.equal(await load, null);
  }
});

test("preflight counts empty formatting elements once and bounds structural input before parsing", async () => {
  for (const [markup, canParse] of [
    ["<p>small</p>".repeat(10000), false],
    ["<span></span>".repeat(16001), false],
    ["<b></b><i></i>".repeat(4500), true],
  ]) {
    let parsed = false;
    const browser = {
      fetch: async () => new Response(markup),
      get document() {
        parsed = true;
        return null;
      },
    };
    await loadReaderArticle(link, [], {
      browser,
      signal: new AbortController().signal,
    });
    assert.equal(parsed, canParse);
  }
});
