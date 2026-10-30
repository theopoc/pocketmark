"use strict";

// Shared, dependency-free state rules; draft contents stay in this tab's memory.
((root) => {
  const positive = (value, fallback = 1, max = 1000000) => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Math.min(Number(value), max) : fallback;
  function readRoute(search) {
    const params = new URLSearchParams(search);
    let filter = ["all", "inbox", "favorite", "unread", "collection"].includes(params.get("filter")) ? params.get("filter") : "all";
    const collection = positive(params.get("collection"), null, Number.MAX_SAFE_INTEGER);
    if (filter === "collection" && !collection) filter = "all";
    const tag = (params.get("tag") || "").trim();
    return {
      filter: tag ? "all" : filter, collection: !tag && filter === "collection" ? collection : null, tag,
      query: (params.get("q") || "").trim(), page: positive(params.get("page")),
      sort: ["newest", "oldest", "title", "title_desc", "updated"].includes(params.get("sort")) ? params.get("sort") : "newest",
      fuzzy: params.get("fuzzy") === "1", showingTags: params.get("view") === "tags",
      tagsQuery: (params.get("tagQuery") || "").slice(0, 512), tagsPage: positive(params.get("tagPage")),
    };
  }
  function routeSearch(route) {
    const params = new URLSearchParams();
    if (route.filter !== "all") params.set("filter", route.filter);
    if (route.filter === "collection" && route.collection) params.set("collection", route.collection);
    if (route.tag) params.set("tag", route.tag);
    if (route.query) params.set("q", route.query);
    if (route.page > 1) params.set("page", route.page);
    if (route.sort !== "newest") params.set("sort", route.sort);
    if (route.fuzzy) params.set("fuzzy", "1");
    if (route.showingTags) params.set("view", "tags");
    if (route.tagsQuery) params.set("tagQuery", route.tagsQuery);
    if (route.tagsPage > 1) params.set("tagPage", route.tagsPage);
    return params.size ? `?${params}` : "";
  }
  function createDrafts(storage) {
    const storageKey = "pocketmark:drafts:v1";
    const entries = new Map();
    try {
      const saved = storage?.getItem(storageKey);
      if (saved && saved.length <= 2 * 1024 * 1024) {
        for (const [key, value] of JSON.parse(saved)) {
          if (typeof key === "string" && value && typeof value === "object" && !Array.isArray(value)) entries.set(key, value);
        }
      }
    } catch { /* A corrupt or unavailable cache must never prevent editing. */ }
    let persisted = !!storage;
    function persist() {
      try {
        const value = JSON.stringify([...entries]);
        if (value.length > 2 * 1024 * 1024) throw new Error("Draft cache limit exceeded");
        if (entries.size) storage?.setItem(storageKey, value);
        else storage?.removeItem(storageKey);
        persisted = !!storage;
      } catch {
        persisted = false;
        try { storage?.removeItem(storageKey); } catch { /* Keep the in-memory draft. */ }
      }
    }
    const copy = (value) => JSON.parse(JSON.stringify(value));
    return {
      put(key, value, baseline) {
        if (JSON.stringify(value) === JSON.stringify(baseline)) entries.delete(key);
        else entries.set(key, copy(value));
        persist();
      },
      get: (key) => entries.has(key) ? copy(entries.get(key)) : null,
      delete(key) { const removed = entries.delete(key); persist(); return removed; },
      clear() { entries.clear(); persist(); },
      get persisted() { return persisted; },
      get size() { return entries.size; },
    };
  }
  function readerSnapshot(link, assets) {
    const html = [...assets].filter((asset) => asset.mediaType === "text/html").sort((a, b) => b.id - a.id)[0];
    if (html && html.size > 2 * 1024 * 1024) return { url: "", message: "This HTML file is too large for formatted view. Download it from Saved files instead." };
    if (html) return { url: `/api/links/${link.id}/reader?asset=${html.id}`, message: `Formatted view uses ${html.name}.` };
    if (link.archiveAvailable) return { url: `/api/links/${link.id}/reader`, message: "Formatted view uses your saved HTML capture." };
    return { url: "", message: "Formatted view needs an HTML capture or attachment. You can read the text or add an HTML snapshot under Files." };
  }
  function tagValues(selected, pending = "") {
    return [...new Set([...selected, ...pending.split(",")].map((name) => name.trim()).filter(Boolean))];
  }
  // FTS uses control characters, never HTML. Keep untrusted page markup literal,
  // including a final match whose closing marker was cut by the excerpt limit.
  function searchExcerpt(value) {
    // Tags are indexed as JSON. Show their names, not storage punctuation,
    // while preserving both decoded names and the FTS highlight markers.
    try {
      const names = JSON.parse(value.replace(/\u001e/g, "\\u001e").replace(/\u001f/g, "\\u001f"));
      if (Array.isArray(names) && names.every((name) => typeof name === "string")) value = names.join(" · ");
    } catch { /* A regular text excerpt is not JSON. */ }
    const parts = [];
    let match = false;
    for (const part of value.split(/([\u001e\u001f])/)) {
      if (part === "\u001e") match = true;
      else if (part === "\u001f") match = false;
      else if (part) parts.push({ text: part, match });
    }
    return parts;
  }
  function captureFailure(message = "") {
    if (/401|403/.test(message)) return "The site refused access; it may require a sign-in.";
    if (/404|410/.test(message)) return "The page was not found on the original site.";
    if (/429/.test(message)) return "The site is limiting requests. Try again later.";
    if (/timeout|deadline/i.test(message)) return "The site took too long to respond.";
    if (/private|loopback|blocked.*address|SSRF/i.test(message)) return "This destination is blocked by the server’s network protection.";
    if (/too large|size limit|exceeds/i.test(message)) return "The page exceeds the capture size limit.";
    if (/no such host|lookup|DNS/i.test(message)) return "The site’s address could not be reached.";
    return message ? `Details: ${message.slice(0, 240)}` : "The site did not provide a readable capture.";
  }
  function bookmarkIssues(value) {
    const issues = {};
    const bytes = (text) => new TextEncoder().encode(text || "").length;
    const url = (value.url || "").trim(), title = (value.title || "").trim();
    if (value.type !== "file") {
      try {
        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || /[\u0000-\u001f\u007f]/.test(url)) throw new Error("invalid URL");
      } catch { issues.url = "Enter a complete http:// or https:// URL without a username or password."; }
      if (bytes(url) > 4096) issues.url = "This URL is too long. Use a URL shorter than 4 KiB.";
    }
    if (bytes(title) > 1024 && title !== url) issues.title = "Shorten the title to 1 KiB or less. Accented characters and emoji can use several bytes.";
    if (bytes((value.description || "").trim()) > 8192) issues.description = "Shorten the description to 8 KiB or less.";
    if (bytes(value.notes) > 65536) issues.notes = "Shorten the notes to 64 KiB or less, or attach the full text as a file.";
    const tags = tagValues(value.tags || []);
    if (tags.length > 32) issues.tags = "Choose up to 32 tags. Remove a tag before adding another.";
    else if (tags.some((tag) => bytes(tag) > 80)) issues.tags = "Shorten each tag to 80 bytes or less. Accented characters and emoji can use several bytes.";
    return issues;
  }
  function requestFailure(status, message = "") {
    if (!status) return "Could not reach Pocketmark. Check your connection and that the server is running, then try again. Unsaved changes stay in this tab.";
    if (status === 401) return "Your sign-in has expired. Sign in again to continue. Your drafts are kept in this tab.";
    if (status === 404) return "This item is no longer available. Refresh the library before trying again.";
    if (status === 429) return message || "Too many requests. Wait a moment, then try again.";
    if (status >= 500) return "The server could not complete this action. Check that Pocketmark is running correctly, then try again. Unsaved changes stay in this tab.";
    return message || "This action could not be completed. Check the details and try again.";
  }
  function safeURL(value) {
    try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? url.href : null; } catch { return null; }
  }

  function domain(value) {
    try { return new URL(value).hostname.replace(/^www\./, ""); } catch { return "Saved link"; }
  }

  function editableBookmark(link) {
    return { url: link.url, title: link.title || "", description: link.description || "", notes: link.notes || "", collectionId: link.collectionId ?? null, tags: link.tags || [], favorite: !!link.favorite, read: !!link.read };
  }

  function bookmarkDraftKey(link) { return `bookmark:${link?.id || "new"}`; }
  const workspace = { editableBookmark, bookmarkDraftKey, safeURL, domain, readRoute, routeSearch, createDrafts, readerSnapshot, tagValues, searchExcerpt, captureFailure, bookmarkIssues, requestFailure };
  if (typeof module !== "undefined" && module.exports) module.exports = workspace;
  else root.PocketmarkWorkspace = workspace;
})(globalThis);
