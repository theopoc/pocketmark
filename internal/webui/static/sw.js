"use strict";
// Deliberately cache no API responses, private pages or captured content.
const CACHE = "pocketmark-shell-v8";
const ASSETS = ["/theme.js", "/workspace.js", "/reader.js", "/bulk.js", "/tag-picker.js", "/app.js", "/style.css", "/icon.svg", "/manifest.webmanifest"];
self.addEventListener("install", (event) => { event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS))); });
self.addEventListener("activate", (event) => { event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("pocketmark-shell-") && key !== CACHE).map((key) => caches.delete(key))))); });
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || !ASSETS.includes(url.pathname) || url.search) return;
  event.respondWith(fetch(event.request).then((response) => { if (response.ok) { const copy = response.clone(); event.waitUntil(caches.open(CACHE).then((cache) => cache.put(event.request, copy))); } return response; }).catch(() => caches.match(event.request)));
});
