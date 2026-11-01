"use strict";
globalThis.Pocketmark = (() => {
  const formats = { html: ["Rendered HTML", "html"], screenshot: ["Visible area", "png"], fullpage: ["Full page", "png"], pdf: ["PDF", "pdf"] };
  function origin(value) {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Enter an http(s) server address without a path or credentials.");
    const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
    if (url.protocol === "http:" && !loopback) throw new Error("Use HTTPS for your server. HTTP is allowed only on this computer (localhost or a loopback IP).");
    return url.origin;
  }
  async function request(connection, path, options = {}) {
    const response = await fetch(origin(connection.server) + path, { ...options, credentials: "omit", redirect: "error", signal: AbortSignal.timeout(25000), headers: { Authorization: `Bearer ${connection.token}`, ...options.headers } });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { throw new Error("Unexpected server response. Check the Pocketmark address."); }
    if (!response.ok) throw new Error(data?.error || `Request failed (${response.status}).`);
    return data;
  }
  function json(method, value) { return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }; }
  function validate(fields) {
    const bytes = (value) => new TextEncoder().encode(value).length;
    const url = new URL(fields.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || bytes(fields.url) > 4096) throw new Error("Open a regular http(s) page with a URL shorter than 4096 bytes.");
    if (typeof fields.title !== "string" || bytes(fields.title) > 1024) throw new Error("Title must be at most 1024 bytes.");
    if (!Array.isArray(fields.tags) || fields.tags.length > 32 || fields.tags.some((tag) => typeof tag !== "string" || !tag.trim() || bytes(tag) > 80)) throw new Error("Use at most 32 tags, each at most 80 bytes.");
    if (fields.collectionId !== null && (!Number.isSafeInteger(fields.collectionId) || fields.collectionId <= 0)) throw new Error("Select a collection or Inbox.");
  }
  return { formats, origin, request, json, validate };
})();
