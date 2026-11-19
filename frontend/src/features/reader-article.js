// Build the reading view from fresh application nodes. The original bytes remain
// available through the isolated attachment viewer.
const maxBytes = 20 * 1024 * 1024;
const maxNodes = 16000;
const maxText = 1024 * 1024;
const allowedTags = new Set(
  "p div section h1 h2 h3 h4 h5 h6 ul ol li dl dt dd blockquote figure figcaption strong em b i sub sup s del mark kbd code br hr table thead tbody tfoot tr th td caption a".split(
    " ",
  ),
);
const excluded = new Set(
  "head title base link meta script style template noscript frame iframe object embed form button select input textarea nav aside footer canvas video audio".split(
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
    /data:[\w.+/;-]{1,128};base64,[a-z\d+/=]+|[</=]|[\t\n\f\r ]+/gi;
  for (const match of source.matchAll(structural)) {
    if (match[0] === "<" && ++tags > maxNodes) return false;
    if (++tokens > 180000) return false;
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

function codeBlock(source, text, context) {
  const { browser, signal } = context;
  const document = browser.document;
  const sourceCode = source.querySelector("code");
  const hint =
    sourceCode?.getAttribute("class") || source.getAttribute("class") || "";
  const language = (
    hint.match(/(?:lang(?:uage)?)-([a-z0-9+#-]{1,24})/i)?.[1] || "Code"
  ).toUpperCase();
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
  if (!raw || raw.startsWith("#")) return null;
  try {
    const url = new URL(raw, base || undefined);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function projectArticle(source, link, context) {
  const { document } = context.browser;
  // In a detached template even images/frames are inert. No captured node or
  // arbitrary attribute is ever adopted into the live, same-origin document.
  const template = document.implementation
    .createHTMLDocument("")
    .createElement("template");
  template.innerHTML = source;
  const content = template.content;
  const root =
    content.querySelector('[itemprop="articleBody"]') ||
    content.querySelector("main article, [role=main] article") ||
    content.querySelector("article") ||
    content.querySelector("main, [role=main]") ||
    content;
  const normalizeTitle = (text) =>
    (text || "").trim().replace(/\s+/g, " ").toLowerCase();
  const bookmarkTitle = normalizeTitle(link.title);
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
    if (
      node.nodeType !== 1 ||
      node.hidden ||
      node.getAttribute("aria-hidden") === "true"
    )
      return "";
    const tag = node.localName;
    if (excluded.has(tag)) return "";
    if (tag === "img" || tag === "svg") {
      visited += 3;
      return articleImage(node, context);
    }
    if (tag === "pre") {
      visited += 9;
      const text = codeText(node);
      countText(text.length);
      return codeBlock(node, text, context);
    }
    if (node === firstHeading) {
      const heading = normalizeTitle(node.textContent);
      if (
        heading &&
        (bookmarkTitle === heading ||
          [" - ", " – ", " — ", " | "].some((separator) =>
            bookmarkTitle.startsWith(heading + separator),
          ))
      )
        return "";
    }
    const block = allowedTags.has(tag)
      ? document.createElement(tag === "h1" ? "h2" : tag)
      : document.createDocumentFragment();
    if (tag === "a") {
      const href = safeLink(node.getAttribute("href"), link.url);
      if (href && !node.querySelector("img,svg,pre")) {
        block.href = href;
        block.target = "_blank";
        block.rel = "noopener noreferrer";
      }
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
  return result.textContent.trim() || result.querySelector("img")
    ? result
    : null;
}

function codeText(pre) {
  if (!pre.querySelector("br")) return pre.textContent;
  const walker = pre.ownerDocument.createTreeWalker(pre);
  const parts = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === 3) parts.push(node.data);
    else if (node.localName === "br") parts.push("\n");
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
    : `/api/links/${link.id}/archive`;
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
