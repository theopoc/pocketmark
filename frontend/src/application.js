import { disposeRegions } from "./lib/render.jsx";
import { createSettings } from "./features/settings/controller.js";
import { createLifecycle } from "./lib/lifecycle.js";
import {
  renderBreadcrumbs,
  renderFilter,
  renderCollectionNavigation,
  renderFrequentTags,
} from "./features/library/navigation";
import { iconPaths } from "./lib/icons";
import { renderBookmarks } from "./features/library/bookmarks";
import PocketmarkWorkspace from "./features/workspace.js";
import PocketmarkReader from "./features/reader.js";
import PocketmarkBulk from "./features/bulk.js";
import PocketmarkSelection from "./features/selection.js";
import PocketmarkTagPicker from "./features/tag-picker.js";
import PocketmarkSecurity from "./features/security.js";
import PocketmarkSelect from "../../internal/webui/static/select.js";
import PocketmarkThemeSwitch from "../../internal/webui/static/theme-switch.js";
import PocketmarkNameLimit from "../../internal/webui/static/name-limit.js";
("use strict");

export function createApplication() {
  const lifecycle = createLifecycle(window);
  const $ = (id) => document.getElementById(id);
  PocketmarkSelect.enhanceAll(document);
  const state = {
    settingsSection: null,
    settingsSession: 0,
    mfaManagementBusy: false,
    deferredLogin: false,
    deferredLoginNotice: "",
    libraryReturnScroll: 0,

    filter: "all",
    collection: null,
    tag: "",
    query: "",
    page: 1,
    pageSize: 40,
    total: 0,
    links: [],
    collections: [],
    editing: null,
    request: 0,
    timer: null,
    signedIn: false,
    sort: "newest",
    editingCollection: null,
  };
  let toastTimer,
    toastActionPending = false;
  let expandedBookmarkActions = null;
  const expandedBookmarkTags = new Set();
  let searchTimer;
  let tagsTimer;
  let tagsPage = 1;
  let tagsRequest = 0;
  let showingTags = false;
  const workspace = PocketmarkWorkspace;
  const {
    editableBookmark: editable,
    bookmarkDraftKey: draftKey,
    safeURL,
    domain,
  } = workspace;
  let draftStorage;
  try {
    draftStorage = window.sessionStorage;
  } catch {
    /* Private browsing may deny storage. */
  }
  const drafts = workspace.createDrafts(draftStorage);
  const tagPickers = new Map();
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const activeMotion = new Map();
  let renderedLibraryRoute = null;
  let libraryUnavailable = false;
  let libraryLoading = false;
  let refreshRequest = 0;
  const sharedParams = new URLSearchParams(location.search);
  let editorBaseline = null;
  let editorSession = 0;
  let routeRequest = 0;
  let scrollTimer;
  let searchSession = false;
  let tagsSearchSession = false;
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";

  function route() {
    return {
      ...state,
      settingsSection: state.settingsSection,
      showingTags,
      tagsPage,
      tagsQuery: $("tags-search").value.trim(),
    };
  }
  function rememberScroll() {
    lifecycle.cancelTimeout(scrollTimer);
    history.replaceState(
      { ...history.state, pocketmarkScroll: window.scrollY },
      "",
    );
  }
  function commitRoute(replace = false, destination = route()) {
    const url = location.pathname + workspace.routeSearch(destination);
    if (url === location.pathname + location.search) return;
    routeRequest++;
    rememberScroll();
    history[replace ? "replaceState" : "pushState"](
      { pocketmarkScroll: 0 },
      "",
      url,
    );
  }
  async function restoreRoute(initial = false) {
    const request = ++routeRequest;
    lifecycle.cancelTimeout(searchTimer);
    lifecycle.cancelTimeout(tagsTimer);
    const restored = workspace.readRoute(location.search);
    if (
      state.settingsSection &&
      (state.mfaManagementBusy || state.deferredLogin) &&
      restored.settingsSection !== state.settingsSection
    ) {
      history.replaceState(
        { ...history.state },
        "",
        location.pathname + workspace.routeSearch(route()),
      );
      return;
    }
    const wasSettings = Boolean(state.settingsSection);
    if (!wasSettings && restored.settingsSection)
      state.libraryReturnScroll = history.state?.pocketmarkLibraryScroll || 0;
    state.settingsSection = restored.settingsSection;
    if (wasSettings && !state.settingsSection) clearSettings();
    renderSettings(!initial);
    const scroll = history.state?.pocketmarkScroll || 0;
    const previous = workspace.routeSearch(route());
    Object.assign(state, {
      filter: restored.filter,
      collection: restored.collection,
      tag: restored.tag,
      query: restored.query,
      page: restored.page,
      sort: restored.sort,
    });
    showingTags = restored.showingTags;
    tagsPage = restored.tagsPage;
    $("search").value = state.query;
    $("tags-search").value = restored.tagsQuery;
    syncSortMenu();
    closeSortMenu();
    $("tags-view").hidden = !showingTags;
    $("library-view").hidden = showingTags;
    if (!initial && previous !== workspace.routeSearch(route())) bulk.clear();
    reader.close();
    bulk.close();
    document.querySelectorAll("dialog[open]").forEach((dialog) => {
      dialog.close();
    });
    if (state.settingsSection) {
      lifecycle.cancelTimeout(state.timer);
      state.request++;
      focusSettings();
      if (!wasSettings) await loadSettings();
      return;
    }
    await refresh();
    if (request !== routeRequest) return;
    if (showingTags) await loadTagDirectory();
    if (request !== routeRequest) return;
    if (!initial)
      $(showingTags ? "tags-title" : "page-title").focus({
        preventScroll: true,
      });
    requestAnimationFrame(() => {
      if (request === routeRequest)
        window.scrollTo({ top: scroll, behavior: "instant" });
    });
  }
  lifecycle.listen(
    window,
    "scroll",
    () => {
      lifecycle.cancelTimeout(scrollTimer);
      scrollTimer = lifecycle.timeout(rememberScroll, 150);
    },
    { passive: true },
  );
  lifecycle.listen(window, "popstate", () => {
    if (state.signedIn) restoreRoute();
  });
  lifecycle.listen(document.querySelector(".skip-link"), "click", (event) => {
    event.preventDefault();
    $("main-content").focus();
  });
  lifecycle.listen(window, "beforeunload", (event) => {
    if (
      drafts.size ||
      state.mfaManagementBusy ||
      (Boolean(state.settingsSection) && !$("mfa-manage-codes").hidden)
    ) {
      event.preventDefault();
      event.returnValue = "";
    }
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
    const animation = element.animate(frames, {
      duration,
      easing: "cubic-bezier(0.16, 1, 0.3, 1)",
    });
    activeMotion.set(element, animation);
    animation.finished
      .catch(() => {})
      .then(() => {
        if (activeMotion.get(element) === animation)
          activeMotion.delete(element);
      });
  }
  lifecycle.listen(reducedMotion, "change", () => {
    if (reducedMotion.matches) {
      activeMotion.forEach((animation) => animation.cancel());
      activeMotion.clear();
    }
  });

  // Small, authored SVG icons keep the embedded UI independent of icon libraries.
  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const [key, value] of Object.entries({
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.7",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
      focusable: "false",
      class: "icon",
    }))
      svg.setAttribute(key, value);
    for (const d of iconPaths[name] || iconPaths.bookmark) {
      const path = document.createElementNS(svg.namespaceURI, "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    return svg;
  }
  document
    .querySelectorAll("[data-icon]")
    .forEach((node) => node.replaceChildren(icon(node.dataset.icon)));

  function applyTheme(theme) {
    const dark = theme === "dark";
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]').content = dark
      ? "#15161b"
      : "#ffffff";
    document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
      button.setAttribute("aria-pressed", String(dark));
      button.setAttribute("aria-label", dark ? "Dark mode" : "Light mode");
      button.title = dark ? "Switch to light mode" : "Switch to dark mode";
      button
        .querySelector("[data-theme-icon]")
        .replaceChildren(icon(dark ? "moon" : "sun"));
      button.querySelector("[data-theme-label]").textContent = dark
        ? "Dark"
        : "Light";
    });
  }
  const themeSwitch = PocketmarkThemeSwitch.create({
    initial:
      document.documentElement.dataset.theme === "light" ? "light" : "dark",
    apply: applyTheme,
  });
  applyTheme(themeSwitch.requested);
  document.querySelectorAll("[data-theme-toggle]").forEach((button) =>
    lifecycle.listen(button, "click", () => {
      const theme = themeSwitch.requested === "dark" ? "light" : "dark";
      themeSwitch.set(theme);
      try {
        localStorage.setItem("pocketmark-theme", theme);
      } catch {
        /* Keep the session choice when storage is unavailable. */
      }
    }),
  );

  let libraryView = "list";
  try {
    if (localStorage.getItem("pocketmark-view") === "grid")
      libraryView = "grid";
  } catch {
    /* Storage is optional. */
  }
  function setLibraryView(view) {
    const changed =
      $("bookmark-grid").classList.contains("view-list") !== (view === "list");
    libraryView = view;
    $("bookmark-grid").classList.toggle("view-list", view === "list");
    if (state.signedIn) renderLinks();
    for (const value of ["list", "grid"])
      $("view-" + value).setAttribute("aria-pressed", String(view === value));
    try {
      localStorage.setItem("pocketmark-view", view);
    } catch {
      /* Private browsing may disallow storage. */
    }
    if (changed && state.signedIn)
      move($("bookmark-grid"), [{ opacity: 0.8 }, { opacity: 1 }]);
  }
  lifecycle.listen($("view-list"), "click", () => setLibraryView("list"));
  lifecycle.listen($("view-grid"), "click", () => setLibraryView("grid"));
  setLibraryView(libraryView);

  const navigation = $("navigation-dialog");
  const sidebar = $("sidebar");
  const navigationHost = $("navigation-root");
  const toastHost = $("toast-root");
  const desktopNavigation = matchMedia(
    "(min-width: 901px) and (hover: hover) and (pointer: fine)",
  );
  const sidebarRail = document.createElement("div");
  sidebarRail.className = "sidebar-rail";
  let sidebarFixed = false;
  try {
    sidebarFixed = localStorage.getItem("pocketmark-sidebar") === "fixed";
  } catch {
    /* Storage is optional. */
  }
  function renderSidebarMode() {
    $("app-view").classList.toggle(
      "sidebar-fixed",
      desktopNavigation.matches && sidebarFixed,
    );
    const button = $("sidebar-mode");
    const label = sidebarFixed
      ? "Hide navigation automatically"
      : "Keep navigation open";
    button.setAttribute("aria-pressed", String(sidebarFixed));
    button.setAttribute("aria-label", label);
    button.title = label;
    $("sidebar-mode-icon").replaceChildren(
      icon(sidebarFixed ? "panel-close" : "panel-open"),
    );
  }
  function arrangeNavigation() {
    navigationHost.hidden = false;
    if (navigation.open) navigation.close();
    closeWorkspacePopover();
    if (desktopNavigation.matches) {
      $("app-view").insertBefore(sidebarRail, $("main-content"));
      sidebarRail.append(navigationHost);
    } else {
      navigation.append(navigationHost);
      sidebarRail.remove();
    }
    $("open-navigation").setAttribute(
      "aria-controls",
      desktopNavigation.matches ? "sidebar" : "navigation-dialog",
    );
    if (desktopNavigation.matches)
      $("open-navigation").removeAttribute("aria-expanded");
    else $("open-navigation").setAttribute("aria-expanded", "false");
    renderSidebarMode();
  }
  lifecycle.listen($("sidebar-mode"), "click", () => {
    sidebarFixed = !sidebarFixed;
    if (!sidebarFixed) {
      sidebarRail.classList.toggle("dismissed", sidebarRail.matches(":hover"));
      sidebarRail.classList.remove("revealed");
      $("open-navigation").focus({ preventScroll: true });
    } else sidebarRail.classList.remove("dismissed");
    try {
      localStorage.setItem(
        "pocketmark-sidebar",
        sidebarFixed ? "fixed" : "auto",
      );
    } catch {
      /* Storage is optional. */
    }
    renderSidebarMode();
  });
  lifecycle.listen(sidebarRail, "pointerleave", () =>
    sidebarRail.classList.remove("dismissed"),
  );
  lifecycle.listen(sidebar, "focusout", (event) => {
    if (!sidebar.contains(event.relatedTarget))
      sidebarRail.classList.remove("revealed");
  });
  lifecycle.listen(desktopNavigation, "change", arrangeNavigation);
  const workspaceButton = $("workspace-button");
  const workspacePopover = $("workspace-popover");
  function closeWorkspacePopover() {
    if (workspacePopover.matches(":popover-open"))
      workspacePopover.hidePopover();
  }
  function positionWorkspacePopover() {
    const anchor = workspaceButton.getBoundingClientRect();
    const width = Math.min(224, window.innerWidth - 16);
    workspacePopover.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8))}px`;
    workspacePopover.style.top = `${Math.max(8, anchor.bottom + 4)}px`;
    workspacePopover.style.maxHeight = `${Math.max(44, window.innerHeight - anchor.bottom - 12)}px`;
  }
  lifecycle.listen(workspacePopover, "beforetoggle", (event) => {
    workspaceButton.setAttribute(
      "aria-expanded",
      String(event.newState === "open"),
    );
    if (event.newState === "open") positionWorkspacePopover();
  });
  lifecycle.listen(
    workspacePopover,
    "click",
    (event) => {
      if (event.target.closest("button")) closeWorkspacePopover();
    },
    true,
  );
  lifecycle.listen(window, "resize", closeWorkspacePopover);
  lifecycle.listen($("sidebar"), "scroll", closeWorkspacePopover);
  arrangeNavigation();
  function closeNavigation() {
    closeWorkspacePopover();
    if (desktopNavigation.matches) {
      sidebarRail.classList.remove("revealed");
      if (sidebar.contains(document.activeElement))
        $("main-content").focus({ preventScroll: true });
      return;
    }
    if (!navigation.open) return;
    navigation.close();
    $("open-navigation").setAttribute("aria-expanded", "false");
    $("open-navigation").focus({ preventScroll: true });
  }
  lifecycle.listen($("open-navigation"), "click", () => {
    if (desktopNavigation.matches) {
      sidebarRail.classList.add("revealed");
      $("sidebar-mode").focus();
      return;
    }
    navigation.showModal();
    $("open-navigation").setAttribute("aria-expanded", "true");
    $("close-navigation").focus();
  });
  lifecycle.listen($("close-navigation"), "click", closeNavigation);
  lifecycle.listen(navigation, "cancel", (event) => {
    event.preventDefault();
    closeNavigation();
  });
  lifecycle.listen(navigation, "close", () => {
    if (!navigation.open) closeWorkspacePopover();
    if (!desktopNavigation.matches)
      $("open-navigation").setAttribute(
        "aria-expanded",
        String(navigation.open),
      );
  });
  lifecycle.listen(
    $("sidebar"),
    "click",
    (event) => {
      const button = event.target.closest("button");
      if (
        button &&
        button.id !== "close-navigation" &&
        button.id !== "sidebar-mode" &&
        !button.hasAttribute("data-keep-navigation")
      )
        closeNavigation();
    },
    true,
  );

  function toast(message, error = false, action = null, favorite = null) {
    lifecycle.cancelTimeout(toastTimer);
    toastActionPending = true;
    const notice = $("toast");
    // Native dialogs live in the top layer. Feedback must be in that same
    // layer to be visible and exposed to assistive technology.
    const dialogs = [...document.querySelectorAll("dialog[open]")];
    (dialogs.at(-1) || document.body).append(toastHost);
    notice.replaceChildren(el("span", "toast-message", message));
    notice.className = error ? "error" : "";
    if (!error && favorite !== null) {
      notice.classList.add("favorite-notice");
      notice.classList.toggle("is-added", favorite);
      notice.prepend(icon("star"));
    }
    notice.setAttribute("role", error ? "alert" : "status");
    if (action) {
      const button = el("button", "toast-action", action.label);
      button.type = "button";
      lifecycle.listen(button, "click", async () => {
        lifecycle.cancelTimeout(toastTimer);
        toastActionPending = true;
        button.disabled = true;
        try {
          await action.run();
        } catch (error) {
          toast(error.message, true);
        }
      });
      notice.append(button);
    }
    notice.hidden = false;
    toastActionPending = false;
    toastTimer = lifecycle.timeout(
      () => {
        notice.hidden = true;
      },
      action || error ? 12000 : 5000,
    );
  }
  lifecycle.listen($("toast"), "focusin", () =>
    lifecycle.cancelTimeout(toastTimer),
  );
  lifecycle.listen($("toast"), "focusout", (event) => {
    const notice = $("toast");
    if (
      !notice.hidden &&
      !toastActionPending &&
      !notice.contains(event.relatedTarget)
    ) {
      toastTimer = lifecycle.timeout(() => {
        notice.hidden = true;
      }, 12000);
    }
  });
  document.querySelectorAll("dialog").forEach((dialog) =>
    lifecycle.listen(dialog, "close", () => {
      if (dialog.contains($("toast"))) {
        lifecycle.cancelTimeout(toastTimer);
        $("toast").hidden = true;
        document.body.append(toastHost);
      }
    }),
  );

  let setupRequired = false;
  function resetMFALogin() {
    ["mfa-enrollment", "mfa-code-form", "mfa-login-codes", "mfa-back"].forEach(
      (id) => {
        $(id).hidden = true;
      },
    );
    $("login-form").hidden = false;
    $("mfa-code").value = $("mfa-secret").value = "";
    $("mfa-login-codes-value").textContent = "";
    $("mfa-qr").removeAttribute("src");
    $("login-help").hidden = false;
  }
  function showLogin() {
    closeNavigation();
    if (
      state.mfaManagementBusy ||
      (Boolean(state.settingsSection) && !$("mfa-manage-codes").hidden)
    ) {
      state.deferredLogin = true;
      state.settingsSection = "2fa";
      history.replaceState(
        { ...history.state },
        "",
        location.pathname + workspace.routeSearch(route()),
      );
      renderSettings();
      if (!state.mfaManagementBusy) {
        document
          .querySelectorAll("#settings-page > section")
          .forEach((section) => {
            if (
              section.getAttribute("aria-labelledby") !== "mfa-settings-title"
            )
              section.inert = true;
          });
        document
          .querySelectorAll(
            "#mfa-manage-form button[type='submit'], #mfa-manage-verify button[type='submit']",
          )
          .forEach((button) => {
            button.disabled = true;
          });
      }
      $("mfa-manage-feedback").textContent = state.mfaManagementBusy
        ? "Your session expired. Waiting for the authentication change to finish."
        : "Your session expired. These recovery codes may have changed. Save them, then sign in and generate new codes.";
      return;
    }
    state.deferredLogin = false;
    $("import-result").hidden = true;
    clearSettings();
    state.settingsSection = null;
    renderSettings();
    setMFAManagementBusy(false);
    lifecycle.cancelTimeout(tagsTimer);
    tagsRequest++;
    state.signedIn = false;
    renderedLibraryRoute = null;
    libraryUnavailable = true;
    expandedBookmarkTags.clear();
    state.links = [];
    bulk.clear();
    state.request++;
    lifecycle.cancelTimeout(state.timer);
    reader.close();
    bulk.close();
    document
      .querySelectorAll("dialog[open]")
      .forEach((dialog) => dialog.close());
    $("app-view").hidden = true;
    $("login-view").hidden = false;
    resetMFALogin();
    if (state.deferredLoginNotice) {
      $("login-error").textContent = state.deferredLoginNotice;
      state.deferredLoginNotice = "";
    }
    $("login-username").focus();
  }

  async function api(path, options = {}, retried = false) {
    const headers = new Headers(options.headers || {});
    if (options.body && !headers.has("Content-Type"))
      headers.set("Content-Type", "application/json");
    let response;
    try {
      response = await fetch(path, {
        ...options,
        headers,
        credentials: "same-origin",
      });
    } catch {
      throw new Error(workspace.requestFailure(0));
    }
    let body = null;
    if (response.status !== 204) {
      let text;
      try {
        text = await response.text();
      } catch {
        throw new Error(workspace.requestFailure(0));
      }
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          throw new Error(
            "The server returned an unexpected response. Please try again.",
          );
        }
      }
    }
    if (!response.ok) {
      if (body?.code === "reauth_required" && !retried) {
        await security.confirm();
        return api(path, options, true);
      }
      const loginPath = [
        "/api/login",
        "/api/setup",
        "/api/mfa/enroll",
        "/api/mfa/verify",
      ].includes(path);
      if (response.status === 401 && !loginPath) {
        const expired = state.signedIn;
        const recoveryNotice = state.deferredLoginNotice;
        showLogin();
        if (expired && !recoveryNotice)
          $("login-error").textContent = workspace.requestFailure(401);
      }
      const message =
        response.status === 401 && loginPath
          ? body?.error || "Check your credentials, then try again."
          : workspace.requestFailure(
              response.status,
              body?.error,
              loginPath ? body?.code : "",
            );
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return body;
  }

  const security = PocketmarkSecurity.create({
    api,
    toast,
    onSessionExpired: showLogin,
  });

  const reader = PocketmarkReader.create({
    api,
    drafts,
    toast,
    confirmAction,
    onEdit: openEditor,
    onChange: () => refresh(true),
    onSessionExpired: showLogin,
  });

  const bulk = PocketmarkBulk.create({
    api,
    toast,
    onChange: () => refresh(true),
    onSelectionChange: syncBookmarkSelection,
    fillCollections,
    icon,
    defaultCollection: () =>
      state.filter === "collection" ? state.collection : null,
    onSessionExpired: showLogin,
  });

  const selection = PocketmarkSelection.create({
    grid: $("bookmark-grid"),
    bulk,
    links: () => (libraryLoading || libraryUnavailable ? [] : state.links),
    onChange: syncBookmarkSelection,
  });
  function syncBookmarkSelection() {
    for (const card of $("bookmark-grid").querySelectorAll(".bookmark-card")) {
      const selected = bulk.has(Number(card.dataset.id));
      card.classList.toggle("is-selected", selected);
      card.setAttribute(
        "aria-label",
        `${card.dataset.label}${selected ? ", selected" : ""}`,
      );
    }
  }

  // Snapshot only visible cards; exits are inert and siblings retain their positions.
  function bookmarkPositions() {
    const grid = $("bookmark-grid");
    if (grid.hidden || reducedMotion.matches || document.hidden) return [];
    return [...grid.children].map((node) => ({
      node: node.cloneNode(true),
      id: node.dataset.id,
      rect: node.getBoundingClientRect(),
    }));
  }
  function transitionBookmarks(previous) {
    const grid = $("bookmark-grid"),
      current = new Map(
        [...grid.children].map((node) => [node.dataset.id, node]),
      );
    if (
      reducedMotion.matches ||
      !previous.some((entry) => !current.has(entry.id))
    )
      return;
    for (const { node, id, rect } of previous) {
      const next = current.get(id);
      if (next) {
        const target = next.getBoundingClientRect();
        move(
          next,
          [
            {
              transform: `translate(${rect.left - target.left}px, ${rect.top - target.top}px)`,
            },
            { transform: "none" },
          ],
          200,
        );
      } else if (node.animate) {
        const layer = el(
          "div",
          `bookmark-exit-layer bookmark-grid${grid.classList.contains("view-list") ? " view-list" : ""}`,
        );
        layer.inert = true;
        layer.setAttribute("aria-hidden", "true");
        // Detached cards must not duplicate IDs or load archive thumbnails again.
        node
          .querySelectorAll("[id]")
          .forEach((child) => child.removeAttribute("id"));
        layer.append(node);
        Object.assign(layer.style, {
          left: `${rect.left}px`,
          top: `${rect.top}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
        });
        document.body.append(layer);
        move(
          layer,
          [
            { opacity: 1, transform: "scale(1)" },
            { opacity: 0, transform: "scale(.98)" },
          ],
          140,
        );
        const animation = activeMotion.get(layer);
        if (animation)
          animation.finished.catch(() => {}).then(() => layer.remove());
        else layer.remove();
      }
    }
  }

  function collectionLabel(id) {
    return (
      state.collections.find(
        (collection) => String(collection.id) === String(id),
      )?.name || "Collection"
    );
  }

  function currentTitle() {
    if (state.tag) return `#${state.tag}`;
    if (state.filter === "collection") return collectionLabel(state.collection);
    return {
      all: "All bookmarks",
      inbox: "Inbox",
      favorite: "Favorites",
      unread: "To read",
    }[state.filter];
  }

  lifecycle.listen(
    $("breadcrumb"),
    "scroll",
    () => {
      const root = $("breadcrumb");
      root.classList.toggle("has-earlier-crumbs", root.scrollLeft > 1);
    },
    { passive: true },
  );

  function renderBreadcrumb() {
    const root = $("breadcrumb"),
      key = focusedKey(root);
    const crumbs = [
      {
        label: "My library",
        key: "root",
        action: () => {
          if (state.settingsSection) {
            leaveSettings(true);
            return;
          }
          selectFilter("all");
        },
      },
    ];
    if (state.settingsSection) {
      crumbs.push({
        label: "Settings",
        key: "settings",
        action: () => navigateSettings(state.settingsSection),
      });
    } else if (showingTags) {
      crumbs.push({
        label: "Tags",
        key: "tags",
        action: () => $("all-tags").click(),
      });
    } else if (!state.tag && state.filter === "collection") {
      const seen = new Set();
      let collection = state.collections.find(
        (item) => String(item.id) === String(state.collection),
      );
      const parents = [];
      while (collection && !seen.has(collection.id)) {
        seen.add(collection.id);
        parents.unshift(collection);
        collection = state.collections.find(
          (item) => String(item.id) === String(collection.parentId),
        );
      }
      if (!parents.length)
        crumbs.push({
          label: "Collection",
          key: "current",
          action: () => selectFilter("collection", state.collection),
        });
      for (const item of parents)
        crumbs.push({
          label: item.name,
          key: `collection:${item.id}`,
          action: () => selectFilter("collection", item.id),
        });
    } else {
      crumbs.push({
        label: currentTitle(),
        key: "current",
        action: () => selectFilter(state.filter, state.collection, state.tag),
      });
    }
    const signature = JSON.stringify(
      crumbs.map((crumb) => [crumb.key, crumb.label]),
    );
    const changed = root.dataset.signature !== signature;
    root.dataset.signature = signature;
    renderBreadcrumbs(
      root,
      crumbs,
      Boolean(state.settingsSection && state.mfaManagementBusy),
    );
    restoreFocus(root, key);
    if (changed && !key)
      requestAnimationFrame(() => {
        if (root.dataset.signature === signature)
          root.scrollLeft = root.scrollWidth;
      });
  }

  function updateHeading() {
    const title = currentTitle();
    $("page-title").textContent = title;
    renderBreadcrumb();
    $("tags-library-context").hidden = !state.query;
    $("tags-library-context").textContent =
      `Your bookmark search “${state.query}” will remain applied when you open a tag.`;
    $("all-tags").classList.toggle("active", showingTags);
    if (showingTags) $("all-tags").setAttribute("aria-current", "page");
    else $("all-tags").removeAttribute("aria-current");
    const descriptions = {
      all: "Everything you save, in one place.",
      inbox: "Saved links waiting to be organized.",
      favorite: "The bookmarks you want to keep close.",
      unread: "Your reading list, ready when you are.",
      collection: "Bookmarks organized in this collection.",
    };
    $("page-subtitle").textContent = state.tag
      ? `Bookmarks tagged #${state.tag}.`
      : descriptions[state.filter];
    document.querySelectorAll("[data-filter]").forEach((button) => {
      const active =
        !showingTags && !state.tag && button.dataset.filter === state.filter;
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    document.querySelectorAll("[data-quick-filter]").forEach((button) => {
      button.setAttribute(
        "aria-pressed",
        String(
          !showingTags &&
            !state.tag &&
            button.dataset.quickFilter === state.filter,
        ),
      );
    });
    renderActiveFilters();
  }

  function renderActiveFilters() {
    const root = $("active-filters"),
      key = focusedKey(root);
    renderFilter(root, state.query, () => {
      lifecycle.cancelTimeout(searchTimer);
      state.query = "";
      $("search").value = "";
      state.page = 1;
      commitRoute();
      refresh();
      $("page-title").focus();
    });
    root.hidden = !state.query;
    restoreFocus(root, key);
  }

  function focusedKey(root) {
    return root.contains(document.activeElement)
      ? document.activeElement.dataset.focusKey
      : null;
  }
  function restoreFocus(root, key) {
    if (
      !key ||
      document.activeElement !== document.body ||
      document.querySelector("dialog[open]")
    )
      return;
    const target = [...root.querySelectorAll("[data-focus-key]")].find(
      (node) => node.dataset.focusKey === key,
    );
    (
      target ||
      root.querySelector(".card-title button") ||
      $("page-title")
    ).focus({ preventScroll: true });
  }

  function selectFilter(
    filter,
    collection = null,
    tag = "",
    focusHeading = true,
  ) {
    lifecycle.cancelTimeout(searchTimer);
    state.query = $("search").value.trim();
    lifecycle.cancelTimeout(tagsTimer);
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
    if (focusHeading) $("page-title").focus();
  }

  function orderedCollections() {
    const result = [],
      seen = new Set();
    function visit(parentId, depth) {
      for (const collection of state.collections) {
        if (
          (collection.parentId ?? null) !== parentId ||
          seen.has(collection.id)
        )
          continue;
        seen.add(collection.id);
        result.push({ ...collection, depth });
        visit(collection.id, depth + 1);
      }
    }
    visit(null, 0);
    for (const collection of state.collections)
      if (!seen.has(collection.id)) result.push({ ...collection, depth: 0 });
    return result;
  }
  function fillCollections(select, selected, emptyLabel = "Inbox") {
    select.replaceChildren();
    const first = el("option", "", emptyLabel);
    first.value = "";
    select.append(first);
    for (const collection of orderedCollections()) {
      const option = el(
        "option",
        "",
        `${"— ".repeat(Math.min(collection.depth, 6))}${collection.name}`,
      );
      option.value = collection.id;
      select.append(option);
    }
    select.value = selected == null ? "" : String(selected);
  }

  function renderCollections() {
    const key = focusedKey($("collections"));
    renderCollectionNavigation($("collections"), {
      collections: orderedCollections(),
      activeID:
        !showingTags && state.filter === "collection" ? state.collection : null,
      parentLabel: collectionLabel,
      onSelect: (collection) => selectFilter("collection", collection.id),
      onEdit: openCollectionEditor,
      onDelete: async (collection, remove) => {
        if (
          !(await confirmAction(
            "Delete collection?",
            `Delete “${collection.name}”? Bookmarks directly in it move to Inbox. Direct subcollections move to the library root.`,
            "Delete collection",
          )) ||
          !remove.isConnected ||
          !state.signedIn
        )
          return;
        remove.disabled = true;
        try {
          await api(`/api/collections/${collection.id}`, { method: "DELETE" });
          if (state.filter === "collection") {
            state.filter = "all";
            state.collection = null;
            state.page = 1;
          }
          commitRoute(true);
          await refresh();
          toast("Collection deleted. Bookmarks kept.");
        } catch (error) {
          toast(error.message, true);
        } finally {
          if (remove.isConnected) remove.disabled = false;
        }
      },
    });
    restoreFocus($("collections"), key);
  }

  function renderTags(tags) {
    $("frequent-tags-heading").hidden = !tags.length;
    const key = focusedKey($("tags"));
    renderFrequentTags($("tags"), tags, state.tag, (name) =>
      selectFilter("all", null, state.tag === name ? "" : name),
    );
    restoreFocus($("tags"), key);
  }

  function disableTagAlphabet() {
    $("tags-letter-picker").disabled = true;
    $("tags-alphabet")
      .querySelectorAll("button")
      .forEach((button) => {
        button.disabled = true;
      });
  }

  function renderTagAlphabet(groups, activeLetter) {
    const available = new Map(
      groups.map((group) => [group.letter, group.count]),
    );
    $("tags-alphabet").replaceChildren();
    $("tags-letter-picker").replaceChildren(
      el("option", "", "Choose a letter"),
    );
    $("tags-letter-picker").firstElementChild.value = "";
    for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ#") {
      const button = el("button", "tag-letter-link", letter);
      const count = available.get(letter) || 0;
      button.disabled = !count;
      button.setAttribute(
        "aria-label",
        `${letter === "#" ? "Other characters" : letter}: ${count} tag${count === 1 ? "" : "s"}`,
      );
      if (letter === activeLetter)
        button.setAttribute("aria-current", "location");
      lifecycle.listen(button, "click", () => {
        lifecycle.cancelTimeout(tagsTimer);
        loadTagDirectory(letter);
      });
      $("tags-alphabet").append(button);
      if (count) {
        const option = el(
          "option",
          "",
          letter === "#" ? "Other characters" : letter,
        );
        option.value = letter;
        $("tags-letter-picker").append(option);
      }
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
      if (tagsPage > pages) {
        tagsPage = pages;
        return loadTagDirectory();
      }
      const sections = new Map();
      for (const tag of result.tags) {
        if (!sections.has(tag.letter)) {
          const section = el("section", "tag-index-group");
          const heading = el("h2", "tag-index-letter", tag.letter);
          heading.id = `tags-letter-${tag.letter === "#" ? "other" : tag.letter}`;
          heading.tabIndex = -1;
          if (tag.letter === "#")
            heading.setAttribute("aria-label", "Other characters");
          section.setAttribute("aria-labelledby", heading.id);
          const rows = el("div", "tag-group-rows");
          section.append(heading, rows);
          sections.set(tag.letter, rows);
          $("tags-list").append(section);
        }
        const button = el("button", "tag-directory-row");
        const name = el("span", "tag-directory-name", `#${tag.name}`);
        const count = el("span", "tag-directory-count", String(tag.count));
        count.setAttribute(
          "aria-label",
          `${tag.count} bookmark${tag.count === 1 ? "" : "s"}`,
        );
        button.append(name, count, icon("chevron-right"));
        lifecycle.listen(button, "click", () => {
          lifecycle.cancelTimeout(searchTimer);
          selectFilter("all", null, tag.name);
          $("page-title").focus();
        });
        sections.get(tag.letter).append(button);
      }
      renderTagAlphabet(result.groups, jump || result.tags[0]?.letter);
      $("tags-results").textContent =
        `${result.total} tag${result.total === 1 ? "" : "s"}${query ? ` matching “${query}”` : " in your library"}`;
      $("tags-empty-state").hidden = result.total > 0;
      $("tags-index-layout").hidden = result.total === 0;
      $("tags-letter-control").hidden = result.total === 0;
      $("tags-clear-search").hidden = !query;
      $("tags-browse-bookmarks").hidden = !!query;
      $("tags-empty-art").replaceChildren(icon(query ? "search" : "tag"));
      $("tags-empty-title").textContent = query
        ? "No tags found"
        : "No tags yet";
      $("tags-empty").textContent = query
        ? "Try a different name or clear your search to see all tags."
        : "Add tags when saving or editing a bookmark to group related ideas across collections.";
      $("tags-pagination").hidden = pages <= 1;
      $("tags-page-label").textContent = `Page ${tagsPage} of ${pages}`;
      $("tags-previous").disabled = tagsPage <= 1;
      $("tags-next").disabled = tagsPage >= pages;
      if (!jump && showingTags)
        move($("tags-list"), [{ opacity: 0.75 }, { opacity: 1 }]);
      if (jump && sections.has(jump)) {
        const heading = sections.get(jump).previousElementSibling;
        heading.focus({ preventScroll: true });
        heading.scrollIntoView({
          block: "start",
          behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth",
        });
      }
    } catch (error) {
      if (request !== tagsRequest) return;
      $("tags-error").textContent = error.message;
      $("tags-error").hidden = false;
      $("tags-results").textContent =
        "Could not load tags. Use Refresh tags to try again.";
    } finally {
      if (request === tagsRequest)
        $("tags-list").setAttribute("aria-busy", "false");
    }
  }
  lifecycle.listen($("all-tags"), "click", () => {
    lifecycle.cancelTimeout(searchTimer);
    state.query = $("search").value.trim();
    showingTags = true;
    commitRoute();
    $("library-view").hidden = true;
    $("tags-view").hidden = false;
    updateHeading();
    renderCollections();
    loadTagDirectory();
    $("tags-search").focus();
  });
  lifecycle.listen($("tags-back"), "click", () => {
    lifecycle.cancelTimeout(tagsTimer);
    tagsRequest++;
    showingTags = false;
    commitRoute();
    $("tags-view").hidden = true;
    $("library-view").hidden = false;
    updateHeading();
    renderCollections();
    $("page-title").focus();
    move($("bookmark-grid"), [{ opacity: 0.75 }, { opacity: 1 }]);
  });
  lifecycle.listen($("tags-search"), "input", () => {
    lifecycle.cancelTimeout(tagsTimer);
    tagsRequest++; // Invalidate an older query immediately, before the debounce.
    disableTagAlphabet();
    tagsTimer = lifecycle.timeout(() => {
      tagsPage = 1;
      commitRoute(tagsSearchSession);
      tagsSearchSession = true;
      loadTagDirectory();
    }, 250);
  });
  lifecycle.listen($("tags-search"), "blur", () => {
    tagsSearchSession = false;
  });
  lifecycle.listen($("tags-clear-search"), "click", () => {
    lifecycle.cancelTimeout(tagsTimer);
    $("tags-search").value = "";
    tagsPage = 1;
    tagsSearchSession = false;
    commitRoute();
    loadTagDirectory();
    $("tags-search").focus();
  });
  lifecycle.listen($("tags-letter-picker"), "change", () => {
    if ($("tags-letter-picker").value)
      loadTagDirectory($("tags-letter-picker").value);
  });
  lifecycle.listen($("tags-retry"), "click", () => {
    lifecycle.cancelTimeout(tagsTimer);
    loadTagDirectory();
  });
  lifecycle.listen($("tags-previous"), "click", () => {
    tagsPage--;
    commitRoute();
    $("tags-title").focus();
    loadTagDirectory();
  });
  lifecycle.listen($("tags-next"), "click", () => {
    tagsPage++;
    commitRoute();
    $("tags-title").focus();
    loadTagDirectory();
  });

  async function updateLink(link, changes, button) {
    if (button) button.disabled = true;
    try {
      await api(`/api/links/${link.id}`, {
        method: "PUT",
        body: JSON.stringify({ ...editable(link), ...changes }),
      });
      await refresh();
      const field = Object.hasOwn(changes, "favorite") ? "favorite" : "read";
      const message =
        field === "favorite"
          ? changes.favorite
            ? "Added to favorites."
            : "Removed from favorites."
          : changes.read
            ? "Marked as read."
            : "Marked unread.";
      toast(
        message,
        false,
        {
          label: "Undo",
          run: async () => {
            // Restore only the toggled field, preserving any newer notes or tags.
            const latest = await api(`/api/links/${link.id}`);
            if (latest[field] !== changes[field]) {
              toast("This bookmark has changed. Its current state was kept.");
              return;
            }
            await api(`/api/links/${link.id}`, {
              method: "PUT",
              body: JSON.stringify({
                ...editable(latest),
                [field]: link[field],
              }),
            });
            await refresh();
            toast("Change undone.");
          },
        },
        field === "favorite" ? changes.favorite : null,
      );
    } catch (error) {
      toast(error.message, true);
    } finally {
      if (button?.isConnected) button.disabled = false;
    }
  }

  function renderLinks() {
    const grid = $("bookmark-grid");
    const key = focusedKey(grid);
    selection.cancel();
    const previous = bookmarkPositions();
    renderBookmarks(grid, {
      links: state.links,
      revision: state.request,
      view: libraryView,
      query: state.query,
      expandedActions: expandedBookmarkActions,
      expandedTags: expandedBookmarkTags,
      onOpen: (link) => reader.open(link.id),
      onEdit: openEditor,
      onUpdate: updateLink,
      onTag: (name) => selectFilter("all", null, name),
      onMoreTags: (link) => {
        expandedBookmarkTags.add(link.id);
        renderLinks();
        grid
          .querySelector(`[data-id="${link.id}"] .card-tag:nth-child(6)`)
          ?.focus();
      },
      onActions: (link) => {
        expandedBookmarkActions =
          expandedBookmarkActions === link.id ? null : link.id;
        renderLinks();
      },
      onDelete: (link) => {
        deleteBookmark = link;
        $("delete-bookmark-name").textContent = `“${link.title || link.url}”`;
        $("delete-bookmark-error").textContent = "";
        $("delete-bookmark-dialog").showModal();
        $("delete-bookmark-cancel").focus();
      },
    });
    bulk.render(libraryUnavailable || libraryLoading ? [] : state.links);
    grid.hidden = libraryUnavailable || libraryLoading;
    $("empty-state").hidden =
      libraryUnavailable || libraryLoading || state.links.length > 0;
    const filtered = !!state.query || state.filter !== "all" || !!state.tag;
    $("empty-title").textContent = filtered
      ? "No bookmarks found"
      : "Your library starts here";
    $("empty-message").textContent = filtered
      ? "Try a different search or clear your filters to see all bookmarks."
      : "Save your first bookmark, or bring your existing bookmarks with you.";
    const emptyView =
      !state.query &&
      (state.tag
        ? [
            "No bookmarks with this tag",
            "Choose another tag or return to all bookmarks.",
            false,
            "tag",
          ]
        : {
            collection: [
              "This collection is empty",
              "Add a bookmark to start this collection.",
              true,
              "folder",
            ],
            inbox: [
              "Your inbox is empty",
              "Save a bookmark without a collection to keep it here until you’re ready to organize it.",
              true,
              "inbox",
            ],
            favorite: [
              "No favorites yet",
              "Select the star on any bookmark to keep your go-to pages close at hand.",
              false,
              "star",
            ],
            unread: [
              "Nothing left to read",
              "You’re all caught up. Mark a bookmark as unread to save it for later.",
              false,
              "clock",
            ],
          }[state.filter]);
    $("empty-art").replaceChildren(
      icon(state.query ? "search" : emptyView?.[3] || "bookmark"),
    );
    if (emptyView) {
      $("empty-title").textContent = emptyView[0];
      $("empty-message").textContent = emptyView[1];
    }
    $("empty-import").hidden = filtered;
    $("empty-reset").hidden = !filtered;
    $("empty-reset").textContent = emptyView
      ? "View all bookmarks"
      : "Clear filters";
    $("empty-add").hidden = !!emptyView && !emptyView[2];
    $("empty-add").textContent = filtered
      ? "Add a bookmark"
      : "Add your first bookmark";
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
    $("results-label").textContent = libraryLoading
      ? "Loading your library…"
      : libraryUnavailable
        ? "Could not load this view"
        : `${state.total} bookmark${state.total === 1 ? "" : "s"}${state.query ? ` matching “${state.query}”` : " in this view"}`;
    syncBookmarkSelection();
    transitionBookmarks(previous);
    restoreFocus(grid, key);
  }

  function setRefreshBusy(busy) {
    const button = $("refresh-button");
    button.setAttribute("aria-disabled", String(busy));
    button.setAttribute("aria-busy", String(busy));
    button.title = busy ? "Refreshing library…" : "Refresh library";
    button.setAttribute("aria-label", button.title);
    button
      .querySelector("[data-icon]")
      .replaceChildren(icon(busy ? "spinner" : "refresh"));
  }

  async function refresh(quiet = false) {
    if (!state.signedIn || state.settingsSection) return;
    lifecycle.cancelTimeout(state.timer);
    const request = ++state.request;
    refreshRequest = request;
    setRefreshBusy(true);
    const params = new URLSearchParams({
      page: String(state.page),
      sort: state.sort,
    });
    if (state.query) params.set("fuzzy", "1");
    if (state.query) params.set("q", state.query);
    if (state.tag) params.set("tag", state.tag);
    if (state.filter === "favorite") params.set("favorite", "1");
    if (state.filter === "unread") params.set("unread", "1");
    if (state.filter === "inbox") params.set("collection", "0");
    if (state.filter === "collection")
      params.set("collection", state.collection);
    libraryLoading = renderedLibraryRoute !== params.toString();
    if (libraryLoading) {
      if (
        $("bookmark-grid").contains(document.activeElement) ||
        $("pagination").contains(document.activeElement)
      )
        $("page-title").focus();
      $("bookmark-grid").hidden = true;
      $("empty-state").hidden = true;
      $("pagination").hidden = true;
      bulk.render([]);
    }
    $("bookmark-grid").setAttribute("aria-busy", "true");
    if (!quiet || libraryLoading)
      $("results-label").textContent = "Loading your library…";
    $("library-error").hidden = true;
    try {
      const [result, collections, tags, stats] = await Promise.all([
        api(`/api/links?${params}`),
        api("/api/collections"),
        api("/api/tags"),
        api("/api/stats"),
      ]);
      if (request !== state.request) return;
      libraryUnavailable = false;
      libraryLoading = false;
      state.links = result.links || [];
      const visibleIds = new Set(state.links.map((link) => link.id));
      for (const id of expandedBookmarkTags)
        if (!visibleIds.has(id)) expandedBookmarkTags.delete(id);
      state.total = result.total || 0;
      state.pageSize = result.pageSize || 40;
      const lastPage = Math.max(1, Math.ceil(state.total / state.pageSize));
      if (state.page > lastPage) {
        state.page = lastPage;
        commitRoute(true);
        return refresh(quiet);
      }
      state.collections = collections || [];
      $("total-count").textContent = stats.links;
      updateHeading();
      renderCollections();
      renderTags(tags || []);
      renderLinks();
      const destination = params.toString();
      if (
        !quiet &&
        !showingTags &&
        renderedLibraryRoute !== null &&
        destination !== renderedLibraryRoute
      )
        move($("bookmark-grid"), [{ opacity: 0.75 }, { opacity: 1 }]);
      renderedLibraryRoute = destination;
      if (stats.pending && !document.hidden)
        state.timer = lifecycle.timeout(() => refresh(true), 5000);
    } catch (error) {
      if (request !== state.request) return;
      libraryLoading = false;
      libraryUnavailable = renderedLibraryRoute !== params.toString();
      renderLinks();
      const message = el(
        "span",
        "",
        `${error.message}${libraryUnavailable ? "" : " Showing the last loaded results."} `,
      );
      const retry = el("button", "text-button", "Try again");
      retry.type = "button";
      lifecycle.listen(retry, "click", () => {
        $("page-title").focus();
        refresh();
      });
      $("library-error").replaceChildren(message, retry);
      $("library-error").hidden = false;
      $("results-label").textContent = "Could not refresh library";
    } finally {
      if (request === refreshRequest) setRefreshBusy(false);
      if (request === state.request)
        $("bookmark-grid").setAttribute("aria-busy", "false");
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
    $("bookmark-dialog-title").textContent = link
      ? "Edit bookmark"
      : "Add bookmark";
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
    fillCollections(
      $("bookmark-collection"),
      link
        ? link.collectionId
        : state.filter === "collection"
          ? state.collection
          : null,
    );
    editorBaseline = editorValues();
    const draft = drafts.get(draftKey(link));
    if (draft) fillEditor(draft);
    else $("bookmark-details").open = !!(link?.description || link?.notes);
    $("bookmark-draft").hidden = !draft;
    validateBookmarkFields();
    $("bookmark-dialog").showModal();
    $("bookmark-url").focus();
  }

  function editorValues() {
    return {
      url: $("bookmark-url").value,
      title: $("bookmark-title").value,
      description: $("bookmark-description").value,
      notes: $("bookmark-notes").value,
      collectionId: $("bookmark-collection").value
        ? Number($("bookmark-collection").value)
        : null,
      tags: [
        ...new Set(
          $("bookmark-tags")
            .value.split(",")
            .map((tag) => tag.trim())
            .filter(Boolean),
        ),
      ],
      favorite: $("bookmark-favorite").checked,
      read: $("bookmark-read").checked,
      saveHTML:
        !$("bookmark-save-html").disabled && $("bookmark-save-html").checked,
    };
  }
  function validateBookmarkFields() {
    const issues = workspace.bookmarkIssues({
      ...editorValues(),
      type: state.editing?.type,
    });
    if (issues.description || issues.notes) $("bookmark-details").open = true;
    for (const field of ["url", "title", "description", "notes", "tags"]) {
      $(
        "bookmark-" + field + (field === "tags" ? "-query" : ""),
      ).setCustomValidity(issues[field] || "");
    }
    return issues;
  }
  function fillEditor(value) {
    $("bookmark-details").open = !!(value.description || value.notes);
    $("bookmark-save-html").checked = !!value.saveHTML;
    for (const field of ["url", "title", "description", "notes"])
      $("bookmark-" + field).value = value[field] || "";
    tagPickers.get("bookmark-tags").set(value.tags || []);
    fillCollections($("bookmark-collection"), value.collectionId);
    $("bookmark-favorite").checked = !!value.favorite;
    $("bookmark-read").checked = !!value.read;
    validateBookmarkFields();
  }
  lifecycle.listen($("bookmark-form"), "input", () => {
    if (!editorBaseline) return;
    validateBookmarkFields();
    drafts.put(draftKey(state.editing), editorValues(), editorBaseline);
    $("bookmark-draft").hidden = !drafts.get(draftKey(state.editing));
  });
  lifecycle.listen($("bookmark-dialog"), "close", () => {
    if (drafts.get(draftKey(state.editing)))
      toast("Bookmark draft kept in this tab.");
  });
  lifecycle.listen($("bookmark-form"), "change", () =>
    $("bookmark-form").dispatchEvent(new Event("input")),
  );
  lifecycle.listen($("discard-bookmark-draft"), "click", async () => {
    const session = editorSession,
      key = draftKey(state.editing);
    if (
      !(await confirmAction(
        "Discard draft?",
        "Discard this unsaved draft?",
        "Discard draft",
      )) ||
      session !== editorSession ||
      !$("bookmark-dialog").open
    )
      return;
    drafts.delete(key);
    fillEditor(editorBaseline);
    $("bookmark-draft").hidden = true;
  });

  function attachTagPicker(id) {
    tagPickers.set(id, PocketmarkTagPicker.create({ id, api, icon, move }));
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
    $("login-title").textContent = enrollment
      ? "Set up your authenticator"
      : "Verify it’s you";
    $("login-description").textContent = enrollment
      ? "Add Pocketmark to your authenticator app, then enter its code."
      : "Enter a code from your authenticator app, or use a recovery code.";
    $("mfa-code-label").textContent = enrollment
      ? "Code from your authenticator"
      : "Authentication or recovery code";
    $("mfa-code").inputMode = enrollment ? "numeric" : "text";
    $("mfa-code").value = "";
    $("mfa-code").focus();
  }
  async function beginMFAEnrollment() {
    const enrollment = await api("/api/mfa/enroll", {
      method: "POST",
      body: "{}",
    });
    $("mfa-secret").value = enrollment.secret;
    $("mfa-qr").src = enrollment.qr;
    showMFACode(true);
  }

  lifecycle.listen($("login-form"), "submit", async (event) => {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    $("login-error").textContent = "";
    try {
      if (
        setupRequired &&
        $("login-password").value !== $("login-confirm").value
      )
        throw new Error("The passwords do not match.");
      const result = await api(setupRequired ? "/api/setup" : "/api/login", {
        method: "POST",
        body: JSON.stringify({
          username: $("login-username").value.trim(),
          password: $("login-password").value,
        }),
      });
      setupRequired = false;
      $("login-confirm").value = "";
      $("login-password").value = "";
      $("login-form").hidden = true;
      if (result.enrollmentRequired) {
        $("mfa-back").hidden = false;
        await beginMFAEnrollment();
      } else showMFACode(false);
    } catch (error) {
      $("login-error").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  lifecycle.listen($("mfa-code-form"), "submit", async (event) => {
    event.preventDefault();
    event.submitter.disabled = true;
    $("login-error").textContent = "";
    try {
      const result = await api("/api/mfa/verify", {
        method: "POST",
        body: JSON.stringify({ code: $("mfa-code").value.trim() }),
      });
      $("mfa-code").value = $("mfa-secret").value = "";
      $("mfa-qr").removeAttribute("src");
      if (result.recoveryCodes) {
        $("mfa-code-form").hidden =
          $("mfa-enrollment").hidden =
          $("mfa-back").hidden =
            true;
        $("mfa-login-codes-value").textContent =
          result.recoveryCodes.join("\n");
        $("mfa-login-codes").hidden = false;
        $("login-title").textContent = "Your backup access";
        $("login-description").textContent =
          "Keep these codes separate from your authenticator.";
        $("mfa-login-codes-value").focus();
      } else {
        await enterLibrary();
        if (result.usedRecoveryCode)
          toast(
            "Recovery code used. You can replace your authenticator in Settings.",
          );
      }
    } catch (error) {
      $("login-error").textContent = error.message;
    } finally {
      event.submitter.disabled = false;
    }
  });
  function downloadRecoveryCodes(element) {
    const url = URL.createObjectURL(
      new Blob([element.textContent + "\n"], {
        type: "text/plain;charset=utf-8",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "pocketmark-recovery-codes.txt";
    link.click();
    lifecycle.timeout(() => URL.revokeObjectURL(url), 1000);
  }
  lifecycle.listen($("mfa-login-download"), "click", () =>
    downloadRecoveryCodes($("mfa-login-codes-value")),
  );
  lifecycle.listen($("mfa-secret-copy"), "click", async () => {
    $("login-error").textContent = "";
    try {
      await navigator.clipboard.writeText($("mfa-secret").value);
      toast("Setup key copied.");
    } catch {
      $("mfa-secret").select();
      $("login-error").textContent =
        "Select and copy the setup key shown above.";
    }
  });
  lifecycle.listen($("mfa-login-copy"), "click", async () => {
    try {
      await navigator.clipboard.writeText(
        $("mfa-login-codes-value").textContent,
      );
      toast("Recovery codes copied.");
    } catch {
      $("login-error").textContent =
        "Select and copy the recovery codes shown above.";
    }
  });
  lifecycle.listen($("mfa-login-continue"), "click", async () => {
    $("mfa-login-continue").disabled = true;
    try {
      await enterLibrary();
    } catch (error) {
      $("login-error").textContent = error.message;
    } finally {
      $("mfa-login-continue").disabled = false;
    }
  });
  lifecycle.listen($("mfa-back"), "click", () => {
    resetMFALogin();
    configureLogin();
    $("login-error").textContent = "";
    $("login-username").focus();
  });

  function confirmAction(title, description, action) {
    const dialog = $("confirm-action-dialog");
    if (dialog.open) return Promise.resolve(false);
    $("confirm-action-title").textContent = title;
    $("confirm-action-description").textContent = description;
    $("confirm-action-submit").textContent = action;
    dialog.returnValue = "";
    return new Promise((resolve) => {
      lifecycle.listen(
        dialog,
        "close",
        () => resolve(dialog.returnValue === "confirm"),
        { once: true },
      );
      dialog.showModal();
      $("confirm-action-cancel").focus();
    });
  }

  const deleteBookmarkDialog = $("delete-bookmark-dialog");
  let deleteBookmark = null;
  let deletingBookmark = false;
  lifecycle.listen(deleteBookmarkDialog, "cancel", (event) => {
    if (deletingBookmark) event.preventDefault();
  });
  lifecycle.listen(deleteBookmarkDialog, "close", () => {
    deleteBookmark = null;
  });
  lifecycle.listen($("delete-bookmark-form"), "submit", async (event) => {
    event.preventDefault();
    if (deletingBookmark || !deleteBookmark) return;
    const link = deleteBookmark;
    deletingBookmark = true;
    $("delete-bookmark-confirm").disabled = $(
      "delete-bookmark-cancel",
    ).disabled = true;
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
      if (deleteBookmarkDialog.open)
        $("delete-bookmark-error").textContent = error.message;
      else toast(error.message, true);
    } finally {
      deletingBookmark = false;
      $("delete-bookmark-confirm").disabled = $(
        "delete-bookmark-cancel",
      ).disabled = false;
      $("delete-bookmark-confirm").textContent = "Delete bookmark";
    }
  });

  const logoutDialog = $("logout-dialog");
  let signingOut = false;
  lifecycle.listen($("logout-button"), "click", () => {
    $("logout-description").textContent = drafts.size
      ? "Signing out will discard the unsaved drafts kept in this tab. You’ll need to sign in again to access your library."
      : "You’ll need to sign in again to access your library.";
    $("logout-error").textContent = "";
    logoutDialog.showModal();
    $("logout-cancel").focus();
  });
  lifecycle.listen(logoutDialog, "cancel", (event) => {
    if (signingOut) event.preventDefault();
  });
  lifecycle.listen(logoutDialog, "close", () => {
    if (state.signedIn) $("open-navigation").focus({ preventScroll: true });
  });
  lifecycle.listen($("logout-form"), "submit", async (event) => {
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
    } catch (error) {
      $("logout-error").textContent = error.message;
    } finally {
      signingOut = false;
      $("logout-confirm").disabled = $("logout-cancel").disabled = false;
      $("logout-confirm").textContent = "Sign out";
    }
  });

  document
    .querySelectorAll("[data-filter]")
    .forEach((button) =>
      lifecycle.listen(button, "click", () =>
        selectFilter(button.dataset.filter),
      ),
    );
  document.querySelectorAll("[data-quick-filter]").forEach((button) =>
    lifecycle.listen(button, "click", () => {
      if (!state.tag && state.filter === button.dataset.quickFilter) return;
      selectFilter(button.dataset.quickFilter, null, "", false);
    }),
  );
  // Treat an outside click like Escape so each dialog keeps its cancellation guards.
  document.querySelectorAll("dialog").forEach((dialog) => {
    let backdropPress = false;
    function outside(event) {
      const rect = dialog.getBoundingClientRect();
      return (
        event.target === dialog &&
        (event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom)
      );
    }
    lifecycle.listen(dialog, "pointerdown", (event) => {
      backdropPress = event.button === 0 && outside(event);
    });
    lifecycle.listen(dialog, "pointercancel", () => {
      backdropPress = false;
    });
    lifecycle.listen(dialog, "close", () => {
      backdropPress = false;
    });
    lifecycle.listen(dialog, "click", (event) => {
      const dismiss = backdropPress && outside(event);
      backdropPress = false;
      if (!dismiss || !dialog.open) return;
      if (typeof dialog.requestClose === "function") dialog.requestClose();
      else if (dialog.dispatchEvent(new Event("cancel", { cancelable: true })))
        dialog.close();
    });
  });
  document
    .querySelectorAll(".close-dialog")
    .forEach((button) =>
      lifecycle.listen(button, "click", () => button.closest("dialog").close()),
    );
  lifecycle.listen($("add-bookmark"), "click", () => openEditor());
  lifecycle.listen($("empty-add"), "click", () => openEditor());
  lifecycle.listen($("empty-import"), "click", openImport);
  function resetLibraryFilters() {
    lifecycle.cancelTimeout(searchTimer);
    state.query = "";
    $("search").value = "";
    selectFilter("all");
    $("search").focus();
  }
  lifecycle.listen($("empty-reset"), "click", resetLibraryFilters);
  lifecycle.listen($("tags-browse-bookmarks"), "click", resetLibraryFilters);
  lifecycle.listen($("refresh-button"), "click", (event) => {
    if (event.currentTarget.getAttribute("aria-busy") !== "true") refresh();
  });
  lifecycle.listen($("search"), "input", () => {
    lifecycle.cancelTimeout(searchTimer);
    state.request++;
    searchTimer = lifecycle.timeout(() => {
      state.query = $("search").value.trim();
      state.page = 1;
      commitRoute(searchSession);
      searchSession = true;
      refresh();
    }, 250);
  });
  lifecycle.listen($("search"), "blur", () => {
    searchSession = false;
  });
  lifecycle.listen($("previous-page"), "click", () => {
    state.page--;
    commitRoute();
    refresh();
  });
  lifecycle.listen($("next-page"), "click", () => {
    state.page++;
    commitRoute();
    refresh();
  });

  lifecycle.listen($("bookmark-form"), "submit", async (event) => {
    event.preventDefault();
    if (Object.keys(validateBookmarkFields()).length) {
      $("bookmark-form").reportValidity();
      return;
    }
    const button = event.submitter;
    const session = editorSession,
      editing = state.editing,
      key = draftKey(editing),
      submitted = editorValues();
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = submitted.saveHTML
      ? "Saving bookmark & HTML…"
      : "Saving bookmark…";
    $("bookmark-save-status").hidden = !submitted.saveHTML;
    $("bookmark-save-status").textContent =
      "Saving the bookmark and its HTML copy. This can take up to 45 seconds.";
    $("bookmark-error").textContent = "";
    const body = {
      url: $("bookmark-url").value.trim(),
      title: $("bookmark-title").value.trim(),
      description: $("bookmark-description").value.trim(),
      notes: $("bookmark-notes").value,
      collectionId: $("bookmark-collection").value
        ? Number($("bookmark-collection").value)
        : null,
      tags: [
        ...new Set(
          $("bookmark-tags")
            .value.split(",")
            .map((tag) => tag.trim())
            .filter(Boolean),
        ),
      ],
      favorite: $("bookmark-favorite").checked,
      read: $("bookmark-read").checked,
    };
    try {
      if (state.editing?.type !== "file" && !safeURL(body.url))
        throw new Error("Please enter a complete http:// or https:// URL.");
      const result = await workspace.saveBookmark(
        api,
        editing,
        body,
        submitted.saveHTML,
      );
      const baseline = { ...body, saveHTML: submitted.saveHTML };
      const active = session === editorSession && $("bookmark-dialog").open;
      const latest = active ? editorValues() : drafts.get(key);
      const newer =
        latest && JSON.stringify(latest) !== JSON.stringify(submitted);
      if (newer && active && !editing) {
        drafts.delete(key);
        state.editing = result.link;
        $("bookmark-dialog-title").textContent = "Edit bookmark";
        drafts.put(draftKey(result.link), latest, baseline);
      } else if (newer) drafts.put(key, latest, baseline);
      else drafts.delete(key);
      if (active) {
        editorBaseline = baseline;
        $("bookmark-draft").hidden = !newer;
        if (!newer) $("bookmark-dialog").close();
      }
      if (result.captureError)
        htmlCaptureFailed(result.link.id, result.captureError);
      else
        toast(
          newer
            ? "Saved. Your newer edits remain a draft."
            : result.capture
              ? `Bookmark and HTML copy saved.${result.capture.omitted ? ` ${result.capture.omitted} resource${result.capture.omitted === 1 ? "" : "s"} could not be included.` : ""}`
              : editing
                ? "Bookmark updated."
                : "Bookmark saved.",
        );
      await refresh();
    } catch (error) {
      if (session === editorSession)
        $("bookmark-error").textContent = error.message;
      else toast(error.message, true);
    } finally {
      if (session === editorSession) {
        button.disabled = false;
        button.textContent = "Save";
        $("bookmark-save-status").hidden = true;
      }
    }
  });

  function htmlCaptureFailed(id, error) {
    toast(
      `Bookmark saved. The HTML copy could not be saved. ${error.message}`,
      true,
      {
        label: "Retry HTML",
        run: async () => {
          try {
            const result = await api(`/api/links/${id}/preserve`, {
              method: "POST",
            });
            toast(
              `HTML copy saved.${result.omitted ? ` ${result.omitted} resource${result.omitted === 1 ? "" : "s"} could not be included.` : ""}`,
            );
          } catch (failure) {
            htmlCaptureFailed(id, failure);
          }
        },
      },
    );
  }

  lifecycle.listen($("add-collection"), "click", () => {
    openCollectionEditor();
  });
  let collectionEditorSession = 0;
  const collectionNameLimit = PocketmarkNameLimit.create(
    $("collection-name"),
    $("collection-name-hint"),
  );
  lifecycle.listen($("collection-form"), "submit", async (event) => {
    event.preventDefault();
    const button = event.submitter,
      session = collectionEditorSession,
      editing = state.editingCollection;
    button.disabled = true;
    $("collection-error").textContent = "";
    try {
      const name = $("collection-name").value.trim();
      if (!name) throw new Error("Give your collection a name.");
      if (new TextEncoder().encode(name).length > 120)
        throw new Error(
          "This name is too long. Shorten it, especially if it contains accents or emoji.",
        );
      const parentId = $("collection-parent").value
        ? Number($("collection-parent").value)
        : null;
      const saved = await api(
        editing ? `/api/collections/${editing.id}` : "/api/collections",
        {
          method: editing ? "PUT" : "POST",
          body: JSON.stringify({ name, parentId }),
        },
      );
      const active =
        session === collectionEditorSession && $("collection-dialog").open;
      const newer =
        active &&
        ($("collection-name").value.trim() !== name ||
          ($("collection-parent").value
            ? Number($("collection-parent").value)
            : null) !== parentId);
      if (newer) {
        state.editingCollection = editing || saved;
        $("collection-dialog-title").textContent = "Rename or move collection";
      } else if (active) $("collection-dialog").close();
      await refresh();
      toast(
        newer
          ? "Saved. Your newer collection edits are still open."
          : editing
            ? "Collection updated."
            : "Collection created.",
      );
    } catch (error) {
      if (session === collectionEditorSession && $("collection-dialog").open)
        $("collection-error").textContent = error.message;
      else toast(error.message, true);
    } finally {
      if (session === collectionEditorSession) button.disabled = false;
    }
  });

  function openImport() {
    $("import-dialog").showModal();
  }
  lifecycle.listen($("import-button"), "click", openImport);
  lifecycle.listen($("import-choose"), "click", () => $("import-file").click());
  lifecycle.listen($("import-file"), "change", async () => {
    const file = $("import-file").files[0];
    if (!file) return;
    $("import-dialog").close();
    $("import-result").hidden = true;
    $("import-choose").disabled = true;
    $("import-button").disabled = true;
    $("empty-import").disabled = true;
    $("import-progress").hidden = false;
    try {
      if (file.size > 8 * 1024 * 1024)
        throw new Error("Choose an export smaller than 8 MiB.");
      const body = await file.text();
      const html = /\.html?$/i.test(file.name) || file.type === "text/html";
      if (!html) {
        try {
          JSON.parse(body);
        } catch {
          throw new Error(
            "Choose a JSON export or a browser bookmarks HTML file.",
          );
        }
      }
      const result = await api(html ? "/api/import/html" : "/api/import", {
        method: "POST",
        headers: { "Content-Type": html ? "text/html" : "application/json" },
        body,
      });
      const message = `Imported ${result.imported} bookmarks. ${result.skipped || 0} skipped.`;
      $("import-result").textContent = message;
      $("import-result").className = "operation-result";
      $("import-result").hidden = false;
      toast(message);
      await refresh();
    } catch (error) {
      $("import-result").textContent =
        `Import could not finish. ${error.message}`;
      $("import-result").className = "error-banner";
      $("import-result").hidden = false;
      toast(error.message, true);
    } finally {
      $("import-choose").disabled = false;
      $("import-progress").hidden = true;
      $("import-button").disabled = false;
      $("empty-import").disabled = false;
      $("import-file").value = "";
    }
  });

  let shortcutsEnabled = true;
  try {
    shortcutsEnabled = localStorage.getItem("pocketmark-shortcuts") !== "off";
  } catch {
    /* Optional preference storage. */
  }
  function syncShortcuts() {
    $("keyboard-shortcuts").checked = shortcutsEnabled;
    document.querySelectorAll("[data-shortcut-hint]").forEach((node) => {
      node.hidden = !shortcutsEnabled;
    });
  }
  syncShortcuts();
  lifecycle.listen($("keyboard-shortcuts"), "change", () => {
    shortcutsEnabled = $("keyboard-shortcuts").checked;
    try {
      localStorage.setItem(
        "pocketmark-shortcuts",
        shortcutsEnabled ? "on" : "off",
      );
    } catch {
      /* Keep this session's choice. */
    }
    syncShortcuts();
  });
  lifecycle.listen(document, "keydown", (event) => {
    if (
      !shortcutsEnabled ||
      state.settingsSection ||
      event.repeat ||
      event.isComposing ||
      !state.signedIn ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      document.querySelector("dialog[open]") ||
      document.activeElement.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)
    )
      return;
    if (event.key === "/") {
      event.preventDefault();
      $(showingTags ? "tags-search" : "search").focus();
    }
    if (event.key.toLowerCase() === "n") {
      event.preventDefault();
      openEditor();
    }
  });
  lifecycle.listen(document, "visibilitychange", () => {
    if (document.hidden) lifecycle.cancelTimeout(state.timer);
    else if (state.signedIn) refresh(true);
  });

  function openCollectionEditor(collection = null) {
    collectionEditorSession++;
    state.editingCollection = collection;
    $("collection-form").reset();
    $("collection-form").querySelector('[type="submit"]').disabled = false;
    $("collection-error").textContent = "";
    $("collection-dialog-title").textContent = collection
      ? "Rename or move collection"
      : "New collection";
    $("collection-name").value = collection?.name || "";
    collectionNameLimit.update();
    fillCollections(
      $("collection-parent"),
      collection?.parentId,
      "None — top level",
    );
    if (collection) {
      const excluded = new Set([collection.id]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const item of state.collections)
          if (excluded.has(item.parentId) && !excluded.has(item.id)) {
            excluded.add(item.id);
            changed = true;
          }
      }
      for (const option of [...$("collection-parent").options])
        if (excluded.has(Number(option.value))) option.remove();
    }
    $("collection-dialog").showModal();
    $("collection-name").focus();
  }

  const sortOptions = [...$("sort-menu").querySelectorAll("[data-sort]")];
  function syncSortMenu() {
    for (const option of sortOptions)
      option.setAttribute(
        "aria-checked",
        String(option.dataset.sort === state.sort),
      );
    const name = sortOptions
      .find((option) => option.dataset.sort === state.sort)
      .textContent.trim();
    $("sort-label").textContent = name;
    const label = `Sort bookmarks: ${name}`;
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
  lifecycle.listen($("sort-toggle"), "click", () => {
    if ($("sort-menu").hidden) openSortMenu();
    else closeSortMenu();
  });
  lifecycle.listen($("sort-toggle"), "keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      openSortMenu();
    }
  });
  lifecycle.listen($("sort-menu"), "click", (event) => {
    const option = event.target.closest("[data-sort]");
    if (!option) return;
    closeSortMenu(true);
    if (state.sort === option.dataset.sort) return;
    state.sort = option.dataset.sort;
    state.page = 1;
    syncSortMenu();
    commitRoute();
    refresh();
  });
  lifecycle.listen($("sort-menu"), "keydown", (event) => {
    const index = sortOptions.indexOf(document.activeElement);
    let next;
    if (event.key === "ArrowDown") next = (index + 1) % sortOptions.length;
    if (event.key === "ArrowUp")
      next = (index - 1 + sortOptions.length) % sortOptions.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = sortOptions.length - 1;
    if (next !== undefined) {
      event.preventDefault();
      sortOptions[next].focus();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeSortMenu(true);
    }
    if (event.key === "Tab") {
      closeSortMenu(true);
      if (event.shiftKey) event.preventDefault();
    }
  });
  lifecycle.listen(document, "pointerdown", (event) => {
    if (
      !$("sort-menu").hidden &&
      !$("sort-menu").contains(event.target) &&
      !$("sort-toggle").contains(event.target)
    )
      closeSortMenu();
  });
  lifecycle.listen(document, "focusin", (event) => {
    if (
      !$("sort-menu").hidden &&
      !$("sort-menu").contains(event.target) &&
      event.target !== $("sort-toggle")
    )
      closeSortMenu();
  });
  lifecycle.listen($("upload-file-button"), "click", () =>
    $("library-file").click(),
  );
  lifecycle.listen($("library-file"), "change", async () => {
    const file = $("library-file").files[0];
    if (!file) return;
    $("upload-file-button").disabled = true;
    $("upload-progress").hidden = false;
    try {
      if (file.size > 20 * 1024 * 1024)
        throw new Error("Choose a file smaller than 20 MiB.");
      const params = new URLSearchParams({ name: file.name });
      if (state.filter === "collection")
        params.set("collection", state.collection);
      const result = await api(`/api/files?${params}`, {
        method: "POST",
        headers: {
          "Content-Type":
            file.type ||
            (/\.html?$/i.test(file.name)
              ? "text/html"
              : "application/octet-stream"),
        },
        body: file,
      });
      await refresh();
      toast("File saved to your library.");
      await reader.open(result.link.id);
    } catch (error) {
      toast(error.message, true);
    } finally {
      $("upload-progress").hidden = true;
      $("library-file").value = "";
      $("upload-file-button").disabled = false;
    }
  });
  function updateHelp() {
    const query = $("help-search").value.trim().toLocaleLowerCase();
    let matches = 0;
    document.querySelectorAll("#help-topics > details").forEach((topic) => {
      const match =
        !query || topic.textContent.toLocaleLowerCase().includes(query);
      topic.hidden = !match;
      topic.open = !!query && match;
      if (match) matches++;
    });
    $("help-results").textContent = query
      ? `${matches} topic${matches === 1 ? "" : "s"} found`
      : "";
    $("help-empty").hidden = matches > 0;
  }
  lifecycle.listen($("help-search"), "input", updateHelp);
  lifecycle.listen($("help-clear"), "click", () => {
    $("help-search").value = "";
    updateHelp();
    $("help-search").focus();
  });
  lifecycle.listen($("help-button"), "click", () => {
    $("help-search").value = "";
    updateHelp();
    $("help-dialog").showModal();
    document.querySelector("#help-dialog .help-body").scrollTop = 0;
  });

  function configureLogin(passwordEnabled = true) {
    $("login-title").textContent = setupRequired
      ? "Create your account"
      : "Welcome back";
    $("login-description").textContent = setupRequired
      ? "After creating your account, you’ll set up an authenticator app and save recovery codes."
      : "Sign in with your password and an authentication or recovery code.";
    $("login-submit-label").textContent = setupRequired
      ? "Create account"
      : "Sign in";
    $("login-confirm-fields").hidden = !setupRequired;
    $("login-password-hint").hidden = !setupRequired;
    $("login-password").setAttribute(
      "aria-describedby",
      setupRequired ? "login-password-hint" : "login-help",
    );
    $("login-confirm").required = setupRequired;
    $("login-password").autocomplete = setupRequired
      ? "new-password"
      : "current-password";
    $("login-password").minLength = setupRequired ? 12 : 1;
    $("login-help").textContent = setupRequired
      ? "This instance has one personal account."
      : passwordEnabled
        ? "Use your Pocketmark username and password."
        : "Your existing library needs a password. Ask the server administrator to configure it using the account recovery instructions.";
    $("login-submit").disabled = !setupRequired && !passwordEnabled;
  }
  const settings = createSettings({
    state,
    api,
    toast,
    el,
    icon,
    confirmAction,
    renderBreadcrumb,
    move,
    activeMotion,
    route,
    commitRoute,
    restoreRoute,
    showLogin,
    security,
    downloadRecoveryCodes,
  });
  function renderSettings(...args) {
    return settings.renderSettings(...args);
  }
  function clearSettings(...args) {
    return settings.clearSettings(...args);
  }
  function focusSettings(...args) {
    return settings.focusSettings(...args);
  }
  function loadSettings(...args) {
    return settings.loadSettings(...args);
  }
  function navigateSettings(...args) {
    return settings.navigateSettings(...args);
  }
  function leaveSettings(...args) {
    return settings.leaveSettings(...args);
  }
  function setMFAManagementBusy(...args) {
    return settings.setMFAManagementBusy(...args);
  }
  function syncSettingsNavigation(...args) {
    return settings.syncSettingsNavigation(...args);
  }
  function clearMFAManagement(...args) {
    return settings.clearMFAManagement(...args);
  }

  function openSharedLink() {
    const params = sharedParams;
    if (!params.has("share-url") && !params.has("share-text")) return;
    const text = params.get("share-text") || "";
    const candidate =
      params.get("share-url") || text.match(/https?:\/\/[^\s]+/)?.[0];
    const url = safeURL(candidate);
    if (!url) {
      toast("The shared content did not contain a web link.", true);
      return;
    }
    const title = params.get("share-title") || "";
    history.replaceState(
      { pocketmarkScroll: 0 },
      "",
      location.pathname + workspace.routeSearch(route()),
    );
    params.delete("share-url");
    params.delete("share-text");
    params.delete("share-title");
    openEditor();
    $("bookmark-url").value = url;
    $("bookmark-title").value = title;
    $("bookmark-form").dispatchEvent(new Event("input"));
  }
  if (import.meta.env.PROD && "serviceWorker" in navigator)
    navigator.serviceWorker.register("/sw.js").catch(() => {});

  async function init() {
    try {
      const setup = await api("/api/setup");
      setupRequired = setup.setupRequired;
      configureLogin(setup.passwordEnabled);
      if (setupRequired || !setup.passwordEnabled) {
        showLogin();
        return;
      }
      const session = await api("/api/session");
      if (!session?.authenticated) {
        showLogin();
        return;
      }
      state.signedIn = true;
      $("app-view").hidden = false;
      await restoreRoute(true);
      openSharedLink();
    } catch (error) {
      showLogin();
      $("login-error").textContent = error.status === 401 ? "" : error.message;
    }
  }
  init();
  return () => {
    state.signedIn = false;
    state.request++;
    routeRequest++;
    tagsRequest++;
    state.settingsSession++;
    editorSession++;
    settings.dispose();
    lifecycle.dispose();
    selection.dispose();
    bulk.dispose();
    reader.dispose();
    security.dispose();
    themeSwitch.dispose?.();
    collectionNameLimit.dispose?.();
    for (const picker of tagPickers.values()) picker.dispose();
    document
      .querySelectorAll("select")
      .forEach((select) => PocketmarkSelect.destroy(select));
    activeMotion.forEach((animation) => animation.cancel());
    sidebarRail.remove();
    disposeRegions();
  };
}
