"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const state = { filter: "all", collection: null, tag: "", query: "", page: 1, pageSize: 40, total: 0, links: [], collections: [], editing: null, reading: null, readerRequest: 0, request: 0, timer: null, signedIn: false, sort: "newest", fuzzy: false, selected: new Set(), editingCollection: null, annotations: [], annotationDraft: null, readerSelection: null };
  let toastTimer;
  let searchTimer;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

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
  applyTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
  document.querySelectorAll("[data-theme-toggle]").forEach((button) => button.addEventListener("click", () => {
    const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(theme);
    try { localStorage.setItem("pocketmark-theme", theme); } catch { /* Keep the session choice when storage is unavailable. */ }
  }));

  let libraryView = "list";
  try { if (localStorage.getItem("pocketmark-view") === "grid") libraryView = "grid"; } catch { /* Storage is optional. */ }
  function setLibraryView(view) {
    libraryView = view;
    $("bookmark-grid").classList.toggle("view-list", view === "list");
    for (const value of ["list", "grid"]) $("view-" + value).setAttribute("aria-pressed", String(view === value));
    try { localStorage.setItem("pocketmark-view", view); } catch { /* Private browsing may disallow storage. */ }
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

  function showLogin() {
    state.signedIn = false;
    state.request++;
    clearTimeout(state.timer);
    document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
    $("app-view").hidden = true;
    $("login-view").hidden = false;
    $("login-token").focus();
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
      if (response.status === 401 && path !== "/api/login") showLogin();
      throw new Error(body?.error || `Request failed (${response.status}).`);
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
    $("breadcrumb-current").textContent = title;
    const descriptions = { all: "Everything you save, in one place.", inbox: "Saved links waiting to be organized.", favorite: "The bookmarks you want to keep close.", unread: "Your reading list, ready when you are.", collection: "Bookmarks organized in this collection." };
    $("page-subtitle").textContent = state.tag ? `Bookmarks tagged #${state.tag}.` : descriptions[state.filter];
    document.querySelectorAll("[data-filter]").forEach((button) => {
      const active = !state.tag && button.dataset.filter === state.filter;
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
    });
  }

  function selectFilter(filter, collection = null, tag = "") {
    state.filter = filter;
    state.collection = collection;
    state.tag = tag;
    state.page = 1;
    state.selected.clear();
    updateHeading();
    renderCollections();
    refresh();
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
    $("collections").replaceChildren();
    if (!state.collections.length) $("collections").append(el("p", "small muted", "No collections yet."));
    for (const collection of orderedCollections()) {
      const row = el("div", "collection-row");
      row.style.marginLeft = `${Math.min(collection.depth, 5) * 9}px`;
      const button = el("button", "nav-item");
      button.classList.toggle("active", state.filter === "collection" && String(state.collection) === String(collection.id));
      button.append(icon("folder"), el("span", "collection-name", collection.name));
      if (button.classList.contains("active")) button.setAttribute("aria-current", "page");
      if (collection.parentId != null) button.title = `Inside ${collectionLabel(collection.parentId)}`;
      button.addEventListener("click", () => selectFilter("collection", collection.id));
      const remove = el("button", "icon-button delete-collection"); remove.append(icon("trash"));
      remove.title = `Delete ${collection.name}`;
      remove.setAttribute("aria-label", remove.title);
      remove.addEventListener("click", async () => {
        if (!confirm(`Delete “${collection.name}”? Its bookmarks will move to Inbox.`)) return;
        remove.disabled = true;
        try {
          await api(`/api/collections/${collection.id}`, { method: "DELETE" });
          if (state.filter === "collection") { state.filter = "all"; state.collection = null; state.page = 1; }
          await refresh();
          toast("Collection deleted. Bookmarks kept.");
        } catch (error) { toast(error.message, true); remove.disabled = false; }
      });
      const edit = el("button", "icon-button delete-collection"); edit.append(icon("edit"));
      edit.title = `Rename or move ${collection.name}`;
      edit.setAttribute("aria-label", edit.title);
      edit.addEventListener("click", () => openCollectionEditor(collection));
      row.append(button, edit, remove);
      $("collections").append(row);
    }
  }

  function renderTags(tags) {
    $("tags").replaceChildren();
    for (const tag of tags) {
      const button = el("button", "tag-button", `#${tag.name}`);
      button.classList.toggle("active", state.tag === tag.name);
      button.setAttribute("aria-pressed", String(state.tag === tag.name));
      button.title = `${tag.count} bookmark${tag.count === 1 ? "" : "s"}`;
      button.addEventListener("click", () => selectFilter("all", null, state.tag === tag.name ? "" : tag.name));
      $("tags").append(button);
    }
  }

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
      favorite.setAttribute("aria-label", favorite.title);
      favorite.setAttribute("aria-pressed", String(!!link.favorite));
      favorite.addEventListener("click", () => updateLink(link, { favorite: !link.favorite }, favorite));
      const select = el("input", "bookmark-select");
      select.type = "checkbox";
      select.checked = state.selected.has(link.id);
      select.setAttribute("aria-label", `Select ${link.title || link.url}`);
      select.addEventListener("change", () => {
        if (select.checked && state.selected.size >= 500) { select.checked = false; toast("Select up to 500 bookmarks at a time.", true); return; }
        if (select.checked) state.selected.add(link.id); else state.selected.delete(link.id);
        card.classList.toggle("is-selected", select.checked);
        updateSelection();
      });
      card.classList.toggle("is-selected", select.checked);
      top.append(select, avatar);
      const body = el("div", "card-body");
      const heading = el("h2", "card-title");
      const open = el("button", "", link.title || link.url);
      open.addEventListener("click", () => openReader(link.id));
      heading.append(open);
      body.append(heading, el("p", "card-domain", host));
      if (link.description) body.append(el("p", "card-description", link.description));
      const tags = el("div", "card-tags");
      for (const name of (link.tags || []).slice(0, 5)) {
        const tag = el("button", "card-tag", `#${name}`);
        tag.addEventListener("click", () => selectFilter("all", null, name));
        tags.append(tag);
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
    const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
    $("pagination").hidden = pages <= 1;
    $("page-label").textContent = `Page ${state.page} of ${pages}`;
    $("previous-page").disabled = state.page <= 1;
    $("next-page").disabled = state.page >= pages;
    $("results-label").textContent = `${state.total} bookmark${state.total === 1 ? "" : "s"}${state.query ? ` matching “${state.query}”` : " in this view"}`;
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
      state.collections = collections || [];
      $("total-count").textContent = stats.links;
      $("capture-label").textContent = stats.pending ? `${stats.pending} capture${stats.pending === 1 ? "" : "s"} in progress` : stats.failed ? `${stats.failed} capture${stats.failed === 1 ? " needs" : "s need"} attention` : "";
      updateHeading();
      renderCollections();
      renderTags(tags || []);
      renderLinks();
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
    $("bookmark-tags").value = (link?.tags || []).join(", ");
    $("bookmark-favorite").checked = !!link?.favorite;
    $("bookmark-read").checked = !!link?.read;
    fillCollections($("bookmark-collection"), link ? link.collectionId : state.filter === "collection" ? state.collection : null);
    $("bookmark-dialog").showModal();
    $("bookmark-url").focus();
  }

  async function openReader(id) {
    const request = ++state.readerRequest;
    state.reading = null;
    state.readerSelection = null;
    $("reader-title").textContent = "Opening your bookmark…";
    $("reader-domain").textContent = "";
    $("reader-content").textContent = "";
    $("reader-content").hidden = false;
    $("reader-layout").hidden = true;
    $("reader-layout").removeAttribute("src");
    $("reader-layout-mode").setAttribute("aria-pressed", "false");
    $("reader-text-mode").setAttribute("aria-pressed", "true");
    $("annotation-list").replaceChildren();
    $("asset-list").replaceChildren();
    state.annotations = [];
    $("reader-status").textContent = "";
    $("reader-notes").value = "";
    $("reader-error").textContent = "";
    $("reader-original").hidden = true;
    $("reader-archive").hidden = true;
    $("reader-capture").disabled = true;
    $("reader-edit").disabled = true;
    $("reader-notes-form").hidden = true;
    $("reader-dialog").showModal();
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
      $("reader-status").textContent = { ready: "Captured text · Some pages may require the original site.", failed: "Capture failed. The original link is still available.", pending: "Capture is queued. Reopen this bookmark in a moment.", processing: "Capture is in progress. Reopen this bookmark in a moment." }[link.status] || "";
      $("reader-notes").value = link.notes || "";
      $("reader-capture").disabled = false;
      $("reader-edit").disabled = false;
      $("reader-notes-form").hidden = false;
      await Promise.all([loadAnnotations(id, request), loadAssets(id, request)]);
    } catch (error) {
      if (request !== state.readerRequest) return;
      $("reader-title").textContent = "Could not open this bookmark";
      $("reader-error").textContent = error.message;
      $("reader-status").textContent = error.message;
    }
  }

  $("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    $("login-error").textContent = "";
    try {
      await api("/api/login", { method: "POST", body: JSON.stringify($("login-method").value === "password" ? { username: $("login-username").value, password: $("login-password").value } : { token: $("login-token").value }) });
      $("login-token").value = "";
      $("login-password").value = "";
      state.signedIn = true;
      $("login-view").hidden = true;
      $("app-view").hidden = false;
      await refresh();
      openSharedLink();
    } catch (error) { $("login-error").textContent = error.message; } finally { button.disabled = false; }
  });

  $("logout-button").addEventListener("click", async () => {
    try { await api("/api/logout", { method: "POST" }); showLogin(); } catch (error) { toast(error.message, true); }
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
    searchTimer = setTimeout(() => { state.query = $("search").value.trim(); state.page = 1; refresh(); }, 250);
  });
  $("previous-page").addEventListener("click", () => { state.page--; refresh(); });
  $("next-page").addEventListener("click", () => { state.page++; refresh(); });

  $("bookmark-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    $("bookmark-error").textContent = "";
    const body = { url: $("bookmark-url").value.trim(), title: $("bookmark-title").value.trim(), description: $("bookmark-description").value.trim(), notes: $("bookmark-notes").value, collectionId: $("bookmark-collection").value ? Number($("bookmark-collection").value) : null, tags: [...new Set($("bookmark-tags").value.split(",").map((tag) => tag.trim()).filter(Boolean))], favorite: $("bookmark-favorite").checked, read: $("bookmark-read").checked };
    try {
      if (state.editing?.type !== "file" && !safeURL(body.url)) throw new Error("Please enter a complete http:// or https:// URL.");
      await api(state.editing ? `/api/links/${state.editing.id}` : "/api/links", { method: state.editing ? "PUT" : "POST", body: JSON.stringify(body) });
      $("bookmark-dialog").close();
      toast(state.editing ? "Bookmark updated." : "Bookmark saved.");
      await refresh();
    } catch (error) { $("bookmark-error").textContent = error.message; } finally { button.disabled = false; }
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
      $("reader-status").textContent = "Capture queued. Reopen this bookmark in a moment to see the updated content.";
      toast("Capture queued.");
      await refresh(true);
    } catch (error) { $("reader-error").textContent = error.message; } finally { $("reader-capture").disabled = false; }
  });
  $("reader-notes-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.reading) return;
    const button = event.submitter;
    button.disabled = true;
    $("reader-error").textContent = "";
    try {
      const notes = $("reader-notes").value;
      await api(`/api/links/${state.reading.id}`, { method: "PUT", body: JSON.stringify({ ...editable(state.reading), notes }) });
      state.reading.notes = notes;
      toast("Notes saved.");
      await refresh(true);
    } catch (error) { $("reader-error").textContent = error.message; } finally { button.disabled = false; }
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
    if (event.key === "/") { event.preventDefault(); $("search").focus(); }
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
    $("selected-count").textContent = `${state.selected.size} selected`;
    $("selected-count").hidden = !state.selected.size;
    $("bulk-open").hidden = !state.selected.size;
    $("bulk-open").disabled = !state.selected.size;
    $("clear-selection").hidden = !state.selected.size;
    const count = state.links.filter((link) => state.selected.has(link.id)).length;
    $("select-page").checked = state.links.length > 0 && count === state.links.length;
    $("select-page").indeterminate = count > 0 && count < state.links.length;
  }
  $("select-page").addEventListener("change", () => {
    for (const link of state.links) {
      if (!$("select-page").checked) state.selected.delete(link.id);
      else if (state.selected.size < 500) state.selected.add(link.id);
    }
    renderLinks();
  });
  $("clear-selection").addEventListener("click", () => { state.selected.clear(); renderLinks(); });
  $("sort-order").addEventListener("change", () => { state.sort = $("sort-order").value; state.page = 1; refresh(); });
  $("fuzzy-search").addEventListener("change", () => { state.fuzzy = $("fuzzy-search").checked; state.page = 1; refresh(); });
  $("bulk-open").addEventListener("click", () => {
    fillCollections($("bulk-collection"), state.filter === "collection" ? state.collection : null);
    $("bulk-error").textContent = "";
    $("bulk-dialog").showModal();
  });
  $("bulk-action").addEventListener("change", () => {
    const action = $("bulk-action").value;
    $("bulk-move-fields").hidden = action !== "move";
    $("bulk-tags-fields").hidden = action !== "tags";
    $("bulk-value-fields").hidden = !["favorite", "read"].includes(action);
  });
  $("bulk-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const action = $("bulk-action").value;
    if (action === "delete" && !confirm(`Delete ${state.selected.size} selected bookmarks and their saved content?`)) return;
    event.submitter.disabled = true;
    $("bulk-error").textContent = "";
    try {
      await api("/api/links/bulk", { method: "POST", body: JSON.stringify({ ids: [...state.selected], action, collectionId: $("bulk-collection").value ? Number($("bulk-collection").value) : null, tags: [...new Set($("bulk-tags").value.split(",").map((tag) => tag.trim()).filter(Boolean))], value: $("bulk-value").value === "true" }) });
      state.selected.clear();
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
    state.annotationDraft = annotation;
    $("annotation-quote").textContent = annotation.quote;
    $("annotation-note").value = annotation.note || "";
    $("annotation-color").value = annotation.color || "yellow";
    $("annotation-error").textContent = "";
    $("annotation-dialog").showModal();
  }
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
  $("annotate-selection").addEventListener("pointerdown", (event) => { rememberReaderSelection(); event.preventDefault(); });
  $("annotate-selection").addEventListener("click", () => {
    const passage = rememberReaderSelection() || state.readerSelection;
    if (!passage || passage.linkId !== state.reading?.id) { toast("Select a passage in the text reader first.", true); return; }
    editAnnotation({ quote: passage.quote, start: passage.start, end: passage.end, color: "yellow", note: "" });
  });
  $("annotation-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.reading || !state.annotationDraft) return;
    event.submitter.disabled = true;
    $("annotation-error").textContent = "";
    try {
      const draft = state.annotationDraft;
      await api(`/api/links/${state.reading.id}/annotations${draft.id ? `/${draft.id}` : ""}`, { method: draft.id ? "PUT" : "POST", body: JSON.stringify({ quote: draft.quote, start: draft.start, end: draft.end, note: $("annotation-note").value, color: $("annotation-color").value }) });
      $("annotation-dialog").close();
      await loadAnnotations(state.reading.id);
      toast("Annotation saved.");
    } catch (error) { $("annotation-error").textContent = error.message; } finally { event.submitter.disabled = false; }
  });
  $("reader-size").addEventListener("change", () => { $("reader-content").style.fontSize = `${$("reader-size").value}px`; });
  $("reader-layout-mode").addEventListener("click", () => {
    if (!state.reading) return;
    $("reader-layout").src = `/api/links/${state.reading.id}/reader`;
    $("reader-layout").hidden = false; $("reader-content").hidden = true;
    $("reader-layout-mode").setAttribute("aria-pressed", "true"); $("reader-text-mode").setAttribute("aria-pressed", "false");
  });
  $("reader-text-mode").addEventListener("click", () => {
    $("reader-layout").hidden = true; $("reader-content").hidden = false;
    $("reader-layout").removeAttribute("src");
    $("reader-layout-mode").setAttribute("aria-pressed", "false"); $("reader-text-mode").setAttribute("aria-pressed", "true");
  });
  $("reader-print").addEventListener("click", () => {
    if (!state.reading) return;
    window.open(`/api/links/${state.reading.id}/reader`, "_blank", "noopener,noreferrer");
    toast("Use your browser’s Print command, then Save as PDF. Upload the PDF below to keep it here.");
  });

  async function loadAssets(id, request = state.readerRequest) {
    const assets = await api(`/api/links/${id}/assets`);
    if (request !== state.readerRequest || state.reading?.id !== id) return;
    $("asset-list").replaceChildren();
    for (const asset of assets || []) {
      const row = el("div", "asset-item");
      const download = el("a", "", asset.name); download.href = `/api/assets/${asset.id}`; download.setAttribute("download", "");
      row.append(download, el("span", "small muted", `${(asset.size / 1024).toFixed(1)} KiB`));
      if (asset.mediaType === "text/html" && asset.size <= 2 * 1024 * 1024) {
        const read = el("button", "text-button", "Read");
        read.addEventListener("click", () => { $("reader-layout").src = `/api/links/${id}/reader?asset=${asset.id}`; $("reader-layout").hidden = false; $("reader-content").hidden = true; $("reader-layout-mode").setAttribute("aria-pressed", "true"); $("reader-text-mode").setAttribute("aria-pressed", "false"); });
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

  $("login-method").addEventListener("change", () => {
    const password = $("login-method").value === "password";
    $("login-password-fields").hidden = !password; $("login-token-fields").hidden = password;
    $("login-token").required = !password; $("login-username").required = password; $("login-password").required = password;
  });
  async function loadTokens() {
    const tokens = await api("/api/tokens");
    $("token-list").replaceChildren();
    for (const token of tokens || []) {
      const row = el("div", "asset-item"); row.append(el("span", "", token.name));
      const revoke = el("button", "text-button", "Revoke");
      revoke.addEventListener("click", async () => {
        if (!confirm(`Revoke “${token.name}”? Apps using it will lose access.`)) return;
        revoke.disabled = true;
        try { await api(`/api/tokens/${token.id}`, { method: "DELETE" }); await loadTokens(); }
        catch (error) { $("settings-error").textContent = error.message; revoke.disabled = false; }
      });
      row.append(revoke); $("token-list").append(row);
    }
  }
  $("settings-button").addEventListener("click", async () => {
    $("settings-error").textContent = "";
    $("new-token-value").value = ""; $("new-token").hidden = true;
    $("account-password").value = "";
    $("settings-dialog").showModal();
    try {
      const account = await api("/api/account");
      $("account-username").value = account.username || "";
      $("account-status").textContent = account.passwordEnabled ? "Password sign-in is enabled." : "Password sign-in is not configured.";
      await loadTokens();
    } catch (error) { $("settings-error").textContent = error.message; }
  });
  $("account-form").addEventListener("submit", async (event) => {
    event.preventDefault(); event.submitter.disabled = true; $("settings-error").textContent = "";
    try {
      await api("/api/account", { method: "PUT", body: JSON.stringify({ username: $("account-username").value.trim(), password: $("account-password").value }) });
      $("account-password").value = ""; $("account-status").textContent = "Password sign-in is enabled."; toast("Password updated.");
    } catch (error) { $("settings-error").textContent = error.message; } finally { event.submitter.disabled = false; }
  });
  $("disable-password").addEventListener("click", async () => {
    if (!confirm("Disable password sign-in? Keep your master access token for future sign-ins.")) return;
    $("disable-password").disabled = true;
    try {
      await api("/api/account", { method: "PUT", body: JSON.stringify({ username: $("account-username").value.trim(), password: "" }) });
      $("account-status").textContent = "Password sign-in is disabled."; toast("Password sign-in disabled.");
    } catch (error) { $("settings-error").textContent = error.message; } finally { $("disable-password").disabled = false; }
  });
  $("token-form").addEventListener("submit", async (event) => {
    event.preventDefault(); event.submitter.disabled = true; $("settings-error").textContent = "";
    try {
      const token = await api("/api/tokens", { method: "POST", body: JSON.stringify({ name: $("token-name").value.trim() }) });
      $("new-token-value").value = token.token; $("new-token").hidden = false; $("token-name").value = "";
      await loadTokens();
    } catch (error) { $("settings-error").textContent = error.message; } finally { event.submitter.disabled = false; }
  });
  $("copy-token").addEventListener("click", async () => { try { await navigator.clipboard.writeText($("new-token-value").value); toast("Key copied."); } catch { $("new-token-value").select(); toast("Select and copy the key."); } });
  $("settings-dialog").addEventListener("close", () => { $("new-token-value").value = ""; $("new-token").hidden = true; $("account-password").value = ""; });
  $("export-button").addEventListener("click", () => $("export-dialog").showModal());
  $("reader-dialog").addEventListener("close", () => { state.readerRequest++; $("reader-layout").removeAttribute("src"); });

  function openSharedLink() {
    const params = new URLSearchParams(location.search);
    if (!params.has("share-url") && !params.has("share-text")) return;
    const text = params.get("share-text") || "";
    const candidate = params.get("share-url") || text.match(/https?:\/\/[^\s]+/)?.[0];
    const url = safeURL(candidate);
    if (!url) { toast("The shared content did not contain a web link.", true); return; }
    const title = params.get("share-title") || "";
    history.replaceState(null, "", location.pathname);
    openEditor(); $("bookmark-url").value = url; $("bookmark-title").value = title;
  }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

  async function init() {
    try {
      const session = await api("/api/session");
      if (!session?.authenticated) { showLogin(); return; }
      state.signedIn = true;
      $("app-view").hidden = false;
      await refresh();
      openSharedLink();
    } catch (error) { showLogin(); $("login-error").textContent = error.message; }
  }
  init();
})();
