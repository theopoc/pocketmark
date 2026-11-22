// Build the reading view from fresh application nodes. The original bytes remain
// available through the isolated attachment viewer.
import {
  archiveFragment,
  capturedStyle,
  readerBodyRoot,
  readerTitleMatches,
  skipReaderElement,
} from "./reader-body.js";

const maxBytes = 20 * 1024 * 1024;
const maxNodes = 16000;
const maxText = 1024 * 1024;
const allowedTags = new Set(
  "p div section aside h1 h2 h3 h4 h5 h6 ul ol li dl dt dd blockquote figure figcaption strong em b i sub sup s del mark kbd code br hr table thead tbody tfoot tr th td caption a".split(
    " ",
  ),
);
const excluded = new Set(
  "head title base link meta script style template noscript frame iframe object embed form button select input textarea nav footer canvas video audio".split(
    " ",
  ),
);
const imageData = /^data:image\/(png|jpe?g|webp|gif|avif|svg\+xml)[;,]/i;

function documentDecoder(prefix) {
  if (prefix[0] === 0xff && prefix[1] === 0xfe)
    return new TextDecoder("utf-16le");
  if (prefix[0] === 0xfe && prefix[1] === 0xff)
    return new TextDecoder("utf-16be");
  if (prefix[0] === 0xef && prefix[1] === 0xbb && prefix[2] === 0xbf)
    return new TextDecoder();
  const prolog = new TextDecoder()
    .decode(prefix)
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  for (const [meta] of prolog.matchAll(
    /<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi,
  )) {
    const attrs = new Map();
    for (const [, name, double, single, plain] of meta.matchAll(
      /\s+([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s/>]+))/g,
    )) {
      attrs.set(name.toLowerCase(), double ?? single ?? plain);
    }
    const label =
      attrs.get("charset") ||
      (attrs.get("http-equiv")?.toLowerCase() === "content-type" &&
        attrs.get("content")?.match(/charset\s*=\s*["']?([\w.-]+)/i)?.[1]);
    if (!label) continue;
    try {
      const decoder = new TextDecoder(label);
      // Only a BOM can select UTF-16 in an ASCII-compatible HTML declaration.
      return decoder.encoding.startsWith("utf-16")
        ? new TextDecoder()
        : decoder;
    } catch {
      /* Ignore unsupported encoding declarations. */
    }
  }
  return new TextDecoder();
}

export async function readArticleSource(response, signal) {
  if (!response.body) return null;
  const reader = response.body.getReader();
  let bytes = 0;
  let decoder;
  const prefix = new Uint8Array(1024);
  let prefixLength = 0;
  const pieces = [];
  try {
    if (Number(response.headers.get("Content-Length")) <= maxBytes) {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) {
          if (!decoder) {
            const head = prefix.subarray(0, prefixLength);
            return documentDecoder(head).decode(head);
          }
          pieces.push(decoder.decode());
          return pieces.join("");
        }
        bytes += value.byteLength;
        if (bytes > maxBytes) break;
        let offset = 0;
        if (!decoder) {
          offset = Math.min(prefix.length - prefixLength, value.length);
          prefix.set(value.subarray(0, offset), prefixLength);
          prefixLength += offset;
          if (prefixLength < prefix.length) continue;
          decoder = documentDecoder(prefix);
          pieces.push(decoder.decode(prefix, { stream: true }));
        }
        pieces.push(decoder.decode(value.subarray(offset), { stream: true }));
      }
    }
    await reader.cancel();
    return null;
  } finally {
    reader.releaseLock();
  }
}

function canParse(source) {
  // Encoded images may legitimately be many MiB. Bound structural input before
  // asking the HTML parser to allocate elements and attribute lists.
  let tags = 0,
    tokens = 0;
  const structural =
    /data:[\w.+/;-]{1,128};base64,[a-z\d+/=]+|<(span|b|i|em|strong)><\/\1>|[</=]|[\t\n\f\r ]+/gi;
  for (const match of source.matchAll(structural)) {
    if (match[0][0] === "<" && ++tags > maxNodes) return false;
    // An empty formatting pair allocates one element. Its two '<' and one '/'
    // still count towards the lexical budget. Never rewrite the source bytes.
    tokens += match[1] ? 3 : 1;
    if (tokens > 180000) return false;
  }
  return true;
}

function textButton(document, text, label = text) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  button.setAttribute("aria-label", label);
  button.title = label;
  return button;
}

function enlargeImage(image, caption, signal) {
  const document = image.ownerDocument;
  const reader = image.closest("dialog");
  if (!reader?.open || signal.aborted) return;
  const dialog = document.createElement("dialog");
  dialog.className = "reader-image-dialog";
  dialog.setAttribute("aria-label", image.alt || "Article image");
  const header = document.createElement("header");
  const title = document.createElement("span");
  title.textContent = caption || image.alt;
  const zoom = textButton(document, "Zoom in");
  const close = textButton(document, "Close", "Close image");
  const stage = document.createElement("div");
  stage.className = "reader-image-stage";
  const large = image.cloneNode();
  large.loading = "eager";
  stage.append(large);
  header.append(title, zoom, close);
  dialog.append(header, stage);
  reader.append(dialog);
  zoom.addEventListener("click", () => {
    const enlarged = stage.classList.toggle("zoomed");
    const label = enlarged ? "Fit image" : "Zoom in";
    zoom.textContent = zoom.title = label;
    zoom.setAttribute("aria-label", label);
  });
  const dismiss = () => dialog.close();
  close.addEventListener("click", dismiss);
  signal.addEventListener("abort", dismiss, { once: true });
  dialog.addEventListener(
    "close",
    () => {
      signal.removeEventListener("abort", dismiss);
      dialog.remove();
    },
    { once: true },
  );
  dialog.showModal();
  close.focus({ preventScroll: true });
}

function articleImage(source, { browser, signal }) {
  const document = browser.document;
  // Embedded backgrounds can exceed the general layout-hint limit. Read the
  // whole declaration once so a hidden figure cannot expose its pixels or alt.
  const style = capturedStyle(source, maxBytes);
  if (style?.display === "none" || style?.visibility === "hidden") return "";
  const alt =
    source.getAttribute("alt") ||
    source.getAttribute("aria-label") ||
    (source.localName === "svg" &&
      source.querySelector("title")?.textContent) ||
    "";
  const description = alt.slice(0, 1000);
  let src;
  if (source.localName === "svg") {
    const svg = new browser.XMLSerializer().serializeToString(source);
    if (svg.length <= maxText)
      src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  } else {
    src = ["src", "data-src", "data-original"]
      .map((name) => source.getAttribute(name))
      .find((value) => value && imageData.test(value));
    if (!src && source.getAttribute("role") === "img") {
      const background =
        style?.backgroundImage.match(/^url\("([^"]+)"\)$/)?.[1];
      if (background && imageData.test(background)) src = background;
    }
    // A saved picture can embed its only usable image in a source candidate.
    for (
      let candidate = source;
      !src && candidate;
      candidate = candidate.previousElementSibling
    ) {
      if (candidate !== source && candidate.localName !== "source") break;
      const set =
        candidate.getAttribute("srcset") ||
        candidate.getAttribute("data-srcset");
      const embedded = set?.match(/(?:^|[\s,])(data:image\/[^\s]+)/i)?.[1];
      if (embedded && imageData.test(embedded))
        src = embedded.endsWith(",") ? embedded.slice(0, -1) : embedded;
      if (source.parentElement?.localName !== "picture") break;
    }
  }
  if (!src) return document.createTextNode(description);
  const image = document.createElement("img");
  image.alt = description;
  image.decoding = "async";
  image.loading = "lazy";
  // SVG is exclusively an image resource, never inline SVG or a navigable document.
  image.src = src;
  for (const attr of ["width", "height"]) {
    const size = Number(source.getAttribute(attr));
    if (Number.isInteger(size) && size > 0 && size <= 16384)
      image.setAttribute(attr, String(size));
  }
  const action = textButton(
    document,
    "",
    description ? "Enlarge image: " + description : "Enlarge image",
  );
  action.className = "reader-article-image";
  action.append(image);
  const caption = source
    .closest("figure")
    ?.querySelector("figcaption")
    ?.textContent.slice(0, 1000);
  action.addEventListener("click", () => enlargeImage(image, caption, signal));
  image.addEventListener(
    "error",
    () => action.replaceWith(document.createTextNode(description)),
    { once: true },
  );
  return action;
}

function formatCode(code, text, language, context) {
  code.textContent = text;
  if (language !== "JSON" || text.length > 16384) return;
  // Preserve every character, including whitespace. Only strings need a token.
  const tokens = code.ownerDocument.createDocumentFragment();
  let offset = 0;
  for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"(?:\s*:)?/g)) {
    if (!context.colorTokens) return;
    context.colorTokens--;
    const span = code.ownerDocument.createElement("span");
    span.className = match[0].endsWith(":")
      ? "reader-code-key"
      : "reader-code-string";
    span.textContent = match[0];
    tokens.append(text.slice(offset, match.index), span);
    offset = match.index + match[0].length;
  }
  tokens.append(text.slice(offset));
  code.replaceChildren(tokens);
}

function codeLanguage(source) {
  // Markdown renderers can label the code, the pre, or its highlight wrapper.
  const wrapper = source.parentElement;
  for (const node of [
    source.querySelector("code"),
    source,
    wrapper?.matches("div,figure") && wrapper,
    wrapper?.parentElement?.matches("div,figure") && wrapper.parentElement,
  ]) {
    if (!node) continue;
    const explicit =
      node.getAttribute("data-language") ||
      node.getAttribute("data-lang") ||
      "";
    if (/^[a-z0-9+#-]{1,24}$/i.test(explicit)) return explicit.toUpperCase();
    const hint = node
      .getAttribute("class")
      ?.match(
        /(?:^|\s)(?:lang(?:uage)?|highlight-(?:source|text))-([a-z0-9+#-]{1,24})(?=\s|$)/i,
      );
    if (hint) return hint[1].toUpperCase();
  }
  return "CODE";
}

function codeBlock(source, text, context) {
  const { browser, signal } = context;
  const document = browser.document;
  const language = codeLanguage(source);
  const section = document.createElement("div");
  section.className = "reader-article-code";
  const header = document.createElement("div");
  const name = document.createElement("span");
  name.textContent = language;
  const pre = document.createElement("pre");
  pre.tabIndex = 0;
  const code = document.createElement("code");
  formatCode(code, text, language, context);
  pre.append(code);
  const wrap = textButton(document, "Wrap", "Wrap lines");
  function setWrap(on) {
    wrap.setAttribute("aria-pressed", String(on));
    pre.classList.toggle("wrap-lines", on);
  }
  setWrap(browser.matchMedia("(max-width: 680px)").matches);
  wrap.addEventListener("click", () =>
    setWrap(!pre.classList.contains("wrap-lines")),
  );
  const copy = textButton(document, "Copy", "Copy code");
  const status = document.createElement("span");
  status.setAttribute("role", "status");
  copy.addEventListener("click", async () => {
    try {
      await browser.navigator.clipboard.writeText(text);
      if (!signal.aborted) status.textContent = "Copied";
    } catch {
      if (signal.aborted) return;
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = browser.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      status.textContent = "Code selected";
    }
  });
  copy.addEventListener("blur", () => {
    status.textContent = "";
  });
  header.append(name, wrap, status, copy);
  section.append(header, pre);
  return section;
}

function safeLink(raw, base) {
  if (!raw) return null;
  if (raw.startsWith("#")) return raw;
  try {
    const url = new URL(raw, base || undefined);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (url.hash && base) {
      const original = new URL(base);
      original.hash = url.hash;
      if (url.href === original.href) return url.hash;
    }
    return url.href;
  } catch {
    return null;
  }
}

function projectArticle(source, link, context) {
  const { document } = context.browser;
  // In a detached template even images/frames are inert. No captured node or
  // arbitrary attribute is ever adopted into the live, same-origin document.
  const root = readerBodyRoot(
    archiveFragment(document, source, maxNodes),
    link.title,
    excluded,
  );
  const destinations = new Map();
  const references = [];
  const notes = [];
  const firstHeading = root.querySelector("h1");
  let visited = 0,
    textSize = 0;
  function countText(length) {
    textSize += length;
    if (textSize > maxText)
      throw new RangeError("Article exceeds reading budget");
  }
  function project(node, depth) {
    if (++visited > maxNodes || depth > 96)
      throw new RangeError("Article exceeds reading budget");
    if (node.nodeType === 3) {
      countText(node.length);
      return document.createTextNode(node.data);
    }
    if (node.nodeType !== 1 || skipReaderElement(node)) return "";
    const tag = node.localName;
    if (excluded.has(tag)) return "";
    if (
      tag === "img" ||
      tag === "svg" ||
      (node.getAttribute("role") === "img" &&
        !node.childElementCount &&
        !node.textContent.trim())
    ) {
      visited += 3;
      return articleImage(node, context);
    }
    const codeLines = tag === "table" ? listingCells(node) : null;
    if (tag === "pre" || codeLines) {
      visited += 9;
      const text = codeText(codeLines || [node], countText);
      return codeBlock(node, text, context);
    }
    if (
      node === firstHeading &&
      readerTitleMatches(node.textContent, link.title)
    )
      return "";
    const role = node.getAttribute("role");
    const note =
      ["doc-footnote", "doc-endnote", "doc-endnotes"].includes(role) &&
      node.matches("aside, section, div, p, li, ol, ul, span");
    const block = allowedTags.has(tag)
      ? document.createElement(tag === "h1" ? "h2" : tag)
      : note || (node.id && node.id.length <= 256)
        ? document.createElement("span")
        : document.createDocumentFragment();
    if (node.id && node.id.length <= 256 && !destinations.has(node.id))
      destinations.set(node.id, block);
    if (tag === "ol" && node.hasAttribute("reversed")) block.reversed = true;
    if (tag === "ol" || tag === "li") {
      const key = tag === "ol" ? "start" : "value";
      const value = node.getAttribute(key);
      if (value && /^-?\d{1,9}$/.test(value)) block.setAttribute(key, value);
    }
    if (tag === "td" || tag === "th") {
      for (const key of ["colspan", "rowspan"]) {
        const span = Number(node.getAttribute(key));
        if (Number.isInteger(span) && span > 1 && span <= 32)
          block.setAttribute(key, String(span));
      }
    }
    for (const child of node.childNodes)
      block.append(project(child, depth + 1));
    if (tag === "a") {
      // Projected images and listings have their own actions. Never put those
      // controls inside a link, including media created from a role=img node.
      if (block.querySelector("button")) {
        const group = document.createElement("span");
        group.append(...block.childNodes);
        if (destinations.get(node.id) === block)
          destinations.set(node.id, group);
        return group;
      }
      const href = safeLink(node.getAttribute("href"), link.url);
      if (href && !node.querySelector("img,svg,pre")) {
        if (href.startsWith("#")) {
          if (href.length <= 768) references.push([block, href.slice(1)]);
        } else {
          block.href = href;
          block.target = "_blank";
          block.rel = "noopener noreferrer";
        }
      }
    }
    if (note || (tag === "a" && ["doc-noteref", "doc-backlink"].includes(role)))
      notes.push([node, block, role]);
    if (tag === "table") {
      const container = document.createElement("div");
      container.className = "reader-article-table";
      container.tabIndex = 0;
      container.append(block);
      return container;
    }
    return block;
  }
  const result = document.createDocumentFragment();
  for (const node of root.childNodes) result.append(project(node, 0));
  // Resolve against projected nodes only, including forward references. Source
  // IDs must never identify a control or navigation target in the application.
  let referenceID = 0;
  function localID(target) {
    if (!target.id) target.id = "reader-reference-" + ++referenceID;
    return target.id;
  }
  for (const [anchor, fragment] of references) {
    let id;
    try {
      id = decodeURIComponent(fragment);
    } catch {
      continue;
    }
    const target = destinations.get(id);
    if (!target) continue;
    anchor.href = "#" + localID(target);
    anchor.addEventListener("click", (event) => {
      event.preventDefault();
      target.tabIndex = -1;
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: "nearest" });
    });
  }
  for (const [source, block, role] of notes) {
    if (block.localName === "a" && !block.hasAttribute("href")) continue;
    block.setAttribute("role", role);
    const label = source.getAttribute("aria-label")?.trim().slice(0, 1000);
    if (label) block.setAttribute("aria-label", label);
    const labelledBy = source.getAttribute("aria-labelledby");
    if (labelledBy && labelledBy.length <= 1000) {
      const ids = labelledBy
        .trim()
        .split(/\s+/)
        .map((id) => destinations.get(id))
        .filter(Boolean)
        .map(localID);
      if (ids.length) block.setAttribute("aria-labelledby", ids.join(" "));
    }
  }
  return result.textContent.trim() || result.querySelector("img")
    ? result
    : null;
}

// Some highlighters use one table row per code line with a presentation-only
// gutter. Require that shape in every row so ordinary data tables stay intact.
function listingCells(table) {
  if (table.caption || table.tHead || table.tFoot || table.rows.length < 2)
    return null;
  const lines = [];
  for (const row of table.rows) {
    const [gutter, cell] = row.cells;
    if (
      row.cells.length !== 2 ||
      !gutter.matches(
        '[aria-hidden="true"], [hidden], [data-line-number], .gutter, .linenos, .blob-num',
      ) ||
      !/^\d*$/.test(gutter.textContent.trim()) ||
      cell.localName !== "td"
    )
      return null;
    if (cell.classList.contains("blob-code")) {
      lines.push(cell);
    } else {
      const code = cell.firstElementChild;
      if (
        !code?.matches("code, pre") ||
        [...cell.childNodes].some(
          (child) =>
            child !== code && (child.nodeType !== 3 || child.data.trim()),
        )
      )
        return null;
      lines.push(code);
    }
  }
  return lines;
}

function codeText(lines, countText) {
  const parts = [];
  let boundary = false;
  function add(text) {
    if (!text) return;
    if (
      boundary &&
      parts.length &&
      !parts.at(-1).endsWith("\n") &&
      !text.startsWith("\n")
    ) {
      countText(1);
      parts.push("\n");
    }
    boundary = false;
    countText(text.length);
    parts.push(text);
  }
  function read(node, depth) {
    if (depth > 96) throw new RangeError("Article exceeds reading budget");
    if (node.nodeType === 3) return add(node.data);
    if (node.nodeType !== 1) return;
    const style = capturedStyle(node);
    const display = style?.display;
    const capturedLayout = node.getAttribute("data-pocketmark-code-layout");
    if (
      node.hidden ||
      node.getAttribute("aria-hidden") === "true" ||
      capturedLayout === "hidden" ||
      display === "none" ||
      style?.visibility === "hidden" ||
      node.matches(
        "script,style,template,noscript,button,input,.linenos,.line-numbers-rows",
      )
    )
      return;
    if (node.localName === "br") return add("\n");
    const line =
      capturedLayout === "block" ||
      display === "block" ||
      (!display &&
        (node.localName === "div" ||
          node.matches("span.line,span.code-line,span.token-line")));
    if (line) boundary = true;
    for (const child of node.childNodes) read(child, depth + 1);
    if (line) boundary = true;
  }
  for (const [i, line] of lines.entries()) {
    if (i) add("\n");
    read(line, 0);
  }
  return parts.join("");
}

export async function loadReaderArticle(link, assets, { browser, signal }) {
  if (signal.aborted || !Number.isSafeInteger(link.id)) return null;
  const newest = assets
    .filter(
      (asset) =>
        asset.mediaType === "text/html" && Number.isSafeInteger(asset.id),
    )
    .sort((a, b) => b.id - a.id)[0];
  if ((!newest && !link.archiveAvailable) || newest?.size > maxBytes)
    return null;
  const path = newest
    ? `/api/assets/${newest.id}`
    : `/api/links/${link.id}/archive?view=article`;
  let response;
  try {
    response = await browser.fetch(path, {
      signal,
      credentials: "same-origin",
      redirect: "error",
    });
  } catch {
    return null;
  }
  if (response.status === 401)
    throw Object.assign(new Error("Session expired"), { status: 401 });
  if (signal.aborted || !response.ok) return null;
  try {
    const source = await readArticleSource(response, signal);
    return source && !signal.aborted && canParse(source)
      ? projectArticle(source, link, { browser, signal, colorTokens: 2048 })
      : null;
  } catch {
    // Aborted streams, malformed input and oversized articles keep the indexed text available.
    return null;
  }
}
