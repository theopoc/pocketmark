"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const state = { filter: "all", collection: null, tag: "", query: "", page: 1, pageSize: 40, total: 0, links: [], collections: [], editing: null, request: 0, timer: null, signedIn: false, sort: "newest", fuzzy: false, editingCollection: null };
  let toastTimer;
  let expandedBookmarkActions = null;
  let searchTimer;
  let tagsTimer;
  let tagsPage = 1;
  let tagsRequest = 0;
  let showingTags = false;
  const workspace = globalThis.PocketmarkWorkspace;
  const { editableBookmark: editable, bookmarkDraftKey: draftKey, safeURL, domain } = workspace;
  let draftStorage;
  try { draftStorage = window.sessionStorage; } catch { /* Private browsing may deny storage. */ }
  const drafts = workspace.createDrafts(draftStorage);
  const tagPickers = new Map();
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const activeMotion = new Map();
  let themeTransition = null;
  let renderedLibraryRoute = null;
  const sharedParams = new URLSearchParams(location.search);
  let editorBaseline = null;
  let editorSession = 0;
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
    if (!initial && previous !== workspace.routeSearch(route())) bulk.clear();
    reader.close();
    bulk.close();
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

  function toast(message, error = false, action = null) {
    clearTimeout(toastTimer);
    const notice = $("toast");
    // Native dialogs live in the top layer. Feedback must be in that same
    // layer to be visible and exposed to assistive technology.
    const dialogs = [...document.querySelectorAll("dialog[open]")];
    (dialogs.at(-1) || document.body).append(notice);
    notice.replaceChildren(el("span", "", message));
    notice.className = error ? "error" : "";
    notice.setAttribute("role", error ? "alert" : "status");
    if (action) {
      const button = el("button", "toast-action", action.label);
      button.type = "button";
      button.addEventListener("click", async () => {
        clearTimeout(toastTimer);
        button.disabled = true;
        try { await action.run(); } catch (error) { toast(error.message, true); }
      });
      notice.append(button);
    }
    notice.hidden = false;
    toastTimer = setTimeout(() => { notice.hidden = true; }, action || error ? 12000 : 5000);
  }
  document.querySelectorAll("dialog").forEach((dialog) => dialog.addEventListener("close", () => {
    if (dialog.contains($("toast"))) {
      clearTimeout(toastTimer);
      $("toast").hidden = true;
      document.body.append($("toast"));
    }
  }));

  let setupRequired = false;
  function showLogin() {
    clearTimeout(tagsTimer);
    tagsRequest++;
    state.signedIn = false;
    bulk.clear();
    state.request++;
    clearTimeout(state.timer);
    reader.close();
    bulk.close();
    document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
    $("app-view").hidden = true;
    $("login-view").hidden = false;
    $("login-username").focus();
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    let response;
    try { response = await fetch(path, { ...options, headers, credentials: "same-origin" }); }
    catch { throw new Error(workspace.requestFailure(0)); }
    let body = null;
    if (response.status !== 204) {
      let text;
      try { text = await response.text(); }
      catch { throw new Error(workspace.requestFailure(0)); }
      if (text) {
        try { body = JSON.parse(text); } catch { throw new Error("The server returned an unexpected response. Please try again."); }
      }
    }
    if (!response.ok) {
      if (response.status === 401 && path !== "/api/login" && path !== "/api/setup") {
        const expired = state.signedIn;
        showLogin();
        if (expired) $("login-error").textContent = workspace.requestFailure(401);
      }
      const message = response.status === 401 && ["/api/login", "/api/setup"].includes(path) ? (body?.error || "Check your username and password, then try again.") : workspace.requestFailure(response.status, body?.error);
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return body;
  }

  const reader = globalThis.PocketmarkReader.create({
    api, drafts, toast, onEdit: openEditor, onChange: () => refresh(true), onSessionExpired: showLogin,
  });

  const bulk = globalThis.PocketmarkBulk.create({
    api, toast, onChange: () => refresh(true), onSelectionChange: renderLinks, fillCollections,
    defaultCollection: () => state.filter === "collection" ? state.collection : null, onSessionExpired: showLogin,
  });

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
    const target = [...root.querySelectorAll("[data-focus-key]")].find((node) => node.dataset.focusKey === key);
    (target || root.querySelector(".card-title button") || $("page-title")).focus({ preventScroll: true });
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
    bulk.clear();
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
      const field = Object.hasOwn(changes, "favorite") ? "favorite" : "read";
      const message = field === "favorite" ? (changes.favorite ? "Added to favorites." : "Removed from favorites.") : (changes.read ? "Marked as read." : "Marked unread.");
      toast(message, false, { label: "Undo", run: async () => {
        // Restore only the toggled field, preserving any newer notes or tags.
        const latest = await api(`/api/links/${link.id}`);
        if (latest[field] !== changes[field]) { toast("This bookmark has changed. Its current state was kept."); return; }
        await api(`/api/links/${link.id}`, { method: "PUT", body: JSON.stringify({ ...editable(latest), [field]: link[field] }) });
        await refresh();
        toast("Change undone.");
      } });
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
      select.checked = bulk.has(link.id);
      select.dataset.focusKey = `link:${link.id}:select`;
      select.setAttribute("aria-label", `Select ${link.title || link.url}`);
      select.addEventListener("change", () => {
        select.checked = bulk.select(link, select.checked);
        card.classList.toggle("is-selected", select.checked);
      });
      card.classList.toggle("is-selected", select.checked);
      const selectTarget = el("label", "bookmark-select-target");
      selectTarget.append(select);
      top.append(selectTarget, avatar);
      const body = el("div", "card-body");
      const heading = el("h2", "card-title");
      const open = el("button", "", link.title || link.url);
      open.dataset.focusKey = `link:${link.id}:open`;
      open.addEventListener("click", () => reader.open(link.id));
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
      favorite.append(el("span", "mobile-action-label", "Favorite"));
      const moreActions = el("button", "card-actions-toggle button subtle", "Actions");
      moreActions.type = "button";
      moreActions.dataset.focusKey = `link:${link.id}:more`;
      moreActions.setAttribute("aria-label", `Actions for ${link.title || link.url}`);
      const overflow = el("div", "card-overflow-actions");
      overflow.id = `link-${link.id}-actions`;
      const expanded = expandedBookmarkActions === link.id;
      overflow.classList.toggle("is-open", expanded);
      moreActions.setAttribute("aria-controls", overflow.id);
      moreActions.setAttribute("aria-expanded", String(expanded));
      moreActions.addEventListener("click", () => {
        expandedBookmarkActions = expandedBookmarkActions === link.id ? null : link.id;
        renderLinks();
      });
      actions.append(favorite, moreActions, overflow);
      overflow.append(actionButton(link.read ? "check" : "clock", link.read ? "Mark unread" : "Mark as read", (event) => updateLink(link, { read: !link.read }, event.currentTarget), link.read ? "read" : ""));
      overflow.append(actionButton("edit", "Edit bookmark", () => openEditor(link)));
      overflow.append(actionButton("trash", "Delete bookmark", async (event) => {
        if (!confirm(`Delete “${link.title || link.url}” and its saved content?`)) return;
        const button = event.currentTarget;
        button.disabled = true;
        try {
          await api(`/api/links/${link.id}`, { method: "DELETE" });
          bulk.select(link, false);
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
        overflow.append(original);
      }
      footer.append(actions);
      actions.querySelectorAll("button,a").forEach((button, i) => {
        if (button === moreActions) return;
        button.dataset.focusKey = `link:${link.id}:action:${button === favorite ? 0 : i - 1}`;
        if (button !== favorite) button.append(el("span", "mobile-action-label", button.title));
        button.setAttribute("aria-label", `${button.title}: ${link.title || link.url}`);
      });
      card.append(top, body, footer);
      grid.append(card);
    }
    bulk.render(state.links);
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
    validateBookmarkFields();
    $("bookmark-dialog").showModal();
    $("bookmark-url").focus();
  }

  function editorValues() {
    return { url: $("bookmark-url").value, title: $("bookmark-title").value, description: $("bookmark-description").value, notes: $("bookmark-notes").value, collectionId: $("bookmark-collection").value ? Number($("bookmark-collection").value) : null, tags: [...new Set($("bookmark-tags").value.split(",").map((tag) => tag.trim()).filter(Boolean))], favorite: $("bookmark-favorite").checked, read: $("bookmark-read").checked };
  }
  function validateBookmarkFields() {
    const issues = workspace.bookmarkIssues({ ...editorValues(), type: state.editing?.type });
    for (const field of ["url", "title", "description", "notes", "tags"]) {
      $("bookmark-" + field + (field === "tags" ? "-query" : "")).setCustomValidity(issues[field] || "");
    }
    return issues;
  }
  function fillEditor(value) {
    for (const field of ["url", "title", "description", "notes"]) $("bookmark-" + field).value = value[field] || "";
    tagPickers.get("bookmark-tags").set(value.tags || []);
    fillCollections($("bookmark-collection"), value.collectionId);
    $("bookmark-favorite").checked = !!value.favorite; $("bookmark-read").checked = !!value.read;
    validateBookmarkFields();
  }
  $("bookmark-form").addEventListener("input", () => {
    if (!editorBaseline) return;
    validateBookmarkFields();
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
    tagPickers.set(id, globalThis.PocketmarkTagPicker.create({ id, api, icon, move }));
  }
  attachTagPicker("bookmark-tags");
  attachTagPicker("bulk-tags");

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
    if (Object.keys(validateBookmarkFields()).length) { $("bookmark-form").reportValidity(); return; }
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

  $("sort-order").addEventListener("change", () => { state.sort = $("sort-order").value; state.page = 1; commitRoute(); refresh(); });
  $("fuzzy-search").addEventListener("change", () => { state.fuzzy = $("fuzzy-search").checked; state.page = 1; commitRoute(); refresh(); });
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
      await reader.open(result.link.id);
    } catch (error) { toast(error.message, true); } finally { $("library-file").value = ""; $("upload-file-button").disabled = false; }
  });
  function updateHelp() {
    const query = $("help-search").value.trim().toLocaleLowerCase();
    let matches = 0;
    document.querySelectorAll("#help-topics > details").forEach((topic) => {
      const match = !query || topic.textContent.toLocaleLowerCase().includes(query);
      topic.hidden = !match;
      topic.open = !!query && match;
      if (match) matches++;
    });
    $("help-results").textContent = query ? `${matches} topic${matches === 1 ? "" : "s"} found` : "";
    $("help-empty").hidden = matches > 0;
  }
  $("help-search").addEventListener("input", updateHelp);
  $("help-clear").addEventListener("click", () => { $("help-search").value = ""; updateHelp(); $("help-search").focus(); });
  $("help-button").addEventListener("click", () => {
    $("help-search").value = ""; updateHelp();
    $("help-dialog").showModal();
    document.querySelector("#help-dialog .help-body").scrollTop = 0;
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
