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
      sort: ["newest", "oldest", "title", "updated"].includes(params.get("sort")) ? params.get("sort") : "newest",
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
  function createDrafts() {
    const entries = new Map();
    const copy = (value) => JSON.parse(JSON.stringify(value));
    return {
      put(key, value, baseline) {
        if (JSON.stringify(value) === JSON.stringify(baseline)) entries.delete(key);
        else entries.set(key, copy(value));
      },
      get: (key) => entries.has(key) ? copy(entries.get(key)) : null,
      delete: (key) => entries.delete(key),
      clear: () => entries.clear(),
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
    const parts = [];
    let match = false;
    for (const part of value.split(/([\u001e\u001f])/)) {
      if (part === "\u001e") match = true;
      else if (part === "\u001f") match = false;
      else if (part) parts.push({ text: part, match });
    }
    return parts;
  }
  const workspace = { readRoute, routeSearch, createDrafts, readerSnapshot, tagValues, searchExcerpt };
  if (typeof module !== "undefined" && module.exports) module.exports = workspace;
  else root.PocketmarkWorkspace = workspace;
})(globalThis);
