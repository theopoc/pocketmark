// Match container metadata, never prose or the text of a code sample.
const containers = new Set("article aside div section ol ul li".split(" "));
const commentMarker =
  /^(?:(?:wp-block|post|entry|article|blog)-)?comments?(?:-(?:area|body|container|form|list|section|thread|respond|replies|template|wrapper)|-\d+)?$/i;
const ancillaryMarker =
  /^(?:related(?:-(?:posts|articles|content|links))?|recommended(?:-(?:posts|articles))?|recommendations|prev-?next|pagination|(?:post|site)-navigation|site-menu|sidebar|social-share|share-buttons|commentaires|commentlist|commentform|respond|disqus-thread|giscus|utterances|replies)$/i;
const ancillaryLabel =
  /^(?:(?:reader |user )?comments?|commentaires|feedback|related (?:articles|posts)|share this (?:article|post))$/i;
const ancillaryRoles = new Set([
  "navigation",
  "banner",
  "contentinfo",
  "comment",
]);

const archivedStyles = new WeakMap();
const rawTextTags = new Set(
  "script style title textarea xmp iframe noembed noframes".split(" "),
);

// A browser checks inline styles against the application's CSP even while
// parsing a detached template. Rename only start-tag attributes in the input
// copy. The browser still parses the HTML and decodes attribute values itself.
export function archiveFragment(document, source, maxStyles) {
  const template = document.implementation
    .createHTMLDocument("")
    .createElement("template");
  if (!/style/i.test(source)) {
    template.innerHTML = source;
    return template.content;
  }
  // Each parse has its own spelling, independent of the publisher's attributes.
  const alias =
    "data-pocketmark-style-" +
    crypto.getRandomValues(new Uint32Array(4)).join("-");
  const tags = /<(!--|!\[CDATA\[|[!?]|\/?([a-z][^\t\n\f\r />]*))/gi;
  const attributes =
    /[\t\n\f\r /]+|>|(=?[^\t\n\f\r />=]+|=)(?:[\t\n\f\r ]*=[\t\n\f\r ]*(?:"[^"]*(?:"|$)|'[^']*(?:'|$)|[^\t\n\f\r >]*))?/gy;
  const pieces = [];
  const namespaceRoots = [];
  let copied = 0;
  for (let tag; (tag = tags.exec(source));) {
    if (!tag[2]) {
      let ending = />/g;
      if (
        tag[1] === "!--" &&
        !/^-?>/.test(source.slice(tags.lastIndex, tags.lastIndex + 2))
      )
        ending = /--!?>/g;
      if (tag[1] === "![CDATA[") ending = /\]\]>/g;
      ending.lastIndex = tags.lastIndex;
      if (!ending.exec(source)) break;
      tags.lastIndex = ending.lastIndex;
      continue;
    }
    const closing = tag[1][0] === "/";
    attributes.lastIndex = tags.lastIndex;
    let attribute;
    let selfClosing = false;
    while ((attribute = attributes.exec(source))) {
      if (attribute[0] === ">") break;
      selfClosing = !attribute[1] && attribute[0].endsWith("/");
      if (!closing && attribute[1]?.toLowerCase() === "style") {
        if (pieces.length >= 2 * maxStyles)
          throw new RangeError("Article exceeds reading budget");
        pieces.push(source.slice(copied, attribute.index), alias);
        copied = attribute.index + attribute[1].length;
      }
    }
    if (!attribute) break;
    tags.lastIndex = attributes.lastIndex;
    const name = tag[2].toLowerCase();
    const parent = namespaceRoots.at(-1);
    if (closing) {
      if (parent === name) namespaceRoots.pop();
      continue;
    }
    const foreignRoot = name === "svg" || name === "math";
    const foreign = parent === "svg" || parent === "math";
    // A slash closes a foreign element, including an empty SVG title. HTML
    // ignores it on ordinary title/script elements, including in foreignObject.
    if (selfClosing && (foreignRoot || foreign)) continue;
    if (
      foreignRoot ||
      (parent === "svg" && /^(?:foreignobject|desc|title)$/.test(name)) ||
      (parent === "math" && /^(?:mi|mo|mn|ms|mtext)$/.test(name))
    )
      namespaceRoots.push(name);
    if (name === "plaintext") break;
    if (rawTextTags.has(name)) {
      const end = new RegExp("</" + name + "(?=[\\t\\n\\f\\r />])", "gi");
      end.lastIndex = tags.lastIndex;
      const close = end.exec(source);
      if (!close) break;
      tags.lastIndex = close.index;
    }
  }
  pieces.push(source.slice(copied));
  template.innerHTML = pieces.join("");
  for (const node of template.content.querySelectorAll("[" + alias + "]")) {
    const raw = node.getAttribute(alias);
    archivedStyles.set(node, raw);
    node.removeAttribute(alias);
    // SVG is serialized as a passive image. Keep its presentation inside that
    // image using the CSSOM on its detached nodes, never on application nodes.
    if (node.style && node.closest("svg")) node.style.cssText = raw;
  }
  return template.content;
}

export function capturedStyle(node, maxLength = 8192) {
  const raw = archivedStyles.get(node);
  if (!raw || raw.length > maxLength) return null;
  const style = node.ownerDocument.createElement("span").style;
  style.cssText = raw;
  return style;
}

export function skipReaderElement(node) {
  if (
    node.hidden ||
    node.getAttribute("aria-hidden") === "true" ||
    node.classList.contains("print-only") ||
    capturedStyle(node)?.display === "none"
  )
    return true;
  if (ancillaryRoles.has(node.getAttribute("role"))) return true;
  if (!containers.has(node.localName) && !node.localName.includes("-"))
    return false;
  if (
    node.matches('[itemprop~="comment"]') ||
    /(?:^|\/)(?:Comment|UserComments)\/?$/i.test(
      node.getAttribute("itemtype") || "",
    ) ||
    ancillaryLabel.test(node.getAttribute("aria-label")?.trim() || "")
  )
    return true;
  if (
    node.matches(
      '[role=doc-footnote], [role=doc-endnote], [role=doc-endnotes], [itemprop~="articleBody"]',
    )
  )
    return false;
  const names = [node.localName, node.id, ...node.classList];
  return names.some((name) => {
    const token = name.replaceAll("_", "-");
    return (
      commentMarker.test(token) ||
      ancillaryMarker.test(token) ||
      /(?:^|-)topic-cards$/i.test(token)
    );
  });
}

const mainSelector = "main, [role=main]";
const articleSelector = 'article, [role="article"], .h-entry, .hentry';
const bodySelector =
  '[itemprop~="articleBody"], .entry-content, .post-content, .article-body, .story-body';
const candidateSelector = [
  mainSelector,
  articleSelector,
  bodySelector,
  "h1",
  "p",
].join(",");
const normalizedTitle = (value) =>
  (value || "").trim().replace(/\s+/g, " ").toLowerCase();

export function readerTitleMatches(heading, title) {
  const text = normalizedTitle(heading);
  const saved = normalizedTitle(title);
  return Boolean(
    text &&
    (saved === text ||
      [" - ", " – ", " — ", " | "].some((sep) => saved.startsWith(text + sep))),
  );
}

// Rank only visible semantic roots. Count paragraphs as a tie-breaker so a
// short teaser doesn't displace a full article when the bookmark was renamed.
export function readerBodyRoot(content, title, excluded) {
  const candidates = new Map();
  const walker = content.ownerDocument.createTreeWalker(
    content,
    NodeFilter.SHOW_ELEMENT,
    {
      acceptNode(node) {
        if (
          excluded.has(node.localName) ||
          skipReaderElement(node) ||
          node.matches("pre, svg")
        )
          return NodeFilter.FILTER_REJECT;
        return node.matches(candidateSelector)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP;
      },
    },
  );
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const main = node.closest(mainSelector);
    const article = node.closest(articleSelector);
    const root = article || main || node.closest(bodySelector);
    if (!root) continue;
    const candidate = candidates.get(root) || { rank: 0, paragraphs: 0 };
    let rank = article ? 2 : 1;
    if (node.matches(bodySelector)) rank = 4;
    if (node.localName === "h1")
      rank = readerTitleMatches(node.textContent, title) ? 5 : 3;
    // A main landmark outranks every hint found in a page's periphery.
    candidate.rank = Math.max(candidate.rank, rank + (main ? 5 : 0));
    if (node.localName === "p") candidate.paragraphs++;
    candidates.set(root, candidate);
  }
  let root = content,
    best = { rank: 0, paragraphs: 0 };
  for (const [node, candidate] of candidates) {
    if (
      candidate.rank > best.rank ||
      (candidate.rank === best.rank && candidate.paragraphs > best.paragraphs)
    ) {
      root = node;
      best = candidate;
    }
  }
  return root;
}
