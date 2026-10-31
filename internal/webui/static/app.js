"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const state = { filter: "all", collection: null, tag: "", query: "", page: 1, pageSize: 40, total: 0, links: [], collections: [], editing: null, request: 0, timer: null, signedIn: false, sort: "newest", editingCollection: null };
  let toastTimer, toastActionPending = false;
  let expandedBookmarkActions = null;
  const expandedBookmarkTags = new Set();
  let searchTimer;
  let tagsTimer;
  let tagsPage = 1;
  let tagsRequest = 0;
  let showingTags = false;
  let settingsSection = null;
  let libraryReturnScroll = 0;
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
  let libraryUnavailable = false;
  let libraryLoading = false;
  const sharedParams = new URLSearchParams(location.search);
  let editorBaseline = null;
  let editorSession = 0;
  let routeRequest = 0;
  let mfaManagementBusy = false;
  let deferredLogin = false;
  let deferredLoginNotice = "";
  let scrollTimer;
  let searchSession = false;
  let tagsSearchSession = false;
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";

  function route() {
    return { ...state, settingsSection, showingTags, tagsPage, tagsQuery: $("tags-search").value.trim() };
  }
  function rememberScroll() {
    clearTimeout(scrollTimer);
    history.replaceState({ ...history.state, pocketmarkScroll: window.scrollY }, "");
  }
  function commitRoute(replace = false, destination = route()) {
    const url = location.pathname + workspace.routeSearch(destination);
    if (url === location.pathname + location.search) return;
    routeRequest++;
    rememberScroll();
    history[replace ? "replaceState" : "pushState"]({ pocketmarkScroll: 0 }, "", url);
  }
  async function restoreRoute(initial = false) {
    const request = ++routeRequest;
    clearTimeout(searchTimer); clearTimeout(tagsTimer);
    const restored = workspace.readRoute(location.search);
    if (settingsSection && (mfaManagementBusy || deferredLogin) && restored.settingsSection !== settingsSection) {
      history.replaceState({ ...history.state }, "", location.pathname + workspace.routeSearch(route()));
      return;
    }
    const wasSettings = Boolean(settingsSection);
    if (!wasSettings && restored.settingsSection) libraryReturnScroll = history.state?.pocketmarkLibraryScroll || 0;
    settingsSection = restored.settingsSection;
    if (wasSettings && !settingsSection) clearSettings();
    renderSettings(!initial);
    const scroll = history.state?.pocketmarkScroll || 0;
    const previous = workspace.routeSearch(route());
    Object.assign(state, { filter: restored.filter, collection: restored.collection, tag: restored.tag, query: restored.query, page: restored.page, sort: restored.sort });
    showingTags = restored.showingTags; tagsPage = restored.tagsPage;
    $("search").value = state.query; $("tags-search").value = restored.tagsQuery;
    syncSortMenu(); closeSortMenu();
    $("tags-view").hidden = !showingTags; $("library-view").hidden = showingTags;
    if (!initial && previous !== workspace.routeSearch(route())) bulk.clear();
    reader.close();
    bulk.close();
    document.querySelectorAll("dialog[open]").forEach((dialog) => {
      dialog.close();
    });
    if (settingsSection) {
      clearTimeout(state.timer); state.request++;
      focusSettings();
      if (!wasSettings) await loadSettings();
      return;
    }
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
  document.querySelector(".skip-link").addEventListener("click", (event) => {
    event.preventDefault();
    $("main-content").focus();
  });
  window.addEventListener("beforeunload", (event) => {
    if (drafts.size || mfaManagementBusy || (Boolean(settingsSection) && !$("mfa-manage-codes").hidden)) { event.preventDefault(); event.returnValue = ""; }
  });

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
    info: ["M12 11v6M12 7h.01", "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0"],
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
    sort: ["M3 5h10M3 10h7M3 15h4", "M17 4v16m-4-4 4 4 4-4"],
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
    "panel-open": ["M4 4h16v16H4zM9 4v16", "m14 9 3 3-3 3"],
    "panel-close": ["M4 4h16v16H4zM9 4v16", "m17 9-3 3 3 3"],
    menu: ["M4 6h16M4 12h16M4 18h16"], lock: ["M5 10h14v11H5V10Z", "M8 10V6a4 4 0 0 1 8 0v4"],
    "chevron-right": ["m9 5 7 7-7 7"], "arrow-right": ["M4 12h16m-6-6 6 6-6 6"],
    "arrow-left": ["M20 12H4m6-6-6 6 6 6"],
    book: ["M12 5C8 2 4 3 2 4v16c3-2 7-2 10 0 3-2 7-2 10 0V4c-2-1-6-2-10 1ZM12 5v15"],
    help: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z", "M9 9a3 3 0 1 1 4.5 2.6C12.5 12.2 12 13 12 14", "M12 17h.01"],
    html: ["M4 3h16v18H4Z", "M4 8h16M7 5.5h.01M10 5.5h.01", "m9 12-3 3 3 3m6-6 3 3-3 3"],
    image: ["M3 3h18v18H3Z", "m3 17 6-6 5 5 3-3 4 4", "M17 7h.01"],
    pdf: ["M5 3h9l5 5v13H5Z", "M14 3v5h5M8 12h8M8 16h5"],
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
  function arrangeBookmarkCard(card) {
    const top = card.querySelector(".card-top");
    const titleRow = card.querySelector(".card-title-row");
    const favorite = card.querySelector(".favorite-button");
    const host = card.querySelector(".card-domain");
    if (libraryView === "grid") {
      top.append(host, favorite);
      const thumbnail = card.querySelector(".card-thumbnail");
      if (thumbnail && !thumbnail.src) thumbnail.src = thumbnail.dataset.src;
    }
    else { titleRow.prepend(favorite); titleRow.after(host); }
  }
  function setLibraryView(view) {
    const changed = $("bookmark-grid").classList.contains("view-list") !== (view === "list");
    libraryView = view;
    $("bookmark-grid").classList.toggle("view-list", view === "list");
    $("bookmark-grid").querySelectorAll(".bookmark-card").forEach(arrangeBookmarkCard);
    for (const value of ["list", "grid"]) $("view-" + value).setAttribute("aria-pressed", String(view === value));
    try { localStorage.setItem("pocketmark-view", view); } catch { /* Private browsing may disallow storage. */ }
    if (changed && state.signedIn) move($("bookmark-grid"), [{ opacity: .8 }, { opacity: 1 }]);
  }
  $("view-list").addEventListener("click", () => setLibraryView("list"));
  $("view-grid").addEventListener("click", () => setLibraryView("grid"));
  setLibraryView(libraryView);

  const navigation = $("navigation-dialog");
  const sidebar = $("sidebar");
  const desktopNavigation = matchMedia("(min-width: 901px) and (hover: hover) and (pointer: fine)");
  const sidebarRail = document.createElement("div");
  sidebarRail.className = "sidebar-rail";
  let sidebarFixed = false;
  try { sidebarFixed = localStorage.getItem("pocketmark-sidebar") === "fixed"; } catch { /* Storage is optional. */ }
  function renderSidebarMode() {
    $("app-view").classList.toggle("sidebar-fixed", desktopNavigation.matches && sidebarFixed);
    const button = $("sidebar-mode");
    const label = sidebarFixed ? "Hide navigation automatically" : "Keep navigation open";
    button.setAttribute("aria-pressed", String(sidebarFixed));
    button.setAttribute("aria-label", label);
    button.title = label;
    $("sidebar-mode-icon").replaceChildren(icon(sidebarFixed ? "panel-close" : "panel-open"));
  }
  function arrangeNavigation() {
    if (navigation.open) navigation.close();
    closeWorkspacePopover();
    if (desktopNavigation.matches) {
      $("app-view").insertBefore(sidebarRail, $("main-content"));
      sidebarRail.append(sidebar);
    } else {
      navigation.append(sidebar);
      sidebarRail.remove();
    }
    $("open-navigation").setAttribute("aria-controls", desktopNavigation.matches ? "sidebar" : "navigation-dialog");
    if (desktopNavigation.matches) $("open-navigation").removeAttribute("aria-expanded");
    else $("open-navigation").setAttribute("aria-expanded", "false");
    renderSidebarMode();
  }
  $("sidebar-mode").addEventListener("click", () => {
    sidebarFixed = !sidebarFixed;
    if (!sidebarFixed) {
      sidebarRail.classList.toggle("dismissed", sidebarRail.matches(":hover"));
      sidebarRail.classList.remove("revealed");
      $("open-navigation").focus({ preventScroll: true });
    } else sidebarRail.classList.remove("dismissed");
    try { localStorage.setItem("pocketmark-sidebar", sidebarFixed ? "fixed" : "auto"); } catch { /* Storage is optional. */ }
    renderSidebarMode();
  });
  sidebarRail.addEventListener("pointerleave", () => sidebarRail.classList.remove("dismissed"));
  sidebar.addEventListener("focusout", (event) => {
    if (!sidebar.contains(event.relatedTarget)) sidebarRail.classList.remove("revealed");
  });
  desktopNavigation.addEventListener("change", arrangeNavigation);
  const workspaceButton = $("workspace-button");
  const workspacePopover = $("workspace-popover");
  function closeWorkspacePopover() {
    if (workspacePopover.matches(":popover-open")) workspacePopover.hidePopover();
  }
  function positionWorkspacePopover() {
    const anchor = workspaceButton.getBoundingClientRect();
    const width = Math.min(224, window.innerWidth - 16);
    workspacePopover.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8))}px`;
    workspacePopover.style.top = `${Math.max(8, anchor.bottom + 4)}px`;
    workspacePopover.style.maxHeight = `${Math.max(44, window.innerHeight - anchor.bottom - 12)}px`;
  }
  workspacePopover.addEventListener("beforetoggle", (event) => {
    workspaceButton.setAttribute("aria-expanded", String(event.newState === "open"));
    if (event.newState === "open") positionWorkspacePopover();
  });
  workspacePopover.addEventListener("click", (event) => {
    if (event.target.closest("button")) closeWorkspacePopover();
  }, true);
  window.addEventListener("resize", closeWorkspacePopover);
  $("sidebar").addEventListener("scroll", closeWorkspacePopover);
  arrangeNavigation();
  function closeNavigation() {
    closeWorkspacePopover();
    if (desktopNavigation.matches) {
      sidebarRail.classList.remove("revealed");
      if (sidebar.contains(document.activeElement)) $("main-content").focus({ preventScroll: true });
      return;
    }
    if (!navigation.open) return;
    navigation.close();
    $("open-navigation").setAttribute("aria-expanded", "false");
    $("open-navigation").focus({ preventScroll: true });
  }
  $("open-navigation").addEventListener("click", () => {
    if (desktopNavigation.matches) { sidebarRail.classList.add("revealed"); $("sidebar-mode").focus(); return; }
    navigation.showModal();
    $("open-navigation").setAttribute("aria-expanded", "true");
    $("close-navigation").focus();
  });
  $("close-navigation").addEventListener("click", closeNavigation);
  navigation.addEventListener("cancel", (event) => { event.preventDefault(); closeNavigation(); });
  navigation.addEventListener("close", () => {
    if (!navigation.open) closeWorkspacePopover();
    if (!desktopNavigation.matches) $("open-navigation").setAttribute("aria-expanded", String(navigation.open));
  });
  $("sidebar").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (button && button.id !== "close-navigation" && button.id !== "sidebar-mode" && !button.hasAttribute("data-keep-navigation")) closeNavigation();
  }, true);

  function toast(message, error = false, action = null) {
    clearTimeout(toastTimer);
    toastActionPending = true;
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
        toastActionPending = true;
        button.disabled = true;
        try { await action.run(); } catch (error) { toast(error.message, true); }
      });
      notice.append(button);
    }
    notice.hidden = false;
    toastActionPending = false;
    toastTimer = setTimeout(() => { notice.hidden = true; }, action || error ? 12000 : 5000);
  }
  $("toast").addEventListener("focusin", () => clearTimeout(toastTimer));
  $("toast").addEventListener("focusout", (event) => {
    const notice = $("toast");
    if (!notice.hidden && !toastActionPending && !notice.contains(event.relatedTarget)) {
      toastTimer = setTimeout(() => { notice.hidden = true; }, 12000);
    }
  });
  document.querySelectorAll("dialog").forEach((dialog) => dialog.addEventListener("close", () => {
    if (dialog.contains($("toast"))) {
      clearTimeout(toastTimer);
      $("toast").hidden = true;
      document.body.append($("toast"));
    }
  }));

  let setupRequired = false;
  function resetMFALogin() {
    ["mfa-enrollment", "mfa-code-form", "mfa-login-codes", "mfa-back"].forEach(id => { $(id).hidden = true; });
    $("login-form").hidden = false;
    $("mfa-code").value = $("mfa-secret").value = "";
    $("mfa-login-codes-value").textContent = "";
    $("mfa-qr").removeAttribute("src");
    $("login-help").hidden = false;
  }
  function showLogin() {
    closeNavigation();
    if (mfaManagementBusy || (Boolean(settingsSection) && !$("mfa-manage-codes").hidden)) {
      deferredLogin = true;
      settingsSection = "2fa";
      history.replaceState({ ...history.state }, "", location.pathname + workspace.routeSearch(route()));
      renderSettings();
      if (!mfaManagementBusy) {
        document.querySelectorAll("#settings-page > section").forEach(section => { if (section.getAttribute("aria-labelledby") !== "mfa-settings-title") section.inert = true; });
        document.querySelectorAll("#mfa-manage-form button[type='submit'], #mfa-manage-verify button[type='submit']").forEach(button => { button.disabled = true; });
      }
      $("mfa-manage-feedback").textContent = mfaManagementBusy
        ? "Your session expired. Waiting for the authentication change to finish."
        : "Your session expired. These recovery codes may have changed. Save them, then sign in and generate new codes.";
      return;
    }
    deferredLogin = false;
    clearSettings();
    settingsSection = null; renderSettings();
    setMFAManagementBusy(false);
    clearTimeout(tagsTimer);
    tagsRequest++;
    state.signedIn = false;
    renderedLibraryRoute = null;
    libraryUnavailable = true;
    expandedBookmarkTags.clear();
    state.links = [];
    bulk.clear();
    state.request++;
    clearTimeout(state.timer);
    reader.close();
    bulk.close();
    document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
    $("app-view").hidden = true;
    $("login-view").hidden = false;
    resetMFALogin();
    if (deferredLoginNotice) { $("login-error").textContent = deferredLoginNotice; deferredLoginNotice = ""; }
    $("login-username").focus();
  }

  async function api(path, options = {}, retried = false) {
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
      if (body?.code === "reauth_required" && !retried) {
        await security.confirm();
        return api(path, options, true);
      }
      const loginPath = ["/api/login", "/api/setup", "/api/mfa/enroll", "/api/mfa/verify"].includes(path);
      if (response.status === 401 && !loginPath) {
        const expired = state.signedIn;
        const recoveryNotice = deferredLoginNotice;
        showLogin();
        if (expired && !recoveryNotice) $("login-error").textContent = workspace.requestFailure(401);
      }
      const message = response.status === 401 && loginPath ? (body?.error || "Check your credentials, then try again.") : workspace.requestFailure(response.status, body?.error);
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return body;
  }

  const security = globalThis.PocketmarkSecurity.create({ api, toast, onSessionExpired: showLogin });

  const reader = globalThis.PocketmarkReader.create({
    api, drafts, toast, confirmAction, onEdit: openEditor, onChange: () => refresh(true), onSessionExpired: showLogin,
  });

  const bulk = globalThis.PocketmarkBulk.create({
    api, toast, onChange: () => refresh(true), onSelectionChange: syncBookmarkSelection, fillCollections,
    confirmDelete: confirmBulkDelete,
    defaultCollection: () => state.filter === "collection" ? state.collection : null, onSessionExpired: showLogin,
  });

  const selection = globalThis.PocketmarkSelection.create({ grid: $("bookmark-grid"), bulk, links: () => libraryLoading || libraryUnavailable ? [] : state.links, onChange: syncBookmarkSelection });
  function syncBookmarkSelection() {
    for (const card of $("bookmark-grid").querySelectorAll(".bookmark-card")) {
      const selected = bulk.has(Number(card.dataset.id));
      card.classList.toggle("is-selected", selected);
      card.setAttribute("aria-label", `${card.dataset.label}${selected ? ", selected" : ""}`);
    }
  }

  // Snapshot only visible cards; exits are inert and siblings retain their positions.
  function bookmarkPositions() {
    const grid = $("bookmark-grid");
    if (grid.hidden || reducedMotion.matches || document.hidden) return [];
    return [...grid.children].map(node => ({ node, id: node.dataset.id, rect: node.getBoundingClientRect() }));
  }
  function transitionBookmarks(previous) {
    const grid = $("bookmark-grid"), current = new Map([...grid.children].map(node => [node.dataset.id, node]));
    if (reducedMotion.matches || !previous.some(entry => !current.has(entry.id))) return;
    for (const { node, id, rect } of previous) {
      const next = current.get(id);
      if (next) {
        const target = next.getBoundingClientRect();
        move(next, [{ transform: `translate(${rect.left - target.left}px, ${rect.top - target.top}px)` }, { transform: "none" }], 200);
      } else if (node.animate) {
        const layer = el("div", `bookmark-exit-layer bookmark-grid${grid.classList.contains("view-list") ? " view-list" : ""}`);
        layer.inert = true; layer.setAttribute("aria-hidden", "true");
        // Detached cards must not duplicate IDs or load archive thumbnails again.
        node.querySelectorAll("[id]").forEach(child => child.removeAttribute("id"));
        layer.append(node);
        Object.assign(layer.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
        document.body.append(layer);
        move(layer, [{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(.98)" }], 140);
        const animation = activeMotion.get(layer);
        if (animation) animation.finished.catch(() => {}).then(() => layer.remove()); else layer.remove();
      }
    }
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
    $("breadcrumb-current").textContent = settingsSection ? "Settings" : showingTags ? "Tags" : title;
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
    if (state.query) add(`Search: ${state.query}`, () => { clearTimeout(searchTimer); state.query = ""; $("search").value = ""; });
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
      remove.setAttribute("data-keep-navigation", "");
      remove.title = `Delete ${collection.name}`;
      remove.setAttribute("aria-label", remove.title);
      remove.addEventListener("click", async () => {
        if (!await confirmAction("Delete collection?", `Delete “${collection.name}”? Bookmarks directly in it move to Inbox. Direct subcollections move to the library root.`, "Delete collection") || !remove.isConnected || !state.signedIn) return;
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
    $("tags-empty-state").hidden = true;
    $("tags-index-layout").hidden = true;
    $("tags-letter-control").hidden = true;
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
      $("tags-empty-state").hidden = result.total > 0;
      $("tags-index-layout").hidden = result.total === 0;
      $("tags-letter-control").hidden = result.total === 0;
      $("tags-clear-search").hidden = !query;
      $("tags-browse-bookmarks").hidden = !!query;
      $("tags-empty-art").replaceChildren(icon(query ? "search" : "tag"));
      $("tags-empty-title").textContent = query ? "No tags found" : "No tags yet";
      $("tags-empty").textContent = query ? "Try a different name or clear your search to see all tags." : "Add tags when saving or editing a bookmark to group related ideas across collections.";
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
  $("tags-clear-search").addEventListener("click", () => {
    clearTimeout(tagsTimer); $("tags-search").value = ""; tagsPage = 1; tagsSearchSession = false;
    commitRoute(); loadTagDirectory(); $("tags-search").focus();
  });
  $("tags-letter-picker").addEventListener("change", () => { if ($("tags-letter-picker").value) loadTagDirectory($("tags-letter-picker").value); });
  $("tags-retry").addEventListener("click", () => { clearTimeout(tagsTimer); loadTagDirectory(); });
  $("tags-previous").addEventListener("click", () => { tagsPage--; commitRoute(); $("tags-title").focus(); loadTagDirectory(); });
  $("tags-next").addEventListener("click", () => { tagsPage++; commitRoute(); $("tags-title").focus(); loadTagDirectory(); });

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
    selection.cancel();
    const previous = bookmarkPositions();
    grid.replaceChildren();
    for (const link of state.links) {
      const card = el("article", "bookmark-card");
      const top = el("div", "card-top");
      const host = link.type === "file" ? "Saved file" : domain(link.url);
      const favorite = el("button", `card-action favorite-button${link.favorite ? " is-favorite" : ""}`);
      favorite.append(icon("star"));
      favorite.title = link.favorite ? "Remove from favorites" : "Add to favorites";
      favorite.setAttribute("aria-label", `${favorite.title}: ${link.title || link.url}`);
      favorite.setAttribute("aria-pressed", String(!!link.favorite));
      favorite.dataset.focusKey = `link:${link.id}:action:0`;
      favorite.append(el("span", "mobile-action-label", "Favorite"));
      favorite.addEventListener("click", () => updateLink(link, { favorite: !link.favorite }, favorite));
      card.dataset.id = String(link.id);
      card.dataset.label = link.title || link.url;
      card.dataset.focusKey = `link:${link.id}:select`;
      card.tabIndex = 0;
      card.setAttribute("role", "group");
      card.setAttribute("aria-keyshortcuts", "Space Shift+Space");
      card.setAttribute("aria-description", "Press Space to toggle selection. Shift+Space selects a range.");
      const body = el("div", "card-body");
      const heading = el("h2", "card-title");
      const open = el("button", "", link.title || link.url);
      open.dataset.focusKey = `link:${link.id}:open`;
      open.addEventListener("click", () => reader.open(link.id));
      heading.append(open);
      const titleRow = el("div", "card-title-row");
      titleRow.append(favorite, heading);
      const hostLabel = el("p", "card-domain", host);
      if (link.type !== "file") hostLabel.title = link.url;
      body.append(titleRow, hostLabel);
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
      for (const name of (link.tags || []).slice(0, expandedBookmarkTags.has(link.id) ? undefined : 5)) {
        const tag = el("button", "card-tag", `#${name}`);
        tag.dataset.focusKey = `link:${link.id}:tag:${name}`;
        tag.addEventListener("click", () => selectFilter("all", null, name));
        tags.append(tag);
      }
      if ((link.tags || []).length > 5 && !expandedBookmarkTags.has(link.id)) {
        const more = el("button", "card-tag", `+${link.tags.length - 5}`);
        more.dataset.focusKey = `link:${link.id}:more-tags`;
        more.setAttribute("aria-label", `Show all ${link.tags.length} tags for ${link.title || link.url}`);
        more.addEventListener("click", () => {
          expandedBookmarkTags.add(link.id);
          more.remove();
          let firstAdded;
          for (const name of link.tags.slice(5)) {
            const tag = el("button", "card-tag", `#${name}`);
            tag.dataset.focusKey = `link:${link.id}:tag:${name}`;
            tag.addEventListener("click", () => selectFilter("all", null, name));
            tags.append(tag);
            if (!firstAdded) firstAdded = tag;
          }
          firstAdded?.focus();
        });
        tags.append(more);
      }
      body.append(tags);
      const footer = el("div", "card-footer");
      const statuses = { pending: "Queued", processing: "Saving…", ready: "Captured", failed: "Capture failed" };
      const status = el("span", "card-state", statuses[link.status] || "Not captured");
      status.classList.add(["pending", "processing", "ready", "failed"].includes(link.status) ? link.status : "saved");
      const statusIcon = link.status === "processing" || !statuses[link.status] ? el("span", "capture-indicator") : icon(link.status === "ready" ? "check" : link.status === "failed" ? "warning" : "clock");
      statusIcon.setAttribute("aria-hidden", "true");
      status.prepend(statusIcon);
      footer.append(status);
      const actions = el("div", "card-actions");
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
      actions.append(moreActions, overflow);
      overflow.append(actionButton(link.read ? "check" : "clock", link.read ? "Mark unread" : "Mark as read", (event) => updateLink(link, { read: !link.read }, event.currentTarget), link.read ? "read" : ""));
      overflow.append(actionButton("edit", "Edit bookmark", () => openEditor(link)));
      overflow.append(actionButton("trash", "Delete bookmark", () => {
        deleteBookmark = link;
        $("delete-bookmark-name").textContent = `“${link.title || link.url}”`;
        $("delete-bookmark-error").textContent = "";
        $("delete-bookmark-dialog").showModal();
        $("delete-bookmark-cancel").focus();
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
        button.dataset.focusKey = `link:${link.id}:action:${i}`;
        button.append(el("span", "mobile-action-label", button.title));
        button.setAttribute("aria-label", `${button.title}: ${link.title || link.url}`);
      });
      card.append(top);
      if (link.hasThumbnail) {
        const thumbnail = el("img", "card-thumbnail");
        thumbnail.alt = "";
        thumbnail.loading = "lazy";
        thumbnail.decoding = "async";
        thumbnail.dataset.src = `/api/links/${link.id}/thumbnail`;
        thumbnail.addEventListener("error", () => thumbnail.remove());
        card.append(thumbnail);
      }
      card.append(body, footer);
      arrangeBookmarkCard(card);
      grid.append(card);
    }
    bulk.render(libraryUnavailable || libraryLoading ? [] : state.links);
    grid.hidden = libraryUnavailable || libraryLoading;
    $("empty-state").hidden = libraryUnavailable || libraryLoading || state.links.length > 0;
    const filtered = !!state.query || state.filter !== "all" || !!state.tag;
    $("empty-title").textContent = filtered ? "No bookmarks found" : "Your library starts here";
    $("empty-message").textContent = filtered ? "Try a different search or clear your filters to see all bookmarks." : "Save your first bookmark, or bring your existing bookmarks with you.";
    const emptyView = !state.query && (state.tag ? ["No bookmarks with this tag", "Choose another tag or return to all bookmarks.", false, "tag"] : {
      collection: ["This collection is empty", "Add a bookmark to start this collection.", true, "folder"],
      inbox: ["Your inbox is empty", "Save a bookmark without a collection to keep it here until you’re ready to organize it.", true, "inbox"],
      favorite: ["No favorites yet", "Select the star on any bookmark to keep your go-to pages close at hand.", false, "star"],
      unread: ["Nothing left to read", "You’re all caught up. Mark a bookmark as unread to save it for later.", false, "clock"],
    }[state.filter]);
    $("empty-art").replaceChildren(icon(state.query ? "search" : emptyView?.[3] || "bookmark"));
    if (emptyView) {
      $("empty-title").textContent = emptyView[0];
      $("empty-message").textContent = emptyView[1];
    }
    $("empty-import").hidden = filtered;
    $("empty-reset").hidden = !filtered;
    $("empty-reset").textContent = emptyView ? "View all bookmarks" : "Clear filters";
    $("empty-add").hidden = !!emptyView && !emptyView[2];
    $("empty-add").textContent = filtered ? "Add a bookmark" : "Add your first bookmark";
    const primaryAdd = !filtered || !!emptyView?.[2];
    $("empty-add").classList.toggle("primary", primaryAdd);
    $("empty-add").classList.toggle("subtle", !primaryAdd);
    $("empty-reset").classList.toggle("primary", !primaryAdd);
    $("empty-reset").classList.toggle("subtle", primaryAdd);
    const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
    $("pagination").hidden = libraryUnavailable || libraryLoading || pages <= 1;
    $("page-label").textContent = `Page ${state.page} of ${pages}`;
    $("previous-page").disabled = state.page <= 1;
    $("next-page").disabled = state.page >= pages;
    $("results-label").textContent = libraryLoading ? "Loading your library…" : libraryUnavailable ? "Could not load this view" : `${state.total} bookmark${state.total === 1 ? "" : "s"}${state.query ? ` matching “${state.query}”` : " in this view"}`;
    syncBookmarkSelection();
    transitionBookmarks(previous);
    restoreFocus(grid, key);
  }

  async function refresh(quiet = false) {
    if (!state.signedIn || settingsSection) return;
    clearTimeout(state.timer);
    const request = ++state.request;
    const params = new URLSearchParams({ page: String(state.page), sort: state.sort });
    if (state.query) params.set("fuzzy", "1");
    if (state.query) params.set("q", state.query);
    if (state.tag) params.set("tag", state.tag);
    if (state.filter === "favorite") params.set("favorite", "1");
    if (state.filter === "unread") params.set("unread", "1");
    if (state.filter === "inbox") params.set("collection", "0");
    if (state.filter === "collection") params.set("collection", state.collection);
    libraryLoading = renderedLibraryRoute !== params.toString();
    if (libraryLoading) {
      if ($("bookmark-grid").contains(document.activeElement) || $("pagination").contains(document.activeElement)) $("page-title").focus();
      $("bookmark-grid").hidden = true;
      $("empty-state").hidden = true;
      $("pagination").hidden = true;
      bulk.render([]);
    }
    $("bookmark-grid").setAttribute("aria-busy", "true");
    if (!quiet || libraryLoading) $("results-label").textContent = "Loading your library…";
    $("library-error").hidden = true;
    try {
      const [result, collections, tags, stats] = await Promise.all([api(`/api/links?${params}`), api("/api/collections"), api("/api/tags"), api("/api/stats")]);
      if (request !== state.request) return;
      libraryUnavailable = false;
      libraryLoading = false;
      state.links = result.links || [];
      const visibleIds = new Set(state.links.map(link => link.id));
      for (const id of expandedBookmarkTags) if (!visibleIds.has(id)) expandedBookmarkTags.delete(id);
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
      libraryLoading = false;
      libraryUnavailable = renderedLibraryRoute !== params.toString();
      renderLinks();
      const message = el("span", "", `${error.message}${libraryUnavailable ? "" : " Showing the last loaded results."} `);
      const retry = el("button", "text-button", "Try again");
      retry.type = "button";
      retry.addEventListener("click", () => { $("page-title").focus(); refresh(); });
      $("library-error").replaceChildren(message, retry);
      $("library-error").hidden = false;
      $("results-label").textContent = "Could not refresh library";
    } finally {
      if (request === state.request) $("bookmark-grid").setAttribute("aria-busy", "false");
    }
  }

  function openEditor(link = null) {
    editorSession++;
    $("save-bookmark").disabled = false;
    $("save-bookmark").textContent = "Save";
    $("bookmark-save-status").hidden = true;
    state.editing = link;
    $("bookmark-form").reset();
    $("bookmark-error").textContent = "";
    $("bookmark-dialog-title").textContent = link ? "Edit bookmark" : "Add bookmark";
    $("bookmark-url").value = link?.url || "";
    const file = link?.type === "file";
    $("bookmark-capture-option").hidden = file;
    $("bookmark-save-html").disabled = file;
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
    return { url: $("bookmark-url").value, title: $("bookmark-title").value, description: $("bookmark-description").value, notes: $("bookmark-notes").value, collectionId: $("bookmark-collection").value ? Number($("bookmark-collection").value) : null, tags: [...new Set($("bookmark-tags").value.split(",").map((tag) => tag.trim()).filter(Boolean))], favorite: $("bookmark-favorite").checked, read: $("bookmark-read").checked, saveHTML: !$("bookmark-save-html").disabled && $("bookmark-save-html").checked };
  }
  function validateBookmarkFields() {
    const issues = workspace.bookmarkIssues({ ...editorValues(), type: state.editing?.type });
    for (const field of ["url", "title", "description", "notes", "tags"]) {
      $("bookmark-" + field + (field === "tags" ? "-query" : "")).setCustomValidity(issues[field] || "");
    }
    return issues;
  }
  function fillEditor(value) {
    $("bookmark-save-html").checked = !!value.saveHTML;
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
  $("discard-bookmark-draft").addEventListener("click", async () => {
    const session = editorSession, key = draftKey(state.editing);
    if (!await confirmAction("Discard draft?", "Discard this unsaved draft?", "Discard draft") || session !== editorSession || !$("bookmark-dialog").open) return;
    drafts.delete(key); fillEditor(editorBaseline); $("bookmark-draft").hidden = true;
  });

  function attachTagPicker(id) {
    tagPickers.set(id, globalThis.PocketmarkTagPicker.create({ id, api, icon, move }));
  }
  attachTagPicker("bookmark-tags");
  attachTagPicker("bulk-tags");

  async function enterLibrary() {
    state.signedIn = true;
    $("login-view").hidden = true;
    $("app-view").hidden = false;
    resetMFALogin();
    configureLogin();
    await restoreRoute(true);
    openSharedLink();
  }
  function showMFACode(enrollment) {
    $("mfa-code-form").hidden = false;
    $("mfa-enrollment").hidden = !enrollment;
    $("mfa-back").hidden = false;
    $("login-help").hidden = true;
    $("login-title").textContent = enrollment ? "Set up your authenticator" : "Verify it’s you";
    $("login-description").textContent = enrollment ? "Add Pocketmark to your authenticator app, then enter its code." : "Enter a code from your authenticator app, or use a recovery code.";
    $("mfa-code-label").textContent = enrollment ? "Code from your authenticator" : "Authentication or recovery code";
    $("mfa-code").inputMode = enrollment ? "numeric" : "text";
    $("mfa-code").value = "";
    $("mfa-code").focus();
  }
  async function beginMFAEnrollment() {
    const enrollment = await api("/api/mfa/enroll", { method: "POST", body: "{}" });
    $("mfa-secret").value = enrollment.secret;
    $("mfa-qr").src = enrollment.qr;
    showMFACode(true);
  }

  $("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    $("login-error").textContent = "";
    try {
      if (setupRequired && $("login-password").value !== $("login-confirm").value) throw new Error("The passwords do not match.");
      const result = await api(setupRequired ? "/api/setup" : "/api/login", { method: "POST", body: JSON.stringify({ username: $("login-username").value.trim(), password: $("login-password").value }) });
      setupRequired = false;
      $("login-confirm").value = "";
      $("login-password").value = "";
      $("login-form").hidden = true;
      if (result.enrollmentRequired) { $("mfa-back").hidden = false; await beginMFAEnrollment(); }
      else showMFACode(false);
    } catch (error) { $("login-error").textContent = error.message; } finally { button.disabled = false; }
  });
  $("mfa-code-form").addEventListener("submit", async event => {
    event.preventDefault(); event.submitter.disabled = true; $("login-error").textContent = "";
    try {
      const result = await api("/api/mfa/verify", { method: "POST", body: JSON.stringify({ code: $("mfa-code").value.trim() }) });
      $("mfa-code").value = $("mfa-secret").value = ""; $("mfa-qr").removeAttribute("src");
      if (result.recoveryCodes) {
        $("mfa-code-form").hidden = $("mfa-enrollment").hidden = $("mfa-back").hidden = true;
        $("mfa-login-codes-value").textContent = result.recoveryCodes.join("\n");
        $("mfa-login-codes").hidden = false; $("login-title").textContent = "Your backup access";
        $("login-description").textContent = "Keep these codes separate from your authenticator.";
        $("mfa-login-codes-value").focus();
      } else {
        await enterLibrary();
        if (result.usedRecoveryCode) toast("Recovery code used. You can replace your authenticator in Settings.");
      }
    } catch (error) { $("login-error").textContent = error.message; }
    finally { event.submitter.disabled = false; }
  });
  function downloadRecoveryCodes(element) {
    const url = URL.createObjectURL(new Blob([element.textContent + "\n"], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url; link.download = "pocketmark-recovery-codes.txt";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  $("mfa-login-download").addEventListener("click", () => downloadRecoveryCodes($("mfa-login-codes-value")));
  $("mfa-secret-copy").addEventListener("click", async () => {
    $("login-error").textContent = "";
    try { await navigator.clipboard.writeText($("mfa-secret").value); toast("Setup key copied."); }
    catch { $("mfa-secret").select(); $("login-error").textContent = "Select and copy the setup key shown above."; }
  });
  $("mfa-login-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("mfa-login-codes-value").textContent); toast("Recovery codes copied."); }
    catch { $("login-error").textContent = "Select and copy the recovery codes shown above."; }
  });
  $("mfa-login-continue").addEventListener("click", async () => {
    $("mfa-login-continue").disabled = true;
    try { await enterLibrary(); } catch (error) { $("login-error").textContent = error.message; }
    finally { $("mfa-login-continue").disabled = false; }
  });
  $("mfa-back").addEventListener("click", () => { resetMFALogin(); configureLogin(); $("login-error").textContent = ""; $("login-username").focus(); });

  function confirmAction(title, description, action) {
    const dialog = $("confirm-action-dialog");
    if (dialog.open) return Promise.resolve(false);
    $("confirm-action-title").textContent = title;
    $("confirm-action-description").textContent = description;
    $("confirm-action-submit").textContent = action;
    dialog.returnValue = "";
    return new Promise((resolve) => {
      dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
      dialog.showModal();
      $("confirm-action-cancel").focus();
    });
  }

  function confirmBulkDelete(count) {
    const dialog = $("delete-selection-dialog");
    $("delete-selection-description").textContent = `Delete ${count} selected bookmark${count === 1 ? "" : "s"} and its saved content? This cannot be undone.`;
    dialog.returnValue = "";
    return new Promise((resolve) => {
      dialog.addEventListener("close", () => resolve(dialog.returnValue === "delete"), { once: true });
      dialog.showModal();
      dialog.querySelector("button").focus();
    });
  }

  const deleteBookmarkDialog = $("delete-bookmark-dialog");
  let deleteBookmark = null;
  let deletingBookmark = false;
  deleteBookmarkDialog.addEventListener("cancel", (event) => { if (deletingBookmark) event.preventDefault(); });
  deleteBookmarkDialog.addEventListener("close", () => { deleteBookmark = null; });
  $("delete-bookmark-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (deletingBookmark || !deleteBookmark) return;
    const link = deleteBookmark;
    deletingBookmark = true;
    $("delete-bookmark-confirm").disabled = $("delete-bookmark-cancel").disabled = true;
    $("delete-bookmark-confirm").textContent = "Deleting…";
    $("delete-bookmark-error").textContent = "";
    try {
      await api(`/api/links/${link.id}`, { method: "DELETE" });
      bulk.select(link, false);
      if (state.links.length === 1 && state.page > 1) state.page--;
      deleteBookmarkDialog.close();
      await refresh();
      toast("Bookmark deleted.");
    } catch (error) {
      if (deleteBookmarkDialog.open) $("delete-bookmark-error").textContent = error.message;
      else toast(error.message, true);
    } finally {
      deletingBookmark = false;
      $("delete-bookmark-confirm").disabled = $("delete-bookmark-cancel").disabled = false;
      $("delete-bookmark-confirm").textContent = "Delete bookmark";
    }
  });

  const logoutDialog = $("logout-dialog");
  let signingOut = false;
  $("logout-button").addEventListener("click", () => {
    $("logout-description").textContent = drafts.size
      ? "Signing out will discard the unsaved drafts kept in this tab. You’ll need to sign in again to access your library."
      : "You’ll need to sign in again to access your library.";
    $("logout-error").textContent = "";
    logoutDialog.showModal();
    $("logout-cancel").focus();
  });
  logoutDialog.addEventListener("cancel", (event) => { if (signingOut) event.preventDefault(); });
  logoutDialog.addEventListener("close", () => {
    if (state.signedIn) $("open-navigation").focus({ preventScroll: true });
  });
  $("logout-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (signingOut) return;
    signingOut = true;
    $("logout-confirm").disabled = $("logout-cancel").disabled = true;
    $("logout-confirm").textContent = "Signing out…";
    $("logout-error").textContent = "";
    try {
      await api("/api/logout", { method: "POST" });
      drafts.clear();
      showLogin();
    } catch (error) { $("logout-error").textContent = error.message; }
    finally {
      signingOut = false;
      $("logout-confirm").disabled = $("logout-cancel").disabled = false;
      $("logout-confirm").textContent = "Sign out";
    }
  });

  document.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => selectFilter(button.dataset.filter)));
  // Treat an outside click like Escape so each dialog keeps its cancellation guards.
  document.querySelectorAll("dialog").forEach((dialog) => {
    let backdropPress = false;
    function outside(event) {
      const rect = dialog.getBoundingClientRect();
      return event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom);
    }
    dialog.addEventListener("pointerdown", (event) => { backdropPress = event.button === 0 && outside(event); });
    dialog.addEventListener("pointercancel", () => { backdropPress = false; });
    dialog.addEventListener("close", () => { backdropPress = false; });
    dialog.addEventListener("click", (event) => {
      const dismiss = backdropPress && outside(event);
      backdropPress = false;
      if (!dismiss || !dialog.open) return;
      if (typeof dialog.requestClose === "function") dialog.requestClose();
      else if (dialog.dispatchEvent(new Event("cancel", { cancelable: true }))) dialog.close();
    });
  });
  document.querySelectorAll(".close-dialog").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
  $("add-bookmark").addEventListener("click", () => openEditor());
  $("empty-add").addEventListener("click", () => openEditor());
  $("empty-import").addEventListener("click", () => $("import-file").click());
  function resetLibraryFilters() {
    clearTimeout(searchTimer); state.query = ""; $("search").value = "";
    selectFilter("all"); $("search").focus();
  }
  $("empty-reset").addEventListener("click", resetLibraryFilters);
  $("tags-browse-bookmarks").addEventListener("click", resetLibraryFilters);
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
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = submitted.saveHTML ? "Saving bookmark & HTML…" : "Saving bookmark…";
    $("bookmark-save-status").hidden = !submitted.saveHTML;
    $("bookmark-save-status").textContent = "Saving the bookmark and its HTML copy. This can take up to 45 seconds.";
    $("bookmark-error").textContent = "";
    const body = { url: $("bookmark-url").value.trim(), title: $("bookmark-title").value.trim(), description: $("bookmark-description").value.trim(), notes: $("bookmark-notes").value, collectionId: $("bookmark-collection").value ? Number($("bookmark-collection").value) : null, tags: [...new Set($("bookmark-tags").value.split(",").map((tag) => tag.trim()).filter(Boolean))], favorite: $("bookmark-favorite").checked, read: $("bookmark-read").checked };
    try {
      if (state.editing?.type !== "file" && !safeURL(body.url)) throw new Error("Please enter a complete http:// or https:// URL.");
      const result = await workspace.saveBookmark(api, editing, body, submitted.saveHTML);
      const baseline = { ...body, saveHTML: submitted.saveHTML };
      const active = session === editorSession && $("bookmark-dialog").open;
      const latest = active ? editorValues() : drafts.get(key);
      const newer = latest && JSON.stringify(latest) !== JSON.stringify(submitted);
      if (newer && active && !editing) {
        drafts.delete(key);
        state.editing = result.link;
        $("bookmark-dialog-title").textContent = "Edit bookmark";
        drafts.put(draftKey(result.link), latest, baseline);
      } else if (newer) drafts.put(key, latest, baseline); else drafts.delete(key);
      if (active) {
        editorBaseline = baseline;
        $("bookmark-draft").hidden = !newer;
        if (!newer) $("bookmark-dialog").close();
      }
      if (result.captureError) htmlCaptureFailed(result.link.id, result.captureError);
      else toast(newer ? "Saved. Your newer edits remain a draft." : result.capture ? `Bookmark and HTML copy saved.${result.capture.omitted ? ` ${result.capture.omitted} resource${result.capture.omitted === 1 ? "" : "s"} could not be included.` : ""}` : editing ? "Bookmark updated." : "Bookmark saved.");
      await refresh();
    } catch (error) { if (session === editorSession) $("bookmark-error").textContent = error.message; else toast(error.message, true); }
    finally { if (session === editorSession) { button.disabled = false; button.textContent = "Save"; $("bookmark-save-status").hidden = true; } }
  });

  function htmlCaptureFailed(id, error) {
    toast(`Bookmark saved. The HTML copy could not be saved. ${error.message}`, true, { label: "Retry HTML", run: async () => {
      try {
        const result = await api(`/api/links/${id}/preserve`, { method: "POST" });
        toast(`HTML copy saved.${result.omitted ? ` ${result.omitted} resource${result.omitted === 1 ? "" : "s"} could not be included.` : ""}`);
      } catch (failure) { htmlCaptureFailed(id, failure); }
    } });
  }

  $("add-collection").addEventListener("click", () => {
    openCollectionEditor();
  });
  let collectionEditorSession = 0;
  $("collection-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.submitter, session = collectionEditorSession, editing = state.editingCollection;
    button.disabled = true;
    $("collection-error").textContent = "";
    try {
      const name = $("collection-name").value.trim();
      if (!name) throw new Error("Give your collection a name.");
      if (new TextEncoder().encode(name).length > 120) throw new Error("Collection names can use up to 120 UTF-8 bytes. Accented characters and emoji may use more than one byte.");
      const parentId = $("collection-parent").value ? Number($("collection-parent").value) : null;
      const saved = await api(editing ? `/api/collections/${editing.id}` : "/api/collections", { method: editing ? "PUT" : "POST", body: JSON.stringify({ name, parentId }) });
      const active = session === collectionEditorSession && $("collection-dialog").open;
      const newer = active && ($("collection-name").value.trim() !== name || ($("collection-parent").value ? Number($("collection-parent").value) : null) !== parentId);
      if (newer) { state.editingCollection = editing || saved; $("collection-dialog-title").textContent = "Rename or move collection"; }
      else if (active) $("collection-dialog").close();
      await refresh();
      toast(newer ? "Saved. Your newer collection edits are still open." : editing ? "Collection updated." : "Collection created.");
    } catch (error) { if (session === collectionEditorSession && $("collection-dialog").open) $("collection-error").textContent = error.message; else toast(error.message, true); } finally { if (session === collectionEditorSession) button.disabled = false; }
  });

  $("import-button").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", async () => {
    const file = $("import-file").files[0];
    if (!file) return;
    $("import-button").disabled = true;
    $("empty-import").disabled = true;
    $("import-progress").hidden = false;
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error("Choose an export smaller than 8 MiB.");
      const body = await file.text();
      const html = /\.html?$/i.test(file.name) || file.type === "text/html";
      if (!html) { try { JSON.parse(body); } catch { throw new Error("Choose a JSON export or a browser bookmarks HTML file."); } }
      const result = await api(html ? "/api/import/html" : "/api/import", { method: "POST", headers: { "Content-Type": html ? "text/html" : "application/json" }, body });
      toast(`Imported ${result.imported} bookmarks. ${result.skipped || 0} skipped.`);
      await refresh();
    } catch (error) { toast(error.message, true); } finally { $("import-progress").hidden = true; $("import-button").disabled = false; $("empty-import").disabled = false; $("import-file").value = ""; }
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
    collectionEditorSession++;
    state.editingCollection = collection;
    $("collection-form").reset();
    $("collection-form").querySelector('[type="submit"]').disabled = false;
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

  const sortOptions = [...$("sort-menu").querySelectorAll("[data-sort]")];
  function syncSortMenu() {
    for (const option of sortOptions) option.setAttribute("aria-checked", String(option.dataset.sort === state.sort));
    const label = `Sort bookmarks: ${sortOptions.find((option) => option.dataset.sort === state.sort).textContent.trim()}`;
    $("sort-toggle").setAttribute("aria-label", label);
    $("sort-toggle").title = label;
  }
  function closeSortMenu(focus = false) {
    $("sort-menu").hidden = true;
    $("sort-toggle").setAttribute("aria-expanded", "false");
    if (focus) $("sort-toggle").focus();
  }
  function openSortMenu() {
    $("sort-menu").hidden = false;
    $("sort-toggle").setAttribute("aria-expanded", "true");
    sortOptions.find((option) => option.dataset.sort === state.sort).focus();
  }
  $("sort-toggle").addEventListener("click", () => { if ($("sort-menu").hidden) openSortMenu(); else closeSortMenu(); });
  $("sort-toggle").addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); openSortMenu(); }
  });
  $("sort-menu").addEventListener("click", (event) => {
    const option = event.target.closest("[data-sort]");
    if (!option) return;
    closeSortMenu(true);
    if (state.sort === option.dataset.sort) return;
    state.sort = option.dataset.sort; state.page = 1; syncSortMenu(); commitRoute(); refresh();
  });
  $("sort-menu").addEventListener("keydown", (event) => {
    const index = sortOptions.indexOf(document.activeElement);
    let next;
    if (event.key === "ArrowDown") next = (index + 1) % sortOptions.length;
    if (event.key === "ArrowUp") next = (index - 1 + sortOptions.length) % sortOptions.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = sortOptions.length - 1;
    if (next !== undefined) { event.preventDefault(); sortOptions[next].focus(); }
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeSortMenu(true); }
    if (event.key === "Tab") { closeSortMenu(true); if (event.shiftKey) event.preventDefault(); }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!$("sort-menu").hidden && !$("sort-menu").contains(event.target) && !$("sort-toggle").contains(event.target)) closeSortMenu();
  });
  document.addEventListener("focusin", (event) => {
    if (!$("sort-menu").hidden && !$("sort-menu").contains(event.target) && event.target !== $("sort-toggle")) closeSortMenu();
  });
  $("upload-file-button").addEventListener("click", () => $("library-file").click());
  $("library-file").addEventListener("change", async () => {
    const file = $("library-file").files[0];
    if (!file) return;
    $("upload-file-button").disabled = true;
    $("upload-progress").hidden = false;
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error("Choose a file smaller than 20 MiB.");
      const params = new URLSearchParams({ name: file.name });
      if (state.filter === "collection") params.set("collection", state.collection);
      const result = await api(`/api/files?${params}`, { method: "POST", headers: { "Content-Type": file.type || (/\.html?$/i.test(file.name) ? "text/html" : "application/octet-stream") }, body: file });
      await refresh(); toast("File saved to your library.");
      await reader.open(result.link.id);
    } catch (error) { toast(error.message, true); } finally { $("upload-progress").hidden = true; $("library-file").value = ""; $("upload-file-button").disabled = false; }
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
    $("login-description").textContent = setupRequired ? "After creating your account, you’ll set up an authenticator app and save recovery codes." : "Sign in with your password and an authentication or recovery code.";
    $("login-submit-label").textContent = setupRequired ? "Create account" : "Sign in";
    $("login-confirm-fields").hidden = !setupRequired;
    $("login-password-hint").hidden = !setupRequired;
    $("login-password").setAttribute("aria-describedby", setupRequired ? "login-password-hint" : "login-help");
    $("login-confirm").required = setupRequired;
    $("login-password").autocomplete = setupRequired ? "new-password" : "current-password";
    $("login-password").minLength = setupRequired ? 12 : 1;
    $("login-help").textContent = setupRequired ? "This instance has one personal account." : passwordEnabled ? "Use your Pocketmark username and password." : "Your existing library needs a password. Ask the server administrator to configure it using the account recovery instructions.";
    $("login-submit").disabled = !setupRequired && !passwordEnabled;
  }
  const profileHelp = {
    read: "Can read and export library data, including saved files. Cannot change it.",
    capture: "For the browser extension: read bookmark metadata, add or edit bookmarks, create collections and upload captures. Cannot delete, bulk edit, import, export or download saved files.",
    sync: "WebDAV only. Floccus can read and replace the bookmark tree, including deletions. Cannot access the native library API or saved files.",
    full: "Can read, export, change and delete library data, including WebDAV sync. Cannot manage your account, keys, sessions or full backups.",
  };
  $("token-profile").addEventListener("change", () => { $("token-permissions-help").textContent = profileHelp[$("token-profile").value]; });
  let settingsSession = 0;
  let tokenCount = 0;
  let tokensBusy = false;
  let editingTokenID = null;
  function setTokensBusy(busy) {
    tokensBusy = busy;
    $("token-form").querySelector("button[type='submit']").disabled = busy || editingTokenID !== null || tokenCount >= 32;
    $("token-list").querySelectorAll("button, .token-rename-form input").forEach((control) => {
      control.disabled = busy || (editingTokenID !== null && !control.closest(".token-rename-form"));
    });
  }
  function setTokenVisibility(visible) {
    $("new-token-value").type = visible ? "text" : "password";
    $("toggle-token").textContent = visible ? "Hide key" : "Show key";
    $("toggle-token").setAttribute("aria-label", visible ? "Hide API key" : "Show API key");
  }
  function clearNewToken() {
    $("new-token-value").value = "";
    $("new-token").hidden = true;
    setTokenVisibility(false);
  }
  async function loadTokens(session = settingsSession) {
    const tokens = await api("/api/tokens");
    if (session !== settingsSession) return;
    renderTokens(tokens, session);
  }
  function tokenLoadError(error, session) {
    if (session !== settingsSession) return;
    $("tokens-error").textContent = error.message;
    const retry = el("button", "button subtle", "Retry loading keys");
    retry.type = "button";
    retry.addEventListener("click", async () => {
      retry.disabled = true; retry.textContent = "Loading API keys…";
      $("tokens-error").textContent = "";
      try { await loadTokens(session); }
      catch (error) { tokenLoadError(error, session); }
    });
    const item = el("li", "token-empty"); item.append(retry);
    $("token-list").replaceChildren(item);
  }
  function tokenDate(value) {
    const date = new Date(value);
    if (!value || Number.isNaN(date.getTime())) return el("span", "muted", "No recorded use");
    const time = el("time", "", date.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }));
    time.dateTime = value;
    time.title = date.toLocaleString(undefined, { timeZoneName: "short" });
    return time;
  }
  function renderTokens(tokens, session, focusID, focusAction = "toggle") {
    $("token-list").replaceChildren();
    tokenCount = tokens.length;
    const expiredKey = token => token.expiresAt > 0 && token.expiresAt * 1000 <= Date.now();
    const usableKey = token => token.active && !expiredKey(token);
    $("token-count").textContent = `${tokens.filter(usableKey).length} active · ${tokens.length} of 32 keys`;
    $("token-form").querySelector("button[type='submit']").disabled = tokensBusy || tokenCount >= 32;
    if (!tokens.length) $("token-list").append(el("li", "token-empty muted", "No API keys yet. Create a key to connect your first app."));
    for (const token of tokens || []) {
      const row = el("li", "token-row");
      const details = el("div", "token-details");
      const heading = el("div", "token-name-row");
      const rename = el("button", "icon-button token-rename");
      rename.append(icon("edit"));
      rename.type = "button";
      rename.setAttribute("aria-label", `Rename ${token.name}`);
      rename.title = `Rename ${token.name}`;
      const nameGroup = el("div", "token-name-group");
      nameGroup.append(el("strong", "token-name", token.name), rename);
      const expired = expiredKey(token);
      heading.append(nameGroup, el("span", `token-status${usableKey(token) ? " is-active" : ""}`, expired ? "Expired" : token.active ? "Active" : "Disabled"));
      const metadata = el("dl", "token-metadata");
      for (const [label, value] of [["Created", token.createdAt], ["Last used", token.lastUsedAt]]) {
        const group = el("div", "");
        const detail = el("dd", ""); detail.append(tokenDate(value));
        group.append(el("dt", "", label), detail); metadata.append(group);
      }
      const permissions = { read: "Read only", capture: "Add, edit & capture", sync: "Floccus sync", full: "Full library access" };
      const expiry = token.expiresAt ? `${expired ? "Expired" : "Expires"} ${new Date(token.expiresAt * 1000).toLocaleDateString()}` : "No expiry";
      details.append(heading, el("p", "small muted", `${permissions[token.profile] || token.profile} · ${expiry}`), metadata);
      if (expired) details.append(el("p", "small muted", "Create a new key to reconnect this app."));
      const actions = el("div", "token-row-actions");
      const toggle = el("button", "button subtle", token.active ? "Disable" : "Reactivate");
      const revoke = el("button", "button subtle token-revoke", "Delete key");
      toggle.type = revoke.type = "button";
      toggle.hidden = expired;
      toggle.setAttribute("aria-label", `${token.active ? "Disable" : "Reactivate"} ${token.name}`);
      toggle.title = token.active ? "Pause access without changing the key" : "Restore access with the same key";
      revoke.setAttribute("aria-label", `Delete ${token.name} permanently`);
      revoke.title = "Permanently remove this key and its access";
      rename.addEventListener("click", () => {
        if (tokensBusy || editingTokenID !== null) return;
        editingTokenID = token.id;
        $("tokens-error").textContent = ""; $("tokens-feedback").textContent = "";
        const form = el("form", "token-rename-form");
        const label = el("label", "", "Key name");
        const input = el("input", ""); input.id = `token-rename-${token.id}`;
        label.htmlFor = input.id;
        input.value = token.name; input.required = true; input.maxLength = 120;
        input.autocomplete = "off";
        const help = el("p", "small muted", "Only the name changes. Your apps keep using the same key.");
        help.id = `token-rename-help-${token.id}`; input.setAttribute("aria-describedby", help.id);
        const error = el("p", "form-error"); error.setAttribute("role", "alert");
        const buttons = el("div", "token-edit-actions");
        const save = el("button", "button primary", "Save name"); save.type = "submit";
        const cancel = el("button", "button subtle", "Cancel"); cancel.type = "button";
        function cancelRename() {
          if (tokensBusy) return;
          editingTokenID = null; renderTokens(tokens, session, token.id, "rename");
        }
        cancel.addEventListener("click", cancelRename);
        input.addEventListener("input", () => { input.setCustomValidity(""); error.textContent = ""; });
        form.addEventListener("keydown", (event) => {
          if (event.key !== "Escape") return;
          event.preventDefault(); event.stopPropagation(); cancelRename();
        });
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          if (tokensBusy || session !== settingsSession) return;
          const name = input.value.trim();
          if (!name || new TextEncoder().encode(name).length > 120) {
            input.setCustomValidity("Enter a name of 1–120 bytes. Shorten names with accented letters or emoji if needed.");
            input.reportValidity(); return;
          }
          if (name === token.name) { cancelRename(); return; }
          setTokensBusy(true); form.setAttribute("aria-busy", "true"); error.textContent = "";
          try {
            await api(`/api/tokens/${token.id}`, { method: "PATCH", body: JSON.stringify({ name }) });
            if (session !== settingsSession) return;
            token.name = name; editingTokenID = null; tokensBusy = false;
            renderTokens(tokens, session, token.id, "rename");
            $("tokens-feedback").textContent = `Key renamed to “${name}”.`;
          } catch (failure) {
            if (session !== settingsSession) return;
            error.textContent = failure.message; setTokensBusy(false); form.removeAttribute("aria-busy"); input.focus();
          }
        });
        buttons.append(save, cancel); form.append(label, input, help, buttons, error);
        heading.hidden = true; details.prepend(form); setTokensBusy(false); input.focus(); input.select();
      });
      async function changeKey(remove) {
        if (tokensBusy || editingTokenID !== null) return;
        if (remove && (!await confirmAction("Delete API key?", `Delete API key “${token.name}” permanently? Apps using it will lose access. This cannot be undone. To pause access, cancel and disable the key instead.`, "Delete API key") || session !== settingsSession || tokensBusy || editingTokenID !== null)) return;
        $("tokens-error").textContent = ""; $("tokens-feedback").textContent = "";
        setTokensBusy(true);
        row.setAttribute("aria-busy", "true");
        const active = !token.active;
        try {
          await api(`/api/tokens/${token.id}`, remove ? { method: "DELETE" } : { method: "PATCH", body: JSON.stringify({ active }) });
          if (session !== settingsSession) return;
          if (remove) tokens = tokens.filter((key) => key.id !== token.id);
          else token.active = active;
          tokensBusy = false;
          renderTokens(tokens, session, remove ? tokens[0]?.id : token.id);
          if (remove && !tokens.length) $("token-name").focus();
          $("tokens-feedback").textContent = `“${token.name}” ${remove ? "deleted permanently" : active ? "reactivated" : "disabled. Apps using this key can no longer connect"}.`;
        } catch (error) {
          if (session !== settingsSession) return;
          $("tokens-error").textContent = error.message;
          setTokensBusy(false);
          row.removeAttribute("aria-busy");
        }
      }
      toggle.addEventListener("click", () => changeKey(false));
      revoke.addEventListener("click", () => changeKey(true));
      const rotate = el("button", "button subtle", "Rotate key"); rotate.type = "button";
      rotate.setAttribute("aria-label", `Rotate ${token.name}`);
      rotate.hidden = !token.active || expired;
      rotate.addEventListener("click", async () => {
        if (tokensBusy || !await confirmAction("Replace API key?", `Replace the key for “${token.name}”? The old key will stop working immediately. Update the connected app with the new key.`, "Replace key") || session !== settingsSession || tokensBusy) return;
        setTokensBusy(true);
        try {
          const result = await api(`/api/tokens/${token.id}/rotate`, { method: "POST" });
          if (session !== settingsSession) return;
          setTokenVisibility(false); $("new-token-value").value = result.token; $("new-token").hidden = false; $("new-token-value").focus();
          $("tokens-feedback").textContent = "Key replaced. Copy the new key into your app; its permissions and expiry are unchanged.";
          await loadTokens(session);
        } catch (error) { if (session === settingsSession) $("tokens-error").textContent = error.message; }
        finally { if (session === settingsSession) setTokensBusy(false); }
      });
      actions.append(toggle, rotate, revoke); row.append(details, actions); $("token-list").append(row);
      if (focusID === token.id) (focusAction === "rename" ? rename : toggle).focus();
    }
    setTokensBusy(tokensBusy);
  }
  function syncSettingsNavigation() {
    document.querySelectorAll("[data-settings-section]").forEach(button => {
      button.disabled = (mfaManagementBusy || deferredLogin) && button.dataset.settingsSection !== "2fa";
    });
    document.querySelectorAll("[data-settings-back]").forEach(button => { button.disabled = mfaManagementBusy; });
    $("settings-section-picker").disabled = mfaManagementBusy || deferredLogin;
  }
  function renderSettings(animate = false) {
    const active = Boolean(settingsSection);
    const entering = active && $("settings-page").hidden;
    $("settings-page").hidden = !active;
    $("library-content").hidden = active;
    $("library-navigation").hidden = active;
    $("settings-navigation").hidden = !active;
    $("sidebar").setAttribute("aria-label", active ? "Settings navigation" : "Library navigation");
    $("app-view").classList.toggle("showing-settings", active);
    $("breadcrumb-current").textContent = active ? "Settings" : showingTags ? "Tags" : currentTitle();
    document.querySelectorAll("[data-settings-panel]").forEach(panel => { panel.hidden = panel.dataset.settingsPanel !== settingsSection; });
    document.querySelectorAll("[data-settings-section]").forEach(button => {
      const selected = button.dataset.settingsSection === settingsSection;
      button.classList.toggle("active", selected);
      if (selected) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
    });
    if (active) $("settings-section-picker").value = settingsSection;
    syncSettingsNavigation();
    if (!active) {
      [$("settings-page"), $("settings-navigation")].forEach(element => activeMotion.get(element)?.cancel());
    } else if (animate && entering) {
      // The rail changes context as the settings workspace settles beside it.
      move($("settings-navigation"), [{ opacity: .75 }, { opacity: 1 }]);
      move($("settings-page"), [{ opacity: .75, transform: "translateX(12px)" }, { opacity: 1, transform: "translateX(0)" }], 220);
    }
  }
  function focusSettings() {
    const heading = document.querySelector(`[data-settings-panel="${settingsSection}"] h2`);
    heading.tabIndex = -1; heading.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  function navigateSettings(section) {
    if (mfaManagementBusy || deferredLogin) return;
    if (!settingsSection) libraryReturnScroll = window.scrollY;
    commitRoute(false, { ...route(), settingsSection: section });
    history.replaceState({ ...history.state, pocketmarkLibraryScroll: libraryReturnScroll }, "");
    restoreRoute();
  }
  document.querySelectorAll("[data-settings-section]").forEach(button => button.addEventListener("click", () => navigateSettings(button.dataset.settingsSection)));
  $("settings-section-picker").addEventListener("change", event => navigateSettings(event.target.value));
  document.querySelectorAll("[data-settings-back]").forEach(button => button.addEventListener("click", () => {
    if (mfaManagementBusy) return;
    commitRoute(false, { ...route(), settingsSection: null });
    history.replaceState({ ...history.state, pocketmarkScroll: libraryReturnScroll }, "");
    if (deferredLogin) { clearSettings(); showLogin(); } else restoreRoute();
  }));
  $("settings-button").addEventListener("click", () => navigateSettings("api-keys"));
  async function loadSettings() {
    const session = ++settingsSession;
    $("settings-error").textContent = "";
    $("tokens-error").textContent = "";
    $("tokens-feedback").textContent = "";
    tokensBusy = false; tokenCount = 0; editingTokenID = null;
    $("token-count").textContent = "";
    $("token-form").querySelector("button[type='submit']").disabled = true;
    $("token-list").replaceChildren(el("li", "token-empty muted", "Loading API keys…"));
    clearNewToken();
    $("account-password").value = "";
    await Promise.all([
      security.loadSessions(),
      loadTokens(session).catch((error) => tokenLoadError(error, session)),
      api("/api/account").then((account) => {
        if (session !== settingsSession) return;
        $("account-username").value = account.username || "";
        $("account-status").textContent = account.passwordEnabled ? "Password sign-in is enabled." : "Password sign-in is not configured.";
      }).catch((error) => { if (session === settingsSession) $("settings-error").textContent = error.message; }),
    ]);
  }
  $("account-form").addEventListener("submit", async (event) => {
    event.preventDefault(); event.submitter.disabled = true; $("settings-error").textContent = "";
    try {
      await api("/api/account", { method: "PUT", body: JSON.stringify({ username: $("account-username").value.trim(), password: $("account-password").value }) });
      $("account-password").value = ""; $("account-status").textContent = "Password sign-in is enabled."; toast("Password updated.");
    } catch (error) { $("settings-error").textContent = error.message; } finally { event.submitter.disabled = false; }
  });
  function clearMFAManagement() {
    $("mfa-manage-form").reset(); $("mfa-manage-verify").reset();
    $("mfa-manage-form").hidden = false;
    $("mfa-manage-enrollment").hidden = $("mfa-manage-codes").hidden = true;
    $("mfa-manage-secret").value = ""; $("mfa-manage-qr").removeAttribute("src");
    $("mfa-manage-codes-value").textContent = "";
    $("mfa-manage-feedback").textContent = $("mfa-manage-error").textContent = "";
  }
  function setMFAManagementBusy(busy) {
    mfaManagementBusy = busy;
    syncSettingsNavigation();
    $("mfa-manage-cancel").disabled = busy;
    document.querySelectorAll("#settings-page > section").forEach(section => { if (section.getAttribute("aria-labelledby") !== "mfa-settings-title") section.inert = busy || deferredLogin; });
    document.querySelectorAll("#mfa-manage-form button[type='submit'], #mfa-manage-verify button[type='submit']").forEach(button => { button.disabled = busy || deferredLogin; });
    if (busy) $("mfa-manage-feedback").textContent = "Updating authentication. Keep settings open until this finishes.";
    else if ($("mfa-manage-feedback").textContent === "Updating authentication. Keep settings open until this finishes.") $("mfa-manage-feedback").textContent = "";
    if (!busy && deferredLogin) showLogin();
  }
  function showManagedCodes(codes) {
    $("mfa-manage-codes-value").textContent = codes.join("\n");
    $("mfa-manage-codes").hidden = false;
    $("mfa-manage-codes-value").focus();
  }
  function normalizeRecoveryCode(code) { return code.trim().replaceAll("-", "").toUpperCase(); }
  function removeManagedRecoveryCode(proof) {
    if ($("mfa-manage-codes").hidden) return false;
    const codes = $("mfa-manage-codes-value").textContent.split("\n");
    const remaining = codes.filter(code => normalizeRecoveryCode(code) !== normalizeRecoveryCode(proof));
    if (remaining.length === codes.length) return false;
    $("mfa-manage-codes-value").textContent = remaining.join("\n");
    $("mfa-manage-codes").hidden = remaining.length === 0;
    return true;
  }
  function mfaOutcomeUncertain(error) {
    if (error.status === 401 && error.message === "invalid authentication code") return false;
    return !error.status || error.status === 401 || error.status === 408 || error.status === 409 || error.status >= 500;
  }
  function mfaManagementFailure(error) {
    if (!mfaOutcomeUncertain(error)) return error.message;
    return "Could not confirm the result. The change may have completed. Use your authenticator to generate recovery codes, or reset MFA locally if needed.";
  }
  $("mfa-manage-form").addEventListener("submit", async event => {
    event.preventDefault(); const session = settingsSession; const button = event.submitter;
    if (mfaManagementBusy) return;
    const previousCodes = $("mfa-manage-codes-value").textContent;
    const previousCodesVisible = !$("mfa-manage-codes").hidden;
    const proof = $("mfa-manage-code").value.trim();
    $("mfa-manage-error").textContent = $("mfa-manage-feedback").textContent = "";
    if (button.value === "codes") { $("mfa-manage-codes").hidden = true; $("mfa-manage-codes-value").textContent = ""; }
    setMFAManagementBusy(true);
    try {
      const replace = button.value === "replace";
      const result = await api(replace ? "/api/mfa/replace" : "/api/mfa/recovery-codes", { method: "POST", body: JSON.stringify({ password: $("mfa-manage-password").value, code: proof }) });
      if (session !== settingsSession) return;
      $("mfa-manage-password").value = $("mfa-manage-code").value = "";
      if (replace) {
        if (removeManagedRecoveryCode(proof)) $("mfa-manage-feedback").textContent = "The recovery code used for this change was removed from the list.";
        $("mfa-manage-form").hidden = true; $("mfa-manage-enrollment").hidden = false;
        $("mfa-manage-secret").value = result.secret; $("mfa-manage-qr").src = result.qr;
        $("mfa-manage-new-code").focus();
      } else { deferredLoginNotice = ""; showManagedCodes(result.recoveryCodes); }
    } catch (error) {
      if (session === settingsSession) {
        if (button.value === "codes" && previousCodesVisible && !mfaOutcomeUncertain(error)) showManagedCodes(previousCodes.split("\n"));
        let proofNotice = "";
        if (/^[0-9A-F]{32}$/.test(normalizeRecoveryCode(proof))) {
          const rejected = error.status === 403 && error.message === "invalid or already used authentication code";
          if (rejected || (button.value === "replace" && error.status !== 400 && error.status !== 403)) {
            const removed = removeManagedRecoveryCode(proof);
            proofNotice = rejected
              ? `The recovery code entered is invalid or has already been used.${removed ? " It was removed from the list." : ""}`
              : `The recovery code entered may have been used.${removed ? " It was removed from the list." : " Try a different code or your authenticator."}`;
            $("mfa-manage-feedback").textContent = proofNotice;
          }
        }
        $("mfa-manage-error").textContent = mfaManagementFailure(error);
        if (mfaOutcomeUncertain(error) || proofNotice) {
          deferredLoginNotice = [mfaOutcomeUncertain(error) ? mfaManagementFailure(error) : "", proofNotice].filter(Boolean).join(" ");
        }
      }
    }
    finally { setMFAManagementBusy(false); }
  });
  $("mfa-manage-verify").addEventListener("submit", async event => {
    event.preventDefault(); const session = settingsSession;
    if (mfaManagementBusy) return;
    const previousCodes = $("mfa-manage-codes-value").textContent;
    const previousCodesVisible = !$("mfa-manage-codes").hidden;
    $("mfa-manage-codes").hidden = true; $("mfa-manage-codes-value").textContent = "";
    $("mfa-manage-error").textContent = "";
    setMFAManagementBusy(true);
    try {
      const result = await api("/api/mfa/verify", { method: "POST", body: JSON.stringify({ code: $("mfa-manage-new-code").value.trim() }) });
      if (session !== settingsSession) return;
      $("mfa-manage-new-code").value = $("mfa-manage-secret").value = ""; $("mfa-manage-qr").removeAttribute("src");
      $("mfa-manage-enrollment").hidden = true; $("mfa-manage-form").hidden = false;
      $("mfa-manage-feedback").textContent = "Authenticator replaced. Other browsers have been signed out.";
      deferredLoginNotice = "";
      showManagedCodes(result.recoveryCodes); void security.loadSessions();
    } catch (error) {
      if (session === settingsSession) {
        if (previousCodesVisible && !mfaOutcomeUncertain(error)) showManagedCodes(previousCodes.split("\n"));
        $("mfa-manage-error").textContent = mfaManagementFailure(error);
        if (mfaOutcomeUncertain(error)) deferredLoginNotice = mfaManagementFailure(error);
      }
    }
    finally { setMFAManagementBusy(false); }
  });
  $("mfa-manage-cancel").addEventListener("click", () => {
    if (mfaManagementBusy) return;
    $("mfa-manage-verify").reset(); $("mfa-manage-secret").value = ""; $("mfa-manage-qr").removeAttribute("src");
    $("mfa-manage-enrollment").hidden = true; $("mfa-manage-form").hidden = false;
    $("mfa-manage-error").textContent = ""; $("mfa-manage-password").focus();
  });
  $("mfa-manage-download").addEventListener("click", () => downloadRecoveryCodes($("mfa-manage-codes-value")));
  $("mfa-manage-secret-copy").addEventListener("click", async () => {
    $("mfa-manage-error").textContent = $("mfa-manage-feedback").textContent = "";
    try { await navigator.clipboard.writeText($("mfa-manage-secret").value); $("mfa-manage-feedback").textContent = "Setup key copied."; }
    catch { $("mfa-manage-secret").select(); $("mfa-manage-error").textContent = "Select and copy the setup key shown above."; }
  });
  $("mfa-manage-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("mfa-manage-codes-value").textContent); $("mfa-manage-feedback").textContent = "Recovery codes copied."; }
    catch { $("mfa-manage-error").textContent = "Select and copy the recovery codes shown above."; }
  });
  $("token-form").addEventListener("submit", async (event) => {
    const session = settingsSession;
    event.preventDefault();
    if (tokensBusy || editingTokenID !== null || tokenCount >= 32) return;
    setTokensBusy(true); $("tokens-error").textContent = ""; $("tokens-feedback").textContent = "";
    try {
      const token = await api("/api/tokens", { method: "POST", body: JSON.stringify({ name: $("token-name").value.trim(), profile: $("token-profile").value, expiresAt: Number($("token-expiry").value) ? Math.floor(Date.now() / 1000) + Number($("token-expiry").value) * 86400 : 0 }) });
      if (session !== settingsSession) return;
      setTokenVisibility(false);
      $("new-token-value").value = token.token; $("new-token").hidden = false; $("token-name").value = "";
      $("new-token-value").focus();
      await loadTokens(session);
    } catch (error) { if (session === settingsSession) $("tokens-error").textContent = error.message; } finally { if (session === settingsSession) setTokensBusy(false); }
  });
  $("toggle-token").addEventListener("click", () => setTokenVisibility($("new-token-value").type === "password"));
  $("copy-token").addEventListener("click", async () => { try { await navigator.clipboard.writeText($("new-token-value").value); toast("Key copied."); } catch { setTokenVisibility(true); $("new-token-value").select(); toast("Select and copy the key."); } });
  function clearSettings() {
    security.clear();
    settingsSession++; editingTokenID = null; $("account-password").value = ""; clearNewToken(); clearMFAManagement();
  }
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
