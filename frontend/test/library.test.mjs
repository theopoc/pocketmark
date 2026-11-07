import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

let server, BookmarkCard;
before(async () => {
  server = await createServer({
    server: { middlewareMode: true },
    appType: "custom",
  });
  ({ BookmarkCard } = await server.ssrLoadModule(
    "/src/features/library/bookmarks.jsx",
  ));
});
after(async () => {
  await server?.close();
});

const link = {
  id: 7,
  title: "<img src=x onerror=alert(1)>",
  url: "https://example.com/a",
  description: "A saved page",
  tags: ["reference"],
  status: "ready",
  favorite: true,
};
function render(changes = {}, view = "list") {
  return renderToStaticMarkup(
    createElement(BookmarkCard, {
      link: { ...link, ...changes },
      model: {
        view,
        query: "query",
        expandedTags: new Set(),
        ...changes.model,
      },
    }),
  );
}

test("React bookmark content remains literal and unsafe destinations stay absent", () => {
  const html = render({
    url: "javascript:alert(1)",
    searchSnippet: "<script>bad</script>\x1ematch\x1f",
  });
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;img"));
  assert.ok(html.includes("<mark>match</mark>"));
});

test("both layouts preserve action names, identity and selected favorite state", () => {
  for (const view of ["list", "grid"]) {
    const html = render({}, view);
    assert.ok(html.includes('data-id="7"'));
    assert.ok(html.includes('data-focus-key="link:7:open"'));
    assert.ok(html.includes('aria-pressed="true"'));
    for (const label of [
      "Mark as read",
      "Edit bookmark",
      "Delete bookmark",
      "Visit original",
    ])
      assert.ok(html.includes(label));
  }
});

test("standalone files retain their label and have no original-site link", () => {
  const html = render({ type: "file", url: "pocketmark-file:123" });
  assert.ok(html.includes("Saved file"));
  assert.ok(!html.includes("Visit original"));
});
