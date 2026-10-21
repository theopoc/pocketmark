"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const state = { filter: "all", collection: null, tag: "", query: "", page: 1, pageSize: 40, total: 0, links: [], collections: [], editing: null, reading: null, readerRequest: 0, request: 0, timer: null, signedIn: false, sort: "newest", fuzzy: false, selected: new Set(), editingCollection: null, annotations: [], annotationDraft: null, readerSelection: null };
  let toastTimer;
  let searchTimer;
  let tagsTimer;
  let tagsPage = 1;
  let tagsRequest = 0;
  let showingTags = false;
  const workspace = globalThis.PocketmarkWorkspace;
  const drafts = workspace.createDrafts();
  const tagPickers = new Map();
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const activeMotion = new Map();
  let themeTransition = null;
  let renderedLibraryRoute = null;
  const selectionLabels = new Map();
  const sharedParams = new URLSearchParams(location.search);
  let editorBaseline = null;
  let editorSession = 0;
  let annotationSession = 0;
  let readerAssets = [];
  let readerLayoutURL = "";
  let layoutRequest = 0;
  let routeRequest = 0;
  let scrollTimer;
  let searchSession = false;
  let tagsSearchSession = false;
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";

  function route() {
    return { ...state, showingTags, tagsPage, tagsQuery: $("tags-search").value.trim() };
  }
  function rememberScroll() {
    clearTimeout(scrollTimer);
    history.replaceState({ ...history.state, pocketmarkScroll: window.scrollY }, "");
  }
  function commitRoute(replace = false) {
    const url = location.pathname + workspace.routeSearch(route());
    if (url === location.pathname + location.search) return;
    routeRequest++;
    rememberScroll();
    history[replace ? "replaceState" : "pushState"]({ pocketmarkScroll: 0 }, "", url);
  }
  async function restoreRoute(initial = false) {
    const request = ++routeRequest;
    clearTimeout(searchTimer); clearTimeout(tagsTimer);
    const restored = workspace.readRoute(location.search);
    const scroll = history.state?.pocketmarkScroll || 0;
    const previous = workspace.routeSearch(route());
    Object.assign(state, { filter: restored.filter, collection: restored.collection, tag: restored.tag, query: restored.query, page: restored.page, sort: restored.sort, fuzzy: restored.fuzzy });
    showingTags = restored.showingTags; tagsPage = restored.tagsPage;
    $("search").value = state.query; $("tags-search").value = restored.tagsQuery;
    $("sort-order").value = state.sort; $("fuzzy-search").checked = state.fuzzy;
    $("tags-view").hidden = !showingTags; $("library-view").hidden = showingTags;
    if (!initial && previous !== workspace.routeSearch(route())) { state.selected.clear(); selectionLabels.clear(); }
    document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
    await refresh();
    if (request !== routeRequest) return;
    if (showingTags) await loadTagDirectory();
    if (request !== routeRequest) return;
    if (!initial) $(showingTags ? "tags-title" : "page-title").focus({ preventScroll: true });
    requestAnimationFrame(() => { if (request === routeRequest) window.scrollTo({ top: scroll, behavior: "instant" }); });
  }
  window.addEventListener("scroll", () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(rememberScroll, 150);
  }, { passive: true });
  window.addEventListener("popstate", () => { if (state.signedIn) restoreRoute(); });
  window.addEventListener("beforeunload", (event) => {
    if (drafts.size) { event.preventDefault(); event.returnValue = ""; }
  });

  const compactLibrary = window.matchMedia("(max-width: 600px)");
  let viewOptionsOpen = false;
  function syncViewOptions() {
    const visible = !compactLibrary.matches || viewOptionsOpen;
    $("library-view-options").hidden = !visible;
    $("view-options-toggle").setAttribute("aria-expanded", String(visible));
  }
  $("view-options-toggle").addEventListener("click", () => { viewOptionsOpen = !viewOptionsOpen; syncViewOptions(); });
  compactLibrary.addEventListener("change", syncViewOptions);
  syncViewOptions();

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // Feedback never blocks an action; a new transition replaces any earlier one.
  function move(element, frames, duration = 180) {
    activeMotion.get(element)?.cancel();
    if (reducedMotion.matches || document.hidden || !element.animate) return;
    const animation = element.animate(frames, { duration, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
    activeMotion.set(element, animation);
    animation.finished.catch(() => {}).then(() => { if (activeMotion.get(element) === animation) activeMotion.delete(element); });
  }
  reducedMotion.addEventListener("change", () => {
    if (reducedMotion.matches) { activeMotion.forEach((animation) => animation.cancel()); activeMotion.clear(); themeTransition?.skipTransition(); }
  });

  // Small, authored SVG icons keep the embedded UI independent of icon libraries.
  const iconPaths = {
    sun: ["M12 3v1M12 20v1M3 12h1M20 12h1M5.6 5.6l.7.7M17.7 17.7l.7.7M5.6 18.4l.7-.7M17.7 6.3l.7-.7", "M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0"],
    moon: ["M20.5 14.5A9 9 0 0 1 9.5 3.5a9 9 0 1 0 11 11Z"],
    bookmark: ["M6 3h12v18l-6-4-6 4V3Z"],
    library: ["M4 4v16M9 4v16M14 4v16M18 4l3 16"],
    inbox: ["M4 4h16l2 10v6H2v-6L4 4Z", "M2 14h6l2 3h4l2-3h6"],
    star: ["m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"],
    clock: ["M12 8v4l3 2", "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0"],
    plus: ["M12 5v14M5 12h14"], close: ["m6 6 12 12M6 18 18 6"],
    search: ["M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0", "m15 15 6 6"],
    refresh: ["M20 7a9 9 0 1 0 1 9", "M20 2v6h-6"],
    grid: ["M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"],
    list: ["M9 5h12M9 12h12M9 19h12M3 5h.01M3 12h.01M3 19h.01"],
    folder: ["M3 7V4h6l2 3h10v13H3V7Z"],
    tag: ["M3 3h8l10 10-8 8L3 11V3Z", "M7 7h.01"],
    edit: ["m16 3 5 5-12 12-6 1 1-6L16 3Z", "m13 6 5 5"],
    trash: ["M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"],
    external: ["M14 3h7v7M21 3 10 14", "M10 3H3v18h18v-7"],
    check: ["m5 12 4 4L19 6"], warning: ["m12 3 10 18H2L12 3Z", "M12 9v5M12 17h.01"],
    download: ["M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"],
    upload: ["M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5"],
    settings: ["M4 7h16M4 17h16M8 4v6M16 14v6"],
    logout: ["M10 4H3v16h7M8 12h13m-5-5 5 5-5 5"],
    menu: ["M4 6h16M4 12h16M4 18h16"], lock: ["M5 10h14v11H5V10Z", "M8 10V6a4 4 0 0 1 8 0v4"],
    "chevron-right": ["m9 5 7 7-7 7"], "arrow-right": ["M4 12h16m-6-6 6 6-6 6"],
    "arrow-left": ["M20 12H4m6-6-6 6 6 6"],
    book: ["M12 5C8 2 4 3 2 4v16c3-2 7-2 10 0 3-2 7-2 10 0V4c-2-1-6-2-10 1ZM12 5v15"],
  };
  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false", class: "icon" })) svg.setAttribute(key, value);
    for (const d of iconPaths[name] || iconPaths.bookmark) {
      const path = document.createElementNS(svg.namespaceURI, "path"); path.setAttribute("d", d); svg.append(path);
    }
    return svg;
  }
  document.querySelectorAll("[data-icon]").forEach((node) => node.replaceChildren(icon(node.dataset.icon)));

  function applyTheme(theme) {
    const dark = theme === "dark";
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]').content = dark ? "#15161b" : "#ffffff";
    document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
      button.setAttribute("aria-pressed", String(dark));
      button.title = dark ? "Switch to light mode" : "Switch to dark mode";
      button.querySelector("[data-theme-icon]").replaceChildren(icon(dark ? "moon" : "sun"));
      button.querySelector("[data-theme-label]").textContent = dark ? "Dark" : "Light";
    });
  }
  let requestedTheme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
  applyTheme(requestedTheme);
  function changeTheme(theme) {
    requestedTheme = theme;
    // Repeated clicks always apply the latest choice, even before a snapshot is ready.
    if (themeTransition) { themeTransition.skipTransition(); applyTheme(theme); return; }
    if (reducedMotion.matches || document.hidden || !document.startViewTransition) { applyTheme(theme); return; }
    document.documentElement.classList.add("theme-transition");
    try {
      const transition = document.startViewTransition(() => applyTheme(requestedTheme));
      themeTransition = transition;
      transition.ready.catch(() => {}); // Skipped or unsupported snapshots still apply the theme.
      transition.finished.catch(() => applyTheme(requestedTheme)).then(() => {
        if (themeTransition === transition) { themeTransition = null; document.documentElement.classList.remove("theme-transition"); }
      });
    } catch {
      document.documentElement.classList.remove("theme-transition"); applyTheme(theme);
    }
  }
  document.querySelectorAll("[data-theme-toggle]").forEach((button) => button.addEventListener("click", () => {
    const theme = requestedTheme === "dark" ? "light" : "dark";
    changeTheme(theme);
    try { localStorage.setItem("pocketmark-theme", theme); } catch { /* Keep the session choice when storage is unavailable. */ }
  }));

  let libraryView = "list";
  try { if (localStorage.getItem("pocketmark-view") === "grid") libraryView = "grid"; } catch { /* Storage is optional. */ }
  function setLibraryView(view) {
    const changed = $("bookmark-grid").classList.contains("view-list") !== (view === "list");
    libraryView = view;
    $("bookmark-grid").classList.toggle("view-list", view === "list");
    for (const value of ["list", "grid"]) $("view-" + value).setAttribute("aria-pressed", String(view === value));
    try { localStorage.setItem("pocketmark-view", view); } catch { /* Private browsing may disallow storage. */ }
    if (changed && state.signedIn) move($("bookmark-grid"), [{ opacity: .8 }, { opacity: 1 }]);
  }
  $("view-list").addEventListener("click", () => setLibraryView("list"));
  $("view-grid").addEventListener("click", () => setLibraryView("grid"));
  setLibraryView(libraryView);

  const mobileNavigation = matchMedia("(max-width: 900px)");
  const navigation = $("navigation-dialog");
  function closeNavigation() { if (navigation.open) navigation.close(); }
  function placeNavigation() {
    closeNavigation();
    (mobileNavigation.matches ? navigation : $("sidebar-slot")).append($("sidebar"));
  }
  mobileNavigation.addEventListener("change", placeNavigation);
  placeNavigation();
  $("open-navigation").addEventListener("click", () => {
    navigation.showModal();
    $("open-navigation").setAttribute("aria-expanded", "true");
    $("close-navigation").focus();
  });
  $("close-navigation").addEventListener("click", closeNavigation);
  navigation.addEventListener("close", () => $("open-navigation").setAttribute("aria-expanded", "false"));
  navigation.addEventListener("click", (event) => { if (event.target === navigation) closeNavigation(); });
  $("sidebar").addEventListener("click", (event) => {
    if (event.target.closest("button") && event.target.closest("button").id !== "close-navigation") closeNavigation();
  }, true);

  function toast(message, error = false) {
    clearTimeout(toastTimer);
    $("toast").textContent = message;
    $("toast").className = error ? "error" : "";
    $("toast").hidden = false;
    toastTimer = setTimeout(() => { $("toast").hidden = true; }, 5000);
  }

  let setupRequired = false;
  function showLogin() {
    clearTimeout(tagsTimer);
    tagsRequest++;
    state.signedIn = false;
    state.request++;
    clearTimeout(state.timer);
    document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
    $("app-view").hidden = true;
    $("login-view").hidden = false;
    $("login-username").focus();
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const response = await fetch(path, { ...options, headers, credentials: "same-origin" });
    let body = null;
    if (response.status !== 204) {
      const text = await response.text();
      if (text) {
        try { body = JSON.parse(text); } catch { throw new Error("The server returned an unexpected response. Please try again."); }
      }
    }
    if (!response.ok) {
      if (response.status === 401 && path !== "/api/login" && path !== "/api/setup") showLogin();
      const error = new Error(body?.error || `Request failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return body;
  }

  function safeURL(value) {
    try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? url.href : null; } catch { return null; }
  }

  function domain(value) {
    try { return new URL(value).hostname.replace(/^www\./, ""); } catch { return "Saved link"; }
  }

  function editable(link) {
    return { url: link.url, title: link.title || "", description: link.description || "", notes: link.notes || "", collectionId: link.collectionId ?? null, tags: link.tags || [], favorite: !!link.favorite, read: !!link.read };
  }

  function collectionLabel(id) {
    return state.collections.find((collection) => String(collection.id) === String(id))?.name || "Collection";
  }

  function currentTitle() {
    if (state.tag) return `#${state.tag}`;
    if (state.filter === "collection") return collectionLabel(state.collection);
    return { all: "All bookmarks", inbox: "Inbox", favorite: "Favorites", unread: "To read" }[state.filter];
  }

  function updateHeading() {
    const title = currentTitle();
    $("page-title").textContent = title;
    $("breadcrumb-current").textContent = showingTags ? "All tags" : title;
    $("tags-library-context").hidden = !state.query;
    $("tags-library-context").textContent = `Your bookmark search “${state.query}” will remain applied when you open a tag.`;
    $("all-tags").classList.toggle("active", showingTags);
    if (showingTags) $("all-tags").setAttribute("aria-current", "page"); else $("all-tags").removeAttribute("aria-current");
    const descriptions = { all: "Everything you save, in one place.", inbox: "Saved links waiting to be organized.", favorite: "The bookmarks you want to keep close.", unread: "Your reading list, ready when you are.", collection: "Bookmarks organized in this collection." };
    $("page-subtitle").textContent = state.tag ? `Bookmarks tagged #${state.tag}.` : descriptions[state.filter];
    document.querySelectorAll("[data-filter]").forEach((button) => {
      const active = !showingTags && !state.tag && button.dataset.filter === state.filter;
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
    });
    renderActiveFilters();
  }

  function renderActiveFilters() {
    const root = $("active-filters"), key = focusedKey(root); root.replaceChildren();
    const add = (label, clear) => {
      const button = el("button", "filter-chip", label); button.append(icon("close"));
      button.dataset.focusKey = `filter:${label}`;
      button.setAttribute("aria-label", `Remove ${label} filter`);
      button.addEventListener("click", () => { clear(); state.page = 1; commitRoute(); refresh(); $("page-title").focus(); });
      root.append(button);
    };
    if (state.filter !== "all") add(currentTitle(), () => { state.filter = "all"; state.collection = null; });
    if (state.tag) add(`#${state.tag}`, () => { state.tag = ""; });
    if (state.query) add(`Search: ${state.query}`, () => { clearTimeout(searchTimer); state.query = ""; $("search").value = ""; });
    if (state.fuzzy) add("Near matches", () => { state.fuzzy = false; $("fuzzy-search").checked = false; });
    root.hidden = !root.childElementCount;
    restoreFocus(root, key);
  }
  function focusedKey(root) { return root.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null; }
  function restoreFocus(root, key) {
    if (!key || document.activeElement !== document.body || document.querySelector("dialog[open]")) return;
    [...root.querySelectorAll("[data-focus-key]")].find((node) => node.dataset.focusKey === key)?.focus({ preventScroll: true });
  }

  function selectFilter(filter, collection = null, tag = "") {
    clearTimeout(searchTimer);
    state.query = $("search").value.trim();
    clearTimeout(tagsTimer);
    tagsRequest++;
    showingTags = false;
    state.filter = filter;
    state.collection = collection;
    state.tag = tag;
    state.page = 1;
    state.selected.clear();
    selectionLabels.clear();
    commitRoute();
    $("tags-view").hidden = true;
    $("library-view").hidden = false;
    updateHeading();
    renderCollections();
    refresh();
    $("page-title").focus();
  }

  function orderedCollections() {
    const result = [], seen = new Set();
    function visit(parentId, depth) {
      for (const collection of state.collections) {
        if ((collection.parentId ?? null) !== parentId || seen.has(collection.id)) continue;
        seen.add(collection.id); result.push({ ...collection, depth }); visit(collection.id, depth + 1);
      }
    }
    visit(null, 0);
    for (const collection of state.collections) if (!seen.has(collection.id)) result.push({ ...collection, depth: 0 });
    return result;
  }
  function fillCollections(select, selected, emptyLabel = "Inbox") {
    select.replaceChildren();
    const first = el("option", "", emptyLabel);
    first.value = "";
    select.append(first);
    for (const collection of orderedCollections()) {
      const option = el("option", "", `${"— ".repeat(Math.min(collection.depth, 6))}${collection.name}`);
      option.value = collection.id;
      select.append(option);
    }
    select.value = selected == null ? "" : String(selected);
  }

  function renderCollections() {
    const key = focusedKey($("collections"));
    $("collections").replaceChildren();
    if (!state.collections.length) $("collections").append(el("p", "small muted", "No collections yet."));
    for (const collection of orderedCollections()) {
      const row = el("div", "collection-row");
      row.style.marginLeft = `${Math.min(collection.depth, 5) * 9}px`;
      const button = el("button", "nav-item");
      button.dataset.focusKey = `collection:${collection.id}`;
      button.classList.toggle("active", !showingTags && state.filter === "collection" && String(state.collection) === String(collection.id));
      button.append(icon("folder"), el("span", "collection-name", collection.name));
      if (button.classList.contains("active")) button.setAttribute("aria-current", "page");
      if (collection.parentId != null) button.title = `Inside ${collectionLabel(collection.parentId)}`;
      button.addEventListener("click", () => selectFilter("collection", collection.id));
      const remove = el("button", "icon-button delete-collection"); remove.append(icon("trash"));
      remove.dataset.focusKey = `delete-collection:${collection.id}`;
      remove.title = `Delete ${collection.name}`;
      remove.setAttribute("aria-label", remove.title);
      remove.addEventListener("click", async () => {
        if (!confirm(`Delete “${collection.name}”? Its bookmarks will move to Inbox.`)) return;
        remove.disabled = true;
        try {
          await api(`/api/collections/${collection.id}`, { method: "DELETE" });
          if (state.filter === "collection") { state.filter = "all"; state.collection = null; state.page = 1; }
          commitRoute(true);
          await refresh();
          toast("Collection deleted. Bookmarks kept.");
        } catch (error) { toast(error.message, true); remove.disabled = false; }
      });
      const edit = el("button", "icon-button delete-collection"); edit.append(icon("edit"));
      edit.dataset.focusKey = `edit-collection:${collection.id}`;
      edit.title = `Rename or move ${collection.name}`;
      edit.setAttribute("aria-label", edit.title);
      edit.addEventListener("click", () => openCollectionEditor(collection));
      row.append(button, edit, remove);
      $("collections").append(row);
    }
    restoreFocus($("collections"), key);
  }

  function renderTags(tags) {
    const key = focusedKey($("tags"));
    $("tags").replaceChildren();
    for (const tag of tags.slice(0, 12)) {
      const button = el("button", "tag-button", `#${tag.name}`);
      button.dataset.focusKey = `tag:${tag.name}`;
      button.classList.toggle("active", state.tag === tag.name);
      button.setAttribute("aria-pressed", String(state.tag === tag.name));
      button.title = `${tag.count} bookmark${tag.count === 1 ? "" : "s"}`;
      button.addEventListener("click", () => selectFilter("all", null, state.tag === tag.name ? "" : tag.name));
      $("tags").append(button);
    }
    restoreFocus($("tags"), key);
  }

  function disableTagAlphabet() {
    $("tags-letter-picker").disabled = true;
    $("tags-alphabet").querySelectorAll("button").forEach((button) => { button.disabled = true; });
  }

  function renderTagAlphabet(groups, activeLetter) {
    const available = new Map(groups.map((group) => [group.letter, group.count]));
    $("tags-alphabet").replaceChildren();
    $("tags-letter-picker").replaceChildren(el("option", "", "Choose a letter"));
    $("tags-letter-picker").firstElementChild.value = "";
    for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ#") {
      const button = el("button", "tag-letter-link", letter);
      const count = available.get(letter) || 0;
      button.disabled = !count;
      button.setAttribute("aria-label", `${letter === "#" ? "Other characters" : letter}: ${count} tag${count === 1 ? "" : "s"}`);
      if (letter === activeLetter) button.setAttribute("aria-current", "location");
      button.addEventListener("click", () => { clearTimeout(tagsTimer); loadTagDirectory(letter); });
      $("tags-alphabet").append(button);
      if (count) { const option = el("option", "", letter === "#" ? "Other characters" : letter); option.value = letter; $("tags-letter-picker").append(option); }
    }
    $("tags-letter-picker").disabled = !groups.length;
  }

  async function loadTagDirectory(jump = "") {
    const request = ++tagsRequest;
    const query = $("tags-search").value.trim();
    $("tags-list").setAttribute("aria-busy", "true");
    $("tags-results").textContent = "Loading tags…";
    $("tags-error").hidden = true;
    $("tags-empty").hidden = true;
    $("tags-list").replaceChildren();
    disableTagAlphabet();
    $("tags-pagination").hidden = true;
    try {
      const params = new URLSearchParams({ q: query, page: String(tagsPage) });
      if (jump) params.set("jump", jump);
      const result = await api(`/api/tags/browse?${params}`);
      if (request !== tagsRequest) return;
      tagsPage = result.page;
      commitRoute(!jump);
      const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
      if (tagsPage > pages) { tagsPage = pages; return loadTagDirectory(); }
      const sections = new Map();
      for (const tag of result.tags) {
        if (!sections.has(tag.letter)) {
          const section = el("section", "tag-index-group");
          const heading = el("h2", "tag-index-letter", tag.letter);
          heading.id = `tags-letter-${tag.letter === "#" ? "other" : tag.letter}`;
          heading.tabIndex = -1;
          if (tag.letter === "#") heading.setAttribute("aria-label", "Other characters");
          section.setAttribute("aria-labelledby", heading.id);
          const rows = el("div", "tag-group-rows");
          section.append(heading, rows);
          sections.set(tag.letter, rows);
          $("tags-list").append(section);
        }
        const button = el("button", "tag-directory-row");
        const name = el("span", "tag-directory-name", `#${tag.name}`);
        const count = el("span", "tag-directory-count", String(tag.count));
        count.setAttribute("aria-label", `${tag.count} bookmark${tag.count === 1 ? "" : "s"}`);
        button.append(name, count, icon("chevron-right"));
        button.addEventListener("click", () => {
          clearTimeout(searchTimer);
          selectFilter("all", null, tag.name);
          $("page-title").focus();
        });
        sections.get(tag.letter).append(button);
      }
      renderTagAlphabet(result.groups, jump || result.tags[0]?.letter);
      $("tags-results").textContent = `${result.total} tag${result.total === 1 ? "" : "s"}${query ? ` matching “${query}”` : " in your library"}`;
      $("tags-empty").hidden = result.total > 0;
      $("tags-empty").textContent = query ? "No tags match your search. Try a different name." : "No tags yet. Add tags when saving or editing a bookmark.";
      $("tags-pagination").hidden = pages <= 1;
      $("tags-page-label").textContent = `Page ${tagsPage} of ${pages}`;
      $("tags-previous").disabled = tagsPage <= 1;
      $("tags-next").disabled = tagsPage >= pages;
      if (!jump && showingTags) move($("tags-list"), [{ opacity: .75 }, { opacity: 1 }]);
      if (jump && sections.has(jump)) {
        const heading = sections.get(jump).previousElementSibling;
        heading.focus({ preventScroll: true });
        heading.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      }
    } catch (error) {
      if (request !== tagsRequest) return;
      $("tags-error").textContent = error.message;
      $("tags-error").hidden = false;
      $("tags-results").textContent = "Could not load tags. Use Refresh tags to try again.";
    } finally {
      if (request === tagsRequest) $("tags-list").setAttribute("aria-busy", "false");
    }
  }
  $("all-tags").addEventListener("click", () => {
    clearTimeout(searchTimer); state.query = $("search").value.trim();
    showingTags = true;
    commitRoute();
    $("library-view").hidden = true; $("tags-view").hidden = false;
    updateHeading(); renderCollections(); loadTagDirectory(); $("tags-search").focus();
  });
  $("tags-back").addEventListener("click", () => {
    clearTimeout(tagsTimer); tagsRequest++;
    showingTags = false;
    commitRoute();
    $("tags-view").hidden = true; $("library-view").hidden = false;
    updateHeading(); renderCollections(); $("page-title").focus();
    move($("bookmark-grid"), [{ opacity: .75 }, { opacity: 1 }]);
  });
  $("tags-search").addEventListener("input", () => {
    clearTimeout(tagsTimer);
    tagsRequest++; // Invalidate an older query immediately, before the debounce.
    disableTagAlphabet();
    tagsTimer = setTimeout(() => { tagsPage = 1; commitRoute(tagsSearchSession); tagsSearchSession = true; loadTagDirectory(); }, 250);
  });
  $("tags-search").addEventListener("blur", () => { tagsSearchSession = false; });
  $("tags-letter-picker").addEventListener("change", () => { if ($("tags-letter-picker").value) loadTagDirectory($("tags-letter-picker").value); });
  $("tags-retry").addEventListener("click", () => { clearTimeout(tagsTimer); loadTagDirectory(); });
  $("tags-previous").addEventListener("click", () => { tagsPage--; commitRoute(); loadTagDirectory(); });
  $("tags-next").addEventListener("click", () => { tagsPage++; commitRoute(); loadTagDirectory(); });

  function actionButton(symbol, label, callback, extraClass = "") {
    const button = el("button", `card-action ${extraClass}`);
    button.append(icon(symbol));
    button.title = label;
    button.setAttribute("aria-label", label);
    button.addEventListener("click", callback);
    return button;
  }

  async function updateLink(link, changes, button) {
    if (button) button.disabled = true;
    try {
      await api(`/api/links/${link.id}`, { method: "PUT", body: JSON.stringify({ ...editable(link), ...changes }) });
      await refresh();
    } catch (error) { toast(error.message, true); if (button) button.disabled = false; }
  }

  function renderLinks() {
    const grid = $("bookmark-grid");
    const key = focusedKey(grid);
    grid.replaceChildren();
    for (const link of state.links) {
      const card = el("article", "bookmark-card");
      const top = el("div", "card-top");
      const host = link.type === "file" ? "Saved file" : domain(link.url);
      const avatar = el("span", "domain-avatar");
      avatar.append(icon(link.type === "file" ? "book" : "bookmark"));
      avatar.setAttribute("aria-hidden", "true");
      const favorite = el("button", `card-action favorite-button${link.favorite ? " is-favorite" : ""}`);
      favorite.append(icon("star"));
      favorite.title = link.favorite ? "Remove from favorites" : "Add to favorites";
      favorite.setAttribute("aria-label", `${favorite.title}: ${link.title || link.url}`);
      favorite.setAttribute("aria-pressed", String(!!link.favorite));
      favorite.addEventListener("click", () => updateLink(link, { favorite: !link.favorite }, favorite));
      const select = el("input", "bookmark-select");
      select.type = "checkbox";
      select.checked = state.selected.has(link.id);
      select.dataset.focusKey = `link:${link.id}:select`;
      select.setAttribute("aria-label", `Select ${link.title || link.url}`);
      select.addEventListener("change", () => {
        if (select.checked && state.selected.size >= 500) { select.checked = false; toast("Select up to 500 bookmarks at a time.", true); return; }
        if (select.checked) { state.selected.add(link.id); selectionLabels.set(link.id, link.title || link.url); }
        else { state.selected.delete(link.id); selectionLabels.delete(link.id); }
        card.classList.toggle("is-selected", select.checked);
        updateSelection();
      });
      card.classList.toggle("is-selected", select.checked);
      const selectTarget = el("label", "bookmark-select-target");
      selectTarget.append(select);
      top.append(selectTarget, avatar);
      const body = el("div", "card-body");
      const heading = el("h2", "card-title");
      const open = el("button", "", link.title || link.url);
      open.dataset.focusKey = `link:${link.id}:open`;
      open.addEventListener("click", () => openReader(link.id));
      heading.append(open);
      body.append(heading, el("p", "card-domain", host));
      if (link.description) body.append(el("p", "card-description", link.description));
      if (state.query && link.searchSnippet) {
        const excerpt = el("p", "search-excerpt");
        excerpt.append(el("span", "search-match-label", "Match: "));
        for (const part of workspace.searchExcerpt(link.searchSnippet)) {
          excerpt.append(part.match ? el("mark", "", part.text) : document.createTextNode(part.text));
        }
        body.append(excerpt);
      }
      const tags = el("div", "card-tags");
      for (const name of (link.tags || []).slice(0, 5)) {
        const tag = el("button", "card-tag", `#${name}`);
        tag.addEventListener("click", () => selectFilter("all", null, name));
        tags.append(tag);
      }
      if ((link.tags || []).length > 5) {
        const more = el("button", "card-tag", `+${link.tags.length - 5}`);
        more.setAttribute("aria-label", `Show all ${link.tags.length} tags for ${link.title || link.url}`);
        more.addEventListener("click", () => {
          more.remove();
          for (const name of link.tags.slice(5)) {
            const tag = el("button", "card-tag", `#${name}`);
            tag.addEventListener("click", () => selectFilter("all", null, name));
            tags.append(tag);
          }
        });
        tags.append(more);
      }
      body.append(tags);
      const footer = el("div", "card-footer");
      const statuses = { pending: "Queued", processing: "Saving…", ready: "Captured", failed: "Capture failed" };
      const status = el("span", "card-state", statuses[link.status] || "Saved link");
      status.classList.add(["pending", "processing", "ready", "failed"].includes(link.status) ? link.status : "saved");
      status.prepend(icon(link.status === "ready" ? "check" : link.status === "failed" ? "warning" : "clock"));
      footer.append(status);
      const actions = el("div", "card-actions");
      actions.append(favorite);
      actions.append(actionButton(link.read ? "check" : "clock", link.read ? "Mark unread" : "Mark as read", (event) => updateLink(link, { read: !link.read }, event.currentTarget), link.read ? "read" : ""));
      actions.append(actionButton("edit", "Edit bookmark", () => openEditor(link)));
      actions.append(actionButton("trash", "Delete bookmark", async (event) => {
        if (!confirm(`Delete “${link.title || link.url}” and its saved content?`)) return;
        const button = event.currentTarget;
        button.disabled = true;
        try {
          await api(`/api/links/${link.id}`, { method: "DELETE" });
          state.selected.delete(link.id); selectionLabels.delete(link.id);
          if (state.links.length === 1 && state.page > 1) state.page--;
          await refresh();
          toast("Bookmark deleted.");
        } catch (error) { toast(error.message, true); button.disabled = false; }
      }));
      const url = safeURL(link.url);
      if (url) {
        const original = el("a", "card-action"); original.append(icon("external"));
        original.href = url;
        original.target = "_blank";
        original.rel = "noopener noreferrer";
        original.title = "Visit original";
        original.setAttribute("aria-label", `Visit ${host}`);
        actions.append(original);
      }
      footer.append(actions);
      actions.querySelectorAll("button,a").forEach((button, i) => {
        button.dataset.focusKey = `link:${link.id}:action:${i}`;
        button.setAttribute("aria-label", `${button.title}: ${link.title || link.url}`);
      });
      card.append(top, body, footer);
      grid.append(card);
    }
    updateSelection();
    $("empty-state").hidden = state.links.length > 0;
    const filtered = !!state.query || state.filter !== "all" || !!state.tag;
    $("empty-title").textContent = filtered ? "No bookmarks found" : "Your library starts here";
    $("empty-message").textContent = filtered ? "Try a different search or clear your filters to see all bookmarks." : "Save your first bookmark, or import an existing library from the navigation.";
    $("empty-reset").hidden = !filtered;
    $("empty-add").textContent = filtered ? "Add a bookmark" : "Add your first bookmark";
    $("empty-add").classList.toggle("primary", !filtered);
    $("empty-add").classList.toggle("subtle", filtered);
    $("empty-reset").classList.toggle("primary", filtered);
    $("empty-reset").classList.toggle("subtle", !filtered);
    const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
    $("pagination").hidden = pages <= 1;
    $("page-label").textContent = `Page ${state.page} of ${pages}`;
    $("previous-page").disabled = state.page <= 1;
    $("next-page").disabled = state.page >= pages;
    $("results-label").textContent = `${state.total} bookmark${state.total === 1 ? "" : "s"}${state.query ? ` matching “${state.query}”` : " in this view"}`;
    restoreFocus(grid, key);
  }

  async function refresh(quiet = false) {
    if (!state.signedIn) return;
    clearTimeout(state.timer);
    const request = ++state.request;
    const params = new URLSearchParams({ page: String(state.page), sort: state.sort });
    if (state.fuzzy) params.set("fuzzy", "1");
    if (state.query) params.set("q", state.query);
    if (state.tag) params.set("tag", state.tag);
    if (state.filter === "favorite") params.set("favorite", "1");
    if (state.filter === "unread") params.set("unread", "1");
    if (state.filter === "inbox") params.set("collection", "0");
    if (state.filter === "collection") params.set("collection", state.collection);
    $("bookmark-grid").setAttribute("aria-busy", "true");
    if (!quiet) $("results-label").textContent = "Loading your library…";
    $("library-error").hidden = true;
    try {
      const [result, collections, tags, stats] = await Promise.all([api(`/api/links?${params}`), api("/api/collections"), api("/api/tags"), api("/api/stats")]);
      if (request !== state.request) return;
      state.links = result.links || [];
      state.total = result.total || 0;
      state.pageSize = result.pageSize || 40;
      const lastPage = Math.max(1, Math.ceil(state.total / state.pageSize));
      if (state.page > lastPage) { state.page = lastPage; commitRoute(true); return refresh(quiet); }
      state.collections = collections || [];
      $("total-count").textContent = stats.links;
      $("capture-label").textContent = [stats.pending ? `${stats.pending} in progress` : "", stats.failed ? `${stats.failed} failed` : ""].filter(Boolean).join(" · ");
      if ($("capture-label").textContent) $("capture-label").textContent = `Library captures: ${$("capture-label").textContent}`;
      updateHeading();
      renderCollections();
      renderTags(tags || []);
      renderLinks();
      const destination = params.toString();
      if (!quiet && !showingTags && renderedLibraryRoute !== null && destination !== renderedLibraryRoute) move($("bookmark-grid"), [{ opacity: .75 }, { opacity: 1 }]);
      renderedLibraryRoute = destination;
      if (stats.pending && !document.hidden) state.timer = setTimeout(() => refresh(true), 5000);
    } catch (error) {
      if (request !== state.request) return;
      $("library-error").textContent = error.message;
      $("library-error").hidden = false;
      $("results-label").textContent = "Could not refresh library";
    } finally {
      if (request === state.request) $("bookmark-grid").setAttribute("aria-busy", "false");
    }
  }

  function openEditor(link = null) {
    editorSession++;
    $("save-bookmark").disabled = false;
    state.editing = link;
    $("bookmark-form").reset();
    $("bookmark-error").textContent = "";
    $("bookmark-dialog-title").textContent = link ? "Edit bookmark" : "Add bookmark";
    $("bookmark-url").value = link?.url || "";
    const file = link?.type === "file";
    $("bookmark-url").readOnly = file;
    $("bookmark-url").type = file ? "text" : "url";
    $("bookmark-title").value = link?.title || "";
    $("bookmark-description").value = link?.description || "";
    $("bookmark-notes").value = link?.notes || "";
    tagPickers.get("bookmark-tags").set(link?.tags || []);
    $("bookmark-favorite").checked = !!link?.favorite;
    $("bookmark-read").checked = !!link?.read;
    fillCollections($("bookmark-collection"), link ? link.collectionId : state.filter === "collection" ? state.collection : null);
    editorBaseline = editorValues();
    const draft = drafts.get(draftKey(link));
    if (draft) fillEditor(draft);
    $("bookmark-draft").hidden = !draft;
    $("bookmark-dialog").showModal();
    $("bookmark-url").focus();
  }

  function draftKey(link) { return `bookmark:${link?.id || "new"}`; }
  function editorValues() {
    return { url: $("bookmark-url").value, title: $("bookmark-title").value, description: $("bookmark-description").value, notes: $("bookmark-notes").value, collectionId: $("bookmark-collection").value ? Number($("bookmark-collection").value) : null, tags: [...new Set($("bookmark-tags").value.split(",").map((tag) => tag.trim()).filter(Boolean))], favorite: $("bookmark-favorite").checked, read: $("bookmark-read").checked };
  }
  function fillEditor(value) {
    for (const field of ["url", "title", "description", "notes"]) $("bookmark-" + field).value = value[field] || "";
    tagPickers.get("bookmark-tags").set(value.tags || []);
    fillCollections($("bookmark-collection"), value.collectionId);
    $("bookmark-favorite").checked = !!value.favorite; $("bookmark-read").checked = !!value.read;
  }
  $("bookmark-form").addEventListener("input", () => {
    if (!editorBaseline) return;
    drafts.put(draftKey(state.editing), editorValues(), editorBaseline);
    $("bookmark-draft").hidden = !drafts.get(draftKey(state.editing));
  });
  $("bookmark-dialog").addEventListener("close", () => {
    if (drafts.get(draftKey(state.editing))) toast("Bookmark draft kept in this tab.");
  });
  $("bookmark-form").addEventListener("change", () => $("bookmark-form").dispatchEvent(new Event("input")));
  $("discard-bookmark-draft").addEventListener("click", () => {
    if (!confirm("Discard this unsaved draft?")) return;
    drafts.delete(draftKey(state.editing)); fillEditor(editorBaseline); $("bookmark-draft").hidden = true;
  });

  function attachTagPicker(id) {
    const source = $(id), input = el("input", "tag-picker-query"), host = el("div", "tag-picker"), panel = el("div", "tag-picker-panel");
    const field = el("div", "tag-picker-field");
    input.id = id + "-query"; input.placeholder = "Choose or create tags"; input.spellcheck = false;
    document.querySelector(`label[for="${id}"]`).htmlFor = input.id;
    source.type = "hidden"; source.hidden = true;
    const status = el("p", "tag-picker-status"), list = el("div", "tag-picker-options");
    const retry = el("button", "text-button tag-picker-retry", "Retry tag suggestions");
    const hint = $(id + "-hint") || el("p", "field-hint");
    hint.textContent = "Choose a tag or type a new one, then press Enter. Use commas to add several.";
    hint.id = id + "-hint";
    if (!hint.parentNode) source.after(hint);
    source.before(host); host.append(source, field, panel); field.append(input); panel.append(status, list, retry);
    panel.hidden = true; retry.hidden = true; retry.type = "button";
    list.id = id + "-options"; list.setAttribute("role", "listbox"); list.setAttribute("aria-label", "Tag suggestions");
    status.setAttribute("role", "status");
    input.setAttribute("role", "combobox"); input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-controls", list.id); input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-describedby", hint.id);
    input.autocomplete = "off";
    let generation = 0, timer, options = [], active = -1, selected = [], rendering = false;
    function sync(emit = true) {
      source.value = workspace.tagValues(selected, input.value).join(", ");
      if (emit) source.dispatchEvent(new Event("input", { bubbles: true }));
    }
    function renderTags() {
      const previous = new Map();
      const animateTags = !reducedMotion.matches && input.closest("dialog").open;
      if (animateTags) {
        field.querySelectorAll(".tag-picker-chip").forEach((chip) => previous.set(chip.dataset.tagName, chip.getBoundingClientRect()));
      }
      rendering = true;
      field.querySelectorAll(".tag-picker-chip").forEach((chip) => { activeMotion.get(chip)?.cancel(); chip.remove(); });
      selected.forEach((name, index) => {
        const chip = el("span", "tag-picker-chip"), remove = el("button", "tag-picker-remove");
        chip.dataset.tagName = name;
        remove.type = "button"; remove.setAttribute("aria-label", `Remove tag ${name}`); remove.append(icon("close"));
        remove.addEventListener("click", (event) => {
          selected.splice(index, 1); renderTags(); sync(); close();
          if (event.detail === 0) (field.querySelectorAll(".tag-picker-remove")[index] || input).focus();
          else input.focus();
        });
        remove.addEventListener("keydown", (event) => {
          if (["Backspace", "Delete"].includes(event.key)) { event.preventDefault(); remove.click(); }
        });
        chip.append(el("span", "tag-picker-chip-name", `#${name}`), remove); field.insertBefore(chip, input);
      });
      input.placeholder = selected.length ? "Add a tag…" : "Choose or create tags";
      rendering = false;
      position();
      if (animateTags) {
        // Read every destination before starting animations to avoid layout thrashing.
        const destinations = [...field.querySelectorAll(".tag-picker-chip")].map((chip) => [chip, chip.getBoundingClientRect()]);
        for (const [chip, bounds] of destinations) {
          const before = previous.get(chip.dataset.tagName);
          if (!before) move(chip, [{ opacity: .6, transform: "scale(.97)" }, { opacity: 1, transform: "scale(1)" }], 150);
          else {
            const x = before.left - bounds.left, y = before.top - bounds.top;
            if (Math.abs(x) + Math.abs(y) > 1) move(chip, [{ transform: `translate(${x}px,${y}px)` }, { transform: "translate(0,0)" }]);
          }
        }
      }
    }
    function commitTyped() {
      if (!input.value.trim()) return;
      selected = workspace.tagValues(selected, input.value); input.value = ""; renderTags(); sync();
    }
    tagPickers.set(id, { set(names) { selected = workspace.tagValues(names); input.value = ""; renderTags(); sync(false); close(); } });
    function position() {
      if (panel.hidden) return;
      const bounds = field.getBoundingClientRect(), dialog = input.closest("dialog").getBoundingClientRect();
      const below = dialog.bottom - bounds.bottom - 12, above = bounds.top - dialog.top - 12;
      const upward = below < 240 && above > below;
      panel.dataset.side = Math.max(above, below) < 120 ? "inline" : upward ? "above" : "below";
      list.style.maxHeight = `${Math.max(44, Math.min(216, (upward ? above : below) - status.offsetHeight - 28))}px`;
    }
    function close() {
      clearTimeout(timer); generation++; panel.hidden = true;
      input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant");
    }
    function choose(name) {
      selected = workspace.tagValues(selected, name); input.value = ""; renderTags(); sync();
      input.focus(); schedule(0);
    }
    function highlight(index) {
      active = index;
      [...list.children].forEach((option, i) => option.setAttribute("aria-selected", String(i === index)));
      const option = list.children[index];
      if (option) { input.setAttribute("aria-activedescendant", option.id); option.scrollIntoView({ block: "nearest" }); }
      else input.removeAttribute("aria-activedescendant");
    }
    function schedule(delay = 180) {
      clearTimeout(timer);
      const request = ++generation;
      const query = input.value.trim(), alreadySelected = new Set(selected);
      options = []; active = -1; list.replaceChildren(); retry.hidden = true;
      input.removeAttribute("aria-activedescendant"); input.setAttribute("aria-expanded", "true");
      panel.hidden = false; status.textContent = "Finding tags…";
      position();
      timer = setTimeout(async () => {
        try {
          // The browse endpoint searches the entire library in bounded pages.
          const result = query ? await api(`/api/tags/browse?q=${encodeURIComponent(query)}`) : await api("/api/tags");
          if (request !== generation || !input.closest("dialog")?.open) return;
          const tags = query ? result.tags : result;
          const available = tags.filter((tag) => !alreadySelected.has(tag.name));
          options = available.slice(0, 12).map((tag) => ({ ...tag, create: false }));
          if (query && !alreadySelected.has(query) && !tags.some((tag) => tag.name === query)) options.push({ name: query, create: true });
          status.textContent = options.length ? (query ? "Matching tags" : "Frequent tags") : "These tags are already selected. Type to find or create another.";
          if (!tags.length && !query) status.textContent = "No tags yet. Type a tag name to create your first one.";
          if (available.length > 12 || query && result.total > tags.length) status.textContent += " · Type more to narrow the list";
          for (const [i, tag] of options.entries()) {
            const option = el("button", "tag-picker-option");
            option.type = "button"; option.tabIndex = -1; option.id = `${id}-option-${i}`;
            option.setAttribute("role", "option"); option.setAttribute("aria-selected", "false");
            option.append(el("span", "tag-picker-name", `#${tag.name}`), el("span", "tag-picker-count", tag.create ? "Create tag" : `${tag.count} bookmark${tag.count === 1 ? "" : "s"}`));
            option.addEventListener("pointerdown", (event) => event.preventDefault());
            option.addEventListener("click", () => choose(tag.name));
            list.append(option);
          }
          position();
        } catch (error) {
          if (request !== generation) return;
          status.textContent = "Could not load tags. You can still type tag names.";
          retry.hidden = false;
          position();
        }
      }, delay);
    }
    input.addEventListener("focus", () => schedule(0));
    input.addEventListener("click", () => { if (panel.hidden) schedule(0); });
    input.addEventListener("input", (event) => {
      event.stopPropagation();
      if (!event.isComposing && input.value.includes(",")) {
        const parts = input.value.split(","); input.value = parts.pop().trimStart();
        selected = workspace.tagValues(selected, parts.join(",")); renderTags();
      }
      sync(); schedule();
    });
    input.addEventListener("compositionend", () => input.dispatchEvent(new Event("input", { bubbles: true })));
    input.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "Escape" && !panel.hidden) { event.preventDefault(); event.stopPropagation(); close(); }
      else if (["ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        if (panel.hidden) schedule(0);
        else if (options.length) highlight((active + (event.key === "ArrowDown" ? 1 : active < 0 ? 0 : -1) + options.length) % options.length);
      } else if (event.key === "Enter") {
        event.preventDefault();
        const query = input.value.trim();
        if (active >= 0 && options[active]) choose(options[active].name);
        else if (query) choose(query);
      } else if (event.key === "Backspace" && !input.value && selected.length) {
        event.preventDefault(); close(); field.querySelectorAll(".tag-picker-remove")[selected.length - 1].focus();
      } else if (event.key === "Tab") { commitTyped(); close(); }
    });
    field.addEventListener("click", (event) => { if (event.target === field) input.focus(); });
    host.addEventListener("focusout", (event) => { if (!rendering && !host.contains(event.relatedTarget)) { commitTyped(); close(); } });
    retry.addEventListener("click", () => { input.focus(); schedule(0); });
    input.form.addEventListener("reset", () => tagPickers.get(id).set([]));
    input.closest("dialog").addEventListener("close", close);
    input.closest("dialog").addEventListener("scroll", position, { passive: true });
    window.addEventListener("resize", position);
  }
  attachTagPicker("bookmark-tags");
  attachTagPicker("bulk-tags");

  async function openReader(id, recheck = false) {
    const scroll = recheck ? $("reader-dialog").scrollTop : 0;
    const request = ++state.readerRequest;
    layoutRequest++;
    state.reading = null;
    readerAssets = []; readerLayoutURL = "";
    state.readerSelection = null;
    $("reader-title").textContent = "Opening your bookmark…";
    $("reader-domain").textContent = "";
    $("reader-content").textContent = "";
    $("reader-content").hidden = false;
    $("reader-layout").hidden = true;
    $("reader-layout").removeAttribute("src");
    $("reader-layout-mode").setAttribute("aria-pressed", "false");
    $("reader-layout-mode").disabled = true;
    $("reader-print").disabled = true;
    $("reader-size").disabled = false;
    document.querySelectorAll("[data-highlight-selection]").forEach((button) => { button.disabled = true; });
    $("reader-text-mode").setAttribute("aria-pressed", "true");
    $("annotation-list").replaceChildren();
    $("asset-list").replaceChildren();
    state.annotations = [];
    $("reader-status").textContent = "";
    $("reader-mode-hint").textContent = "Checking saved HTML…";
    $("reader-recheck").hidden = true;
    for (const section of ["annotations", "assets"]) { $(section + "-error").hidden = true; $(section + "-retry").hidden = true; $(section + "-retry").disabled = false; }
    $("reader-notes").value = "";
    $("reader-notes-form").querySelector("button[type=submit]").disabled = false;
    $("reader-error").textContent = "";
    $("reader-original").hidden = true;
    $("reader-archive").hidden = true;
    $("reader-capture").disabled = true;
    $("reader-edit").disabled = true;
    $("reader-notes-form").hidden = true;
    if (!$("reader-dialog").open) $("reader-dialog").showModal();
    try {
      const link = await api(`/api/links/${id}`);
      if (request !== state.readerRequest || !$("reader-dialog").open) return;
      state.reading = link;
      $("reader-title").textContent = link.title || link.url;
      $("reader-domain").textContent = link.type === "file" ? "Saved file" : domain(link.url);
      $("reader-capture").hidden = link.type === "file";
      $("preserve-page").hidden = link.type === "file";
      const url = safeURL(link.url);
      $("reader-original").hidden = !url;
      if (url) $("reader-original").href = url;
      $("reader-archive").hidden = !link.archiveAvailable;
      $("reader-archive").href = `/api/links/${id}/archive`;
      $("reader-archive").setAttribute("download", "");
      $("reader-content").textContent = link.content || link.description || "No readable content captured yet. Visit the original page, or try refreshing the capture.";
      $("reader-status").textContent = { ready: "Captured text", failed: "Capture failed. Open Reading options to retry, or attach a snapshot under Files.", pending: "Capture queued. You can check its status here.", processing: "Capture in progress. You can check its status here." }[link.status] || "";
      $("reader-recheck").hidden = !["pending", "processing"].includes(link.status);
      const draft = drafts.get(draftKey(link));
      $("reader-notes").value = draft?.notes ?? link.notes ?? "";
      $("reader-notes-draft").hidden = !draft || draft.notes === (link.notes || "");
      $("reader-capture").disabled = false;
      $("reader-edit").disabled = false;
      $("reader-notes-form").hidden = false;
      document.querySelectorAll("[data-highlight-selection]").forEach((button) => { button.disabled = !link.content; });
      const loaded = await Promise.allSettled([loadAnnotations(id, request), loadAssets(id, request)]);
      if (request !== state.readerRequest || !$("reader-dialog").open) return;
      loaded.forEach((result, i) => { if (result.status === "rejected") readerSectionError(i ? "assets" : "annotations", result.reason); });
      if (recheck) $("reader-dialog").scrollTop = scroll;
    } catch (error) {
      if (request !== state.readerRequest) return;
      $("reader-title").textContent = "Could not open this bookmark";
      $("reader-error").textContent = error.message;
      $("reader-status").textContent = error.message;
    }
  }

  function readerSectionError(section, error) {
    $(section + "-error").textContent = `Could not load ${section === "assets" ? "saved files" : "highlights"}. ${error.message}`;
    $(section + "-error").hidden = false; $(section + "-retry").hidden = false;
    if (section === "assets") $("reader-mode-hint").textContent = "Could not check saved HTML. Retry saved files below; text view remains available.";
  }
  for (const section of ["annotations", "assets"]) $(section + "-retry").addEventListener("click", async () => {
    if (!state.reading) return;
    const id = state.reading.id, request = state.readerRequest;
    $(section + "-retry").disabled = true;
    try { await (section === "assets" ? loadAssets(id, request) : loadAnnotations(id, request)); if (request === state.readerRequest) { $(section + "-error").hidden = true; $(section + "-retry").hidden = true; } }
    catch (error) { if (request === state.readerRequest) readerSectionError(section, error); }
    finally { if (request === state.readerRequest) $(section + "-retry").disabled = false; }
  });
  $("reader-recheck").addEventListener("click", () => { if (state.reading) openReader(state.reading.id, true); });
  document.querySelectorAll("[data-reader-section]").forEach((button) => button.addEventListener("click", () => {
    const target = $(button.dataset.readerSection);
    if (target.id === "reader-content" && target.hidden) $("reader-text-mode").click();
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }));
  $("reader-notes").addEventListener("input", () => {
    if (!state.reading) return;
    const draft = drafts.get(draftKey(state.reading)) || editable(state.reading);
    draft.notes = $("reader-notes").value;
    drafts.put(draftKey(state.reading), draft, editable(state.reading));
    $("reader-notes-draft").hidden = draft.notes === (state.reading.notes || "");
  });
  $("discard-reader-notes").addEventListener("click", () => {
    if (!state.reading || !confirm("Discard these unsaved notes?")) return;
    $("reader-notes").value = state.reading.notes || "";
    $("reader-notes").dispatchEvent(new Event("input"));
  });

  $("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    $("login-error").textContent = "";
    try {
      if (setupRequired && $("login-password").value !== $("login-confirm").value) throw new Error("The passwords do not match.");
      await api(setupRequired ? "/api/setup" : "/api/login", { method: "POST", body: JSON.stringify({ username: $("login-username").value.trim(), password: $("login-password").value }) });
      setupRequired = false;
      configureLogin();
      $("login-confirm").value = "";
      $("login-password").value = "";
      state.signedIn = true;
      $("login-view").hidden = true;
      $("app-view").hidden = false;
      await restoreRoute(true);
      openSharedLink();
    } catch (error) { $("login-error").textContent = error.message; } finally { button.disabled = false; }
  });

  $("logout-button").addEventListener("click", async () => {
    if (drafts.size && !confirm("Sign out and discard the drafts kept in this tab?")) return;
    try { await api("/api/logout", { method: "POST" }); drafts.clear(); showLogin(); } catch (error) { toast(error.message, true); }
  });

  document.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => selectFilter(button.dataset.filter)));
  document.querySelectorAll(".close-dialog").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
  $("add-bookmark").addEventListener("click", () => openEditor());
  $("empty-add").addEventListener("click", () => openEditor());
  $("empty-reset").addEventListener("click", () => {
    clearTimeout(searchTimer); state.query = ""; $("search").value = "";
    selectFilter("all"); $("search").focus();
  });
  $("refresh-button").addEventListener("click", () => refresh());
  $("search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    state.request++;
    searchTimer = setTimeout(() => { state.query = $("search").value.trim(); state.page = 1; commitRoute(searchSession); searchSession = true; refresh(); }, 250);
  });
  $("search").addEventListener("blur", () => { searchSession = false; });
  $("previous-page").addEventListener("click", () => { state.page--; commitRoute(); refresh(); });
  $("next-page").addEventListener("click", () => { state.page++; commitRoute(); refresh(); });

  $("bookmark-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.submitter;
    const session = editorSession, editing = state.editing, key = draftKey(editing), submitted = editorValues();
    button.disabled = true;
    $("bookmark-error").textContent = "";
    const body = { url: $("bookmark-url").value.trim(), title: $("bookmark-title").value.trim(), description: $("bookmark-description").value.trim(), notes: $("bookmark-notes").value, collectionId: $("bookmark-collection").value ? Number($("bookmark-collection").value) : null, tags: [...new Set($("bookmark-tags").value.split(",").map((tag) => tag.trim()).filter(Boolean))], favorite: $("bookmark-favorite").checked, read: $("bookmark-read").checked };
    try {
      if (state.editing?.type !== "file" && !safeURL(body.url)) throw new Error("Please enter a complete http:// or https:// URL.");
      await api(state.editing ? `/api/links/${state.editing.id}` : "/api/links", { method: state.editing ? "PUT" : "POST", body: JSON.stringify(body) });
      const active = session === editorSession && $("bookmark-dialog").open;
      const latest = active ? editorValues() : drafts.get(key);
      const newer = latest && JSON.stringify(latest) !== JSON.stringify(submitted);
      if (newer) drafts.put(key, latest, body); else drafts.delete(key);
      if (active) {
        editorBaseline = body;
        $("bookmark-draft").hidden = !newer;
        if (!newer) $("bookmark-dialog").close();
      }
      toast(newer ? "Saved. Your newer edits remain a draft." : editing ? "Bookmark updated." : "Bookmark saved.");
      await refresh();
    } catch (error) { if (session === editorSession) $("bookmark-error").textContent = error.message; else toast(error.message, true); }
    finally { if (session === editorSession) button.disabled = false; }
  });

  $("add-collection").addEventListener("click", () => {
    openCollectionEditor();
  });
  $("collection-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    $("collection-error").textContent = "";
    try {
      const name = $("collection-name").value.trim();
      if (!name) throw new Error("Give your collection a name.");
      await api(state.editingCollection ? `/api/collections/${state.editingCollection.id}` : "/api/collections", { method: state.editingCollection ? "PUT" : "POST", body: JSON.stringify({ name, parentId: $("collection-parent").value ? Number($("collection-parent").value) : null }) });
      $("collection-dialog").close();
      await refresh();
      toast(state.editingCollection ? "Collection updated." : "Collection created.");
    } catch (error) { $("collection-error").textContent = error.message; } finally { button.disabled = false; }
  });

  $("reader-edit").addEventListener("click", () => {
    const link = state.reading;
    if (!link) return;
    $("reader-dialog").close();
    openEditor(link);
  });
  $("reader-capture").addEventListener("click", async () => {
    if (!state.reading) return;
    $("reader-capture").disabled = true;
    $("reader-error").textContent = "";
    try {
      await api(`/api/links/${state.reading.id}/capture`, { method: "POST" });
      $("reader-status").textContent = "Capture queued. Check its status here without closing the reader.";
      $("reader-recheck").hidden = false;
      toast("Capture queued.");
      await refresh(true);
    } catch (error) { $("reader-error").textContent = error.message; } finally { $("reader-capture").disabled = false; }
  });
  $("reader-notes-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.reading) return;
    const button = event.submitter;
    const link = state.reading, request = state.readerRequest, key = draftKey(link);
    button.disabled = true;
    $("reader-error").textContent = "";
    try {
      const notes = $("reader-notes").value;
      await api(`/api/links/${link.id}`, { method: "PUT", body: JSON.stringify({ ...editable(link), notes }) });
      link.notes = notes;
      const remaining = drafts.get(key) || (request === state.readerRequest ? editable(link) : null);
      if (remaining && request === state.readerRequest) remaining.notes = $("reader-notes").value;
      if (remaining) drafts.put(key, remaining, editable(link));
      if (request === state.readerRequest) $("reader-notes-draft").hidden = $("reader-notes").value === notes;
      toast("Notes saved.");
      await refresh(true);
    } catch (error) { if (request === state.readerRequest) $("reader-error").textContent = error.message; else toast(error.message, true); }
    finally { if (request === state.readerRequest) button.disabled = false; }
  });

  $("import-button").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", async () => {
    const file = $("import-file").files[0];
    if (!file) return;
    $("import-button").disabled = true;
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error("Choose an export smaller than 8 MiB.");
      const body = await file.text();
      const html = /\.html?$/i.test(file.name) || file.type === "text/html";
      if (!html) { try { JSON.parse(body); } catch { throw new Error("Choose a JSON export or a browser bookmarks HTML file."); } }
      const result = await api(html ? "/api/import/html" : "/api/import", { method: "POST", headers: { "Content-Type": html ? "text/html" : "application/json" }, body });
      toast(`Imported ${result.imported} bookmarks. ${result.skipped || 0} skipped.`);
      await refresh();
    } catch (error) { toast(error.message, true); } finally { $("import-button").disabled = false; $("import-file").value = ""; }
  });

  document.addEventListener("keydown", (event) => {
    if (!state.signedIn || event.ctrlKey || event.metaKey || event.altKey || document.querySelector("dialog[open]") || document.activeElement.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) return;
    if (event.key === "/") { event.preventDefault(); $(showingTags ? "tags-search" : "search").focus(); }
    if (event.key.toLowerCase() === "n") { event.preventDefault(); openEditor(); }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearTimeout(state.timer);
    else if (state.signedIn) refresh(true);
  });


  function openCollectionEditor(collection = null) {
    state.editingCollection = collection;
    $("collection-form").reset();
    $("collection-error").textContent = "";
    $("collection-dialog-title").textContent = collection ? "Rename or move collection" : "New collection";
    $("collection-name").value = collection?.name || "";
    fillCollections($("collection-parent"), collection?.parentId, "None — top level");
    if (collection) {
      const excluded = new Set([collection.id]);
      let changed = true;
      while (changed) { changed = false; for (const item of state.collections) if (excluded.has(item.parentId) && !excluded.has(item.id)) { excluded.add(item.id); changed = true; } }
      for (const option of [...$("collection-parent").options]) if (excluded.has(Number(option.value))) option.remove();
    }
    $("collection-dialog").showModal();
    $("collection-name").focus();
  }

  function updateSelection() {
    const count = state.links.filter((link) => state.selected.has(link.id)).length;
    const outside = state.selected.size - count;
    $("selected-count").textContent = `${state.selected.size} selected${outside ? ` · ${outside} outside these results` : ""}`;
    $("selected-count").hidden = !state.selected.size;
    $("bulk-open").hidden = !state.selected.size;
    $("bulk-open").disabled = !state.selected.size;
    $("clear-selection").hidden = !state.selected.size;
    $("select-page").checked = state.links.length > 0 && count === state.links.length;
    $("select-page").indeterminate = count > 0 && count < state.links.length;
  }
  $("select-page").addEventListener("change", () => {
    for (const link of state.links) {
      if (!$("select-page").checked) { state.selected.delete(link.id); selectionLabels.delete(link.id); }
      else if (state.selected.size < 500) { state.selected.add(link.id); selectionLabels.set(link.id, link.title || link.url); }
    }
    renderLinks();
  });
  $("clear-selection").addEventListener("click", () => { state.selected.clear(); selectionLabels.clear(); renderLinks(); });
  $("sort-order").addEventListener("change", () => { state.sort = $("sort-order").value; state.page = 1; commitRoute(); refresh(); });
  $("fuzzy-search").addEventListener("change", () => { state.fuzzy = $("fuzzy-search").checked; state.page = 1; commitRoute(); refresh(); });
  $("bulk-open").addEventListener("click", () => {
    $("bulk-form").reset();
    fillCollections($("bulk-collection"), state.filter === "collection" ? state.collection : null);
    $("bulk-error").textContent = "";
    $("bulk-title").textContent = `${state.selected.size} selected bookmark${state.selected.size === 1 ? "" : "s"}`;
    const visible = state.links.filter((link) => state.selected.has(link.id)).length;
    const outside = state.selected.size - visible;
    $("bulk-scope").textContent = outside ? `${outside} selected bookmark${outside === 1 ? " is" : "s are"} outside the current results. Review the full selection before applying an action.` : "This action applies to the bookmarks listed below.";
    $("bulk-review").open = outside > 0;
    $("bulk-items").replaceChildren(...[...state.selected].map((id) => el("li", "", selectionLabels.get(id) || `Bookmark ${id}`)));
    updateBulkAction();
    $("bulk-dialog").showModal();
    $("bulk-action").focus();
  });
  function updateBulkAction() {
    const action = $("bulk-action").value;
    $("bulk-move-fields").hidden = action !== "move";
    $("bulk-tags-fields").hidden = action !== "tags";
    $("bulk-value-fields").hidden = !["favorite", "read"].includes(action);
    $("bulk-value-label").textContent = action === "read" ? "Reading status" : "Favorite status";
    $("bulk-value").options[0].textContent = action === "read" ? "Read" : "Favorite";
    $("bulk-value").options[1].textContent = action === "read" ? "To read" : "Not favorite";
    const labels = { move: "Move", tags: "Replace tags on", favorite: "Update favorites for", read: "Update reading status for", capture: "Refresh captures for", delete: "Delete" };
    $("bulk-apply").textContent = action ? `${labels[action]} ${state.selected.size} bookmark${state.selected.size === 1 ? "" : "s"}` : "Choose an action";
    $("bulk-apply").disabled = !action;
  }
  $("bulk-action").addEventListener("change", updateBulkAction);
  $("bulk-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const action = $("bulk-action").value;
    if (action === "delete" && !confirm(`Delete ${state.selected.size} selected bookmarks and their saved content?`)) return;
    event.submitter.disabled = true;
    $("bulk-error").textContent = "";
    try {
      await api("/api/links/bulk", { method: "POST", body: JSON.stringify({ ids: [...state.selected], action, collectionId: $("bulk-collection").value ? Number($("bulk-collection").value) : null, tags: [...new Set($("bulk-tags").value.split(",").map((tag) => tag.trim()).filter(Boolean))], value: $("bulk-value").value === "true" }) });
      state.selected.clear();
      selectionLabels.clear();
      $("bulk-dialog").close();
      await refresh();
      toast("Selected bookmarks updated.");
    } catch (error) { $("bulk-error").textContent = error.message; } finally { event.submitter.disabled = false; }
  });

  function renderReaderText() {
    const content = state.reading?.content || "";
    const root = $("reader-content");
    root.replaceChildren();
    if (!content) { root.textContent = state.reading?.description || "No readable content captured yet."; return; }
    const points = Array.from(content);
    const notes = state.annotations.filter((item) => !item.stale && item.start >= 0 && item.end <= points.length && item.start < item.end && points.slice(item.start, item.end).join("") === item.quote);
    // Split overlapping highlights into bounded segments without trusting any captured markup.
    const boundaries = [...new Set([0, points.length, ...notes.flatMap((item) => [item.start, item.end])])].sort((a, b) => a - b);
    const fragment = document.createDocumentFragment();
    for (let i = 1; i < boundaries.length; i++) {
      const start = boundaries[i - 1], end = boundaries[i];
      const text = points.slice(start, end).join("");
      const note = notes.find((item) => item.start <= start && item.end >= end);
      if (!note) { fragment.append(document.createTextNode(text)); continue; }
      const mark = el("mark", `highlight-${["yellow", "green", "blue", "pink"].includes(note.color) ? note.color : "yellow"}`, text);
      mark.title = note.note || "Saved highlight";
      mark.addEventListener("click", () => editAnnotation(note));
      fragment.append(mark);
    }
    root.append(fragment);
  }

  async function loadAnnotations(id, request = state.readerRequest) {
    const annotations = await api(`/api/links/${id}/annotations`);
    if (request !== state.readerRequest || state.reading?.id !== id) return;
    state.annotations = annotations || [];
    renderReaderText();
    $("annotation-list").replaceChildren();
    for (const annotation of state.annotations) {
      const row = el("article", "annotation-item");
      row.append(el("blockquote", `highlight-${annotation.color}`, annotation.quote), el("p", "", annotation.note || "Highlight"));
      if (annotation.stale) row.append(el("p", "small muted", "The captured text has changed. This highlight belongs to an earlier capture."));
      const edit = el("button", "text-button", "Edit note");
      edit.addEventListener("click", () => editAnnotation(annotation));
      const remove = el("button", "text-button", "Delete");
      remove.addEventListener("click", async () => {
        if (!confirm("Delete this annotation?")) return;
        remove.disabled = true;
        try { await api(`/api/links/${id}/annotations/${annotation.id}`, { method: "DELETE" }); await loadAnnotations(id); }
        catch (error) { toast(error.message, true); remove.disabled = false; }
      });
      const actions = el("div", "reader-actions"); actions.append(edit, remove); row.append(actions);
      $("annotation-list").append(row);
    }
    if (!state.annotations.length) $("annotation-list").append(el("p", "small muted", "No highlights yet."));
  }

  function editAnnotation(annotation) {
    annotationSession++;
    $("annotation-form").querySelector("button[type=submit]").disabled = false;
    state.annotationDraft = annotation;
    $("annotation-quote").textContent = annotation.quote;
    $("annotation-note").value = annotation.note || "";
    $("annotation-color").value = annotation.color || "yellow";
    const draft = drafts.get(annotationKey());
    if (draft) { $("annotation-note").value = draft.note; $("annotation-color").value = draft.color; }
    $("annotation-draft-notice").hidden = !draft;
    $("annotation-error").textContent = "";
    $("annotation-dialog").showModal();
  }
  function annotationKey() { const item = state.annotationDraft; return `annotation:${state.reading?.id}:${item?.id || `${item?.start}:${item?.end}`}`; }
  $("annotation-form").addEventListener("input", () => {
    if (!state.annotationDraft) return;
    drafts.put(annotationKey(), { note: $("annotation-note").value, color: $("annotation-color").value }, { note: state.annotationDraft.note || "", color: state.annotationDraft.color || "yellow" });
  });
  $("annotation-color").addEventListener("change", () => $("annotation-form").dispatchEvent(new Event("input")));
  function rememberReaderSelection() {
    const selection = window.getSelection(), root = $("reader-content");
    if (!state.reading?.content || !selection?.rangeCount || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
    const prefix = range.cloneRange(); prefix.selectNodeContents(root); prefix.setEnd(range.startContainer, range.startOffset);
    const start = Array.from(prefix.toString()).length, quote = range.toString();
    if (!quote.trim()) return null;
    state.readerSelection = { linkId: state.reading.id, quote, start, end: start + Array.from(quote).length };
    return state.readerSelection;
  }
  document.addEventListener("selectionchange", rememberReaderSelection);
  $("reader-content").addEventListener("pointerdown", () => { state.readerSelection = null; });
  document.querySelectorAll("[data-highlight-selection]").forEach((button) => {
    button.addEventListener("pointerdown", (event) => { rememberReaderSelection(); event.preventDefault(); });
    button.addEventListener("click", () => {
      const passage = rememberReaderSelection() || state.readerSelection;
      if (!passage || passage.linkId !== state.reading?.id) { toast("Select a passage in the text reader first.", true); return; }
      editAnnotation({ quote: passage.quote, start: passage.start, end: passage.end, color: "yellow", note: "" });
    });
  });
  $("annotation-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.reading || !state.annotationDraft) return;
    const session = annotationSession, linkID = state.reading.id, request = state.readerRequest;
    const key = annotationKey(), draft = state.annotationDraft;
    const submitted = { note: $("annotation-note").value, color: $("annotation-color").value };
    event.submitter.disabled = true;
    $("annotation-error").textContent = "";
    try {
      const saved = await api(`/api/links/${linkID}/annotations${draft.id ? `/${draft.id}` : ""}`, { method: draft.id ? "PUT" : "POST", body: JSON.stringify({ quote: draft.quote, start: draft.start, end: draft.end, ...submitted }) });
      const latest = session === annotationSession ? { note: $("annotation-note").value, color: $("annotation-color").value } : drafts.get(key) || submitted;
      drafts.delete(key);
      const savedKey = `annotation:${linkID}:${saved.id}`;
      drafts.put(savedKey, latest, submitted);
      if (session === annotationSession) {
        state.annotationDraft = { ...draft, ...submitted, id: saved.id };
        if (!drafts.get(savedKey)) $("annotation-dialog").close();
      }
      if (request === state.readerRequest) await loadAnnotations(linkID, request);
      toast("Annotation saved.");
    } catch (error) { if (session === annotationSession) $("annotation-error").textContent = error.message; }
    finally { if (session === annotationSession) event.submitter.disabled = false; }
  });
  $("reader-size").addEventListener("change", () => { $("reader-content").style.fontSize = `${$("reader-size").value}px`; });
  function readerMode(layout) {
    state.readerSelection = null;
    $("reader-layout").hidden = !layout; $("reader-content").hidden = layout;
    if (!layout) $("reader-layout").removeAttribute("src");
    $("reader-layout-mode").setAttribute("aria-pressed", String(layout)); $("reader-text-mode").setAttribute("aria-pressed", String(!layout));
    $("reader-size").disabled = layout;
    document.querySelectorAll("[data-highlight-selection]").forEach((button) => { button.disabled = layout || !state.reading?.content; });
  }
  function readerAvailability() {
    if (!state.reading) return;
    const snapshot = workspace.readerSnapshot(state.reading, readerAssets);
    readerLayoutURL = snapshot.url;
    $("reader-layout-mode").disabled = !snapshot.url; $("reader-print").disabled = !snapshot.url;
    $("reader-mode-hint").textContent = snapshot.message;
    if (!snapshot.url) readerMode(false);
  }
  $("reader-layout-mode").addEventListener("click", async () => {
    if (!readerLayoutURL) return;
    const request = ++layoutRequest, url = readerLayoutURL;
    $("reader-layout-mode").disabled = true;
    $("reader-mode-hint").textContent = "Opening formatted view…";
    try {
      const response = await fetch(url, { method: "HEAD", credentials: "same-origin" });
      if (request !== layoutRequest || !$("reader-dialog").open) return;
      if (response.status === 401) { showLogin(); return; }
      if (!response.ok) throw new Error("Formatted view is unavailable. Read the text or retry after saving an HTML capture.");
      $("reader-layout").src = url; readerMode(true);
      $("reader-mode-hint").textContent = "Formatted page · Text size and highlighting are available in Text & highlights.";
    } catch (error) {
      if (request !== layoutRequest) return;
      readerMode(false); $("reader-mode-hint").textContent = error.message;
    } finally { if (request === layoutRequest) $("reader-layout-mode").disabled = !readerLayoutURL; }
  });
  $("reader-text-mode").addEventListener("click", () => { layoutRequest++; readerMode(false); readerAvailability(); });
  $("reader-print").addEventListener("click", () => {
    if (!readerLayoutURL) return;
    window.open(readerLayoutURL, "_blank", "noopener,noreferrer");
    toast("Use your browser’s Print command, then Save as PDF. Upload the PDF below to keep it here.");
  });

  async function loadAssets(id, request = state.readerRequest) {
    const assets = await api(`/api/links/${id}/assets`);
    if (request !== state.readerRequest || state.reading?.id !== id) return;
    readerAssets = assets || [];
    readerAvailability();
    $("asset-list").replaceChildren();
    for (const asset of assets || []) {
      const row = el("div", "asset-item");
      const download = el("a", "", asset.name); download.href = `/api/assets/${asset.id}`; download.setAttribute("download", "");
      row.append(download, el("span", "small muted", `${(asset.size / 1024).toFixed(1)} KiB`));
      if (asset.mediaType === "text/html" && asset.size <= 2 * 1024 * 1024) {
        const read = el("button", "text-button", "Read");
        read.addEventListener("click", () => { readerLayoutURL = `/api/links/${id}/reader?asset=${asset.id}`; $("reader-layout-mode").disabled = false; $("reader-print").disabled = false; $("reader-layout-mode").click(); });
        row.append(read);
      }
      const remove = el("button", "text-button", "Delete");
      remove.addEventListener("click", async () => {
        if (!confirm(`Delete saved file “${asset.name}”?`)) return;
        remove.disabled = true;
        try { await api(`/api/assets/${asset.id}`, { method: "DELETE" }); await loadAssets(id); }
        catch (error) { toast(error.message, true); remove.disabled = false; }
      });
      row.append(remove); $("asset-list").append(row);
    }
    if (!assets?.length) $("asset-list").append(el("p", "small muted", "No additional files saved."));
  }
  $("upload-file-button").addEventListener("click", () => $("library-file").click());
  $("library-file").addEventListener("change", async () => {
    const file = $("library-file").files[0];
    if (!file) return;
    $("upload-file-button").disabled = true;
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error("Choose a file smaller than 20 MiB.");
      const params = new URLSearchParams({ name: file.name });
      if (state.filter === "collection") params.set("collection", state.collection);
      const result = await api(`/api/files?${params}`, { method: "POST", headers: { "Content-Type": file.type || (/\.html?$/i.test(file.name) ? "text/html" : "application/octet-stream") }, body: file });
      await refresh(); toast("File saved to your library.");
      await openReader(result.link.id);
    } catch (error) { toast(error.message, true); } finally { $("library-file").value = ""; $("upload-file-button").disabled = false; }
  });
  $("asset-file").addEventListener("change", async () => {
    const file = $("asset-file").files[0];
    if (!file || !state.reading) return;
    const id = state.reading.id;
    $("asset-file").disabled = true;
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error("Choose a file smaller than 20 MiB.");
      await api(`/api/links/${id}/assets?name=${encodeURIComponent(file.name)}`, { method: "POST", headers: { "Content-Type": file.type || (/\.html?$/i.test(file.name) ? "text/html" : "application/octet-stream") }, body: file });
      await loadAssets(id); toast("File saved.");
    } catch (error) { toast(error.message, true); } finally { $("asset-file").value = ""; $("asset-file").disabled = false; }
  });
  $("preserve-page").addEventListener("click", async () => {
    if (!state.reading) return;
    const id = state.reading.id;
    $("preserve-page").disabled = true;
    try {
      const result = await api(`/api/links/${id}/preserve`, { method: "POST" });
      await loadAssets(id); toast(`Page saved with ${result.embedded || 0} resources.${result.omitted ? ` ${result.omitted} resources could not be embedded.` : ""}`);
    } catch (error) { toast(error.message, true); } finally { $("preserve-page").disabled = false; }
  });

  function configureLogin(passwordEnabled = true) {
    $("login-title").textContent = setupRequired ? "Create your account" : "Welcome back";
    $("login-description").textContent = setupRequired ? "Set up your personal Pocketmark library." : "Sign in to your Pocketmark library.";
    $("login-submit-label").textContent = setupRequired ? "Create account" : "Sign in";
    $("login-confirm-fields").hidden = !setupRequired;
    $("login-confirm").required = setupRequired;
    $("login-password").autocomplete = setupRequired ? "new-password" : "current-password";
    $("login-password").minLength = setupRequired ? 12 : 1;
    $("login-help").textContent = setupRequired ? "Choose a password of at least 12 characters. This instance has one personal account." : passwordEnabled ? "Use your Pocketmark username and password." : "Your existing library needs a password. Ask the server administrator to configure it using the account recovery instructions.";
    $("login-submit").disabled = !setupRequired && !passwordEnabled;
  }
  async function loadTokens() {
    const tokens = await api("/api/tokens");
    $("token-list").replaceChildren();
    if (!tokens?.length) $("token-list").append(el("p", "small muted", "No API keys yet."));
    for (const token of tokens || []) {
      const row = el("div", "asset-item"); row.append(el("span", "", token.name));
      const revoke = el("button", "text-button", "Revoke");
      revoke.addEventListener("click", async () => {
        if (!confirm(`Revoke “${token.name}”? Apps using it will lose access.`)) return;
        revoke.disabled = true;
        try { await api(`/api/tokens/${token.id}`, { method: "DELETE" }); await loadTokens(); }
        catch (error) { $("tokens-error").textContent = error.message; revoke.disabled = false; }
      });
      row.append(revoke); $("token-list").append(row);
    }
  }
  $("api-keys-button").addEventListener("click", async () => {
    $("tokens-error").textContent = "";
    $("new-token-value").value = ""; $("new-token").hidden = true;
    $("api-keys-dialog").showModal();
    try { await loadTokens(); } catch (error) { $("tokens-error").textContent = error.message; }
  });
  $("settings-button").addEventListener("click", async () => {
    $("settings-error").textContent = "";
    $("new-token-value").value = ""; $("new-token").hidden = true;
    $("account-password").value = "";
    $("settings-dialog").showModal();
    try {
      const account = await api("/api/account");
      $("account-username").value = account.username || "";
      $("account-status").textContent = account.passwordEnabled ? "Password sign-in is enabled." : "Password sign-in is not configured.";
    } catch (error) { $("settings-error").textContent = error.message; }
  });
  $("account-form").addEventListener("submit", async (event) => {
    event.preventDefault(); event.submitter.disabled = true; $("settings-error").textContent = "";
    try {
      await api("/api/account", { method: "PUT", body: JSON.stringify({ username: $("account-username").value.trim(), password: $("account-password").value }) });
      $("account-password").value = ""; $("account-status").textContent = "Password sign-in is enabled."; toast("Password updated.");
    } catch (error) { $("settings-error").textContent = error.message; } finally { event.submitter.disabled = false; }
  });
  $("token-form").addEventListener("submit", async (event) => {
    event.preventDefault(); event.submitter.disabled = true; $("tokens-error").textContent = "";
    try {
      const token = await api("/api/tokens", { method: "POST", body: JSON.stringify({ name: $("token-name").value.trim() }) });
      $("new-token-value").value = token.token; $("new-token").hidden = false; $("token-name").value = "";
      await loadTokens();
    } catch (error) { $("tokens-error").textContent = error.message; } finally { event.submitter.disabled = false; }
  });
  $("copy-token").addEventListener("click", async () => { try { await navigator.clipboard.writeText($("new-token-value").value); toast("Key copied."); } catch { $("new-token-value").select(); toast("Select and copy the key."); } });
  $("settings-dialog").addEventListener("close", () => { $("account-password").value = ""; });
  $("api-keys-dialog").addEventListener("close", () => { $("new-token-value").value = ""; $("new-token").hidden = true; });
  $("export-button").addEventListener("click", () => $("export-dialog").showModal());
  $("reader-dialog").addEventListener("close", () => { state.readerRequest++; layoutRequest++; $("reader-layout").removeAttribute("src"); });

  function openSharedLink() {
    const params = sharedParams;
    if (!params.has("share-url") && !params.has("share-text")) return;
    const text = params.get("share-text") || "";
    const candidate = params.get("share-url") || text.match(/https?:\/\/[^\s]+/)?.[0];
    const url = safeURL(candidate);
    if (!url) { toast("The shared content did not contain a web link.", true); return; }
    const title = params.get("share-title") || "";
    history.replaceState({ pocketmarkScroll: 0 }, "", location.pathname + workspace.routeSearch(route()));
    params.delete("share-url"); params.delete("share-text"); params.delete("share-title");
    openEditor(); $("bookmark-url").value = url; $("bookmark-title").value = title;
    $("bookmark-form").dispatchEvent(new Event("input"));
  }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

  async function init() {
    try {
      const setup = await api("/api/setup");
      setupRequired = setup.setupRequired;
      configureLogin(setup.passwordEnabled);
      if (setupRequired || !setup.passwordEnabled) { showLogin(); return; }
      const session = await api("/api/session");
      if (!session?.authenticated) { showLogin(); return; }
      state.signedIn = true;
      $("app-view").hidden = false;
      await restoreRoute(true);
      openSharedLink();
    } catch (error) { showLogin(); $("login-error").textContent = error.status === 401 ? "" : error.message; }
  }
  init();
})();
