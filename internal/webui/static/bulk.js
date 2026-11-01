"use strict";

((root) => {
  function create({ api, toast, onChange, onSelectionChange, fillCollections, defaultCollection, icon, onSessionExpired }, browser = root) {
    const document = browser.document, $ = id => document.getElementById(id);
    // Identity distinguishes a reselected bookmark from an in-flight operation.
    const selected = new Map();
    let visible = [], session = null;
    const dialog = $("bulk-dialog"), bar = $("bulk-bar");
    const phone = browser.matchMedia("(max-width: 600px)");
    const actionNames = { move: "Move", tags: "Replace tags on", favorite: "Favorites", read: "Reading status", capture: "Refresh captures for", delete: "Delete" };
    const triggers = { move: "bulk-move", tags: "bulk-tag-action", favorite: "bulk-favorite", read: "bulk-read", capture: "bulk-capture", delete: "bulk-delete" };
    const bookmarks = count => `${count} bookmark${count === 1 ? "" : "s"}`;
    if (browser.ResizeObserver) new browser.ResizeObserver(() => {
      document.documentElement.style.setProperty("--bulk-bar-height", `${bar.hidden ? 0 : bar.getBoundingClientRect().height}px`);
      position();
    }).observe(bar);
    function position() {
      if (!dialog.open || phone.matches) return;
      let anchor = $(session?.trigger || "bulk-open").getBoundingClientRect();
      // The phone launcher disappears in landscape; anchor to the visible bar.
      if (!anchor.width) anchor = bar.getBoundingClientRect();
      const width = dialog.getBoundingClientRect().width;
      dialog.style.setProperty("--bulk-panel-left", `${Math.max(16, Math.min(anchor.left, browser.innerWidth - width - 16))}px`);
      dialog.style.setProperty("--bulk-panel-bottom", `${Math.min(browser.innerHeight - 80, Math.max(16, browser.innerHeight - anchor.top + 12))}px`);
    }
    browser.addEventListener("resize", position);
    function close() { session = null; if (dialog.open) dialog.close(); }
    dialog.addEventListener("close", () => {
      if (dialog.open) return;
      const current = session; session = null;
      if (current && selected.size) $(phone.matches ? "bulk-open" : (triggers[current.action] || "select-page")).focus();
    });
    function render(links = visible) {
      visible = links;
      for (const link of visible) {
        const entry = selected.get(link.id);
        if (entry) Object.assign(entry, { label: link.title || link.url || `Bookmark ${link.id}`, read: !!link.read, favorite: !!link.favorite });
      }
      const count = visible.filter(link => selected.has(link.id)).length, outside = selected.size - count;
      $("selected-count").textContent = `${selected.size} selected`;
      $("selected-outside").textContent = outside ? `${outside} outside these results` : "";
      $("selected-outside").hidden = !outside;
      bar.hidden = !selected.size;
      const allRead = selected.size > 0 && [...selected.values()].every(entry => entry.read);
      const symbol = allRead ? "clock" : "check-circle", label = allRead ? "Unread" : "Read";
      for (const prefix of ["bulk-read", "bulk-menu-read"]) {
        $(prefix + "-icon").replaceChildren(icon(symbol));
        $(prefix + "-label").textContent = label;
      }
      $("bulk-read").setAttribute("aria-label", allRead ? "Mark selected bookmarks as unread" : "Mark selected bookmarks as read");
      const pageLabel = visible.length > 0 && count === visible.length ? "Unselect all" : "Select all";
      for (const id of ["select-page", "bulk-select-page"]) {
        $(id).disabled = visible.length === 0;
        $(id).setAttribute("aria-pressed", count > 0 && count < visible.length ? "mixed" : String(visible.length > 0 && count === visible.length));
      }
      $("select-page-label").textContent = $("bulk-select-page-label").textContent = pageLabel;
      $("bulk-menu-delete-label").textContent = `Delete ${bookmarks(selected.size)}`;
    }
    function select(link, checked) {
      if (checked && !selected.has(link.id)) {
        if (selected.size >= 500) { toast("Select up to 500 bookmarks at a time.", true); return false; }
        selected.set(link.id, { label: link.title || link.url || `Bookmark ${link.id}`, read: !!link.read, favorite: !!link.favorite });
      } else if (!checked) selected.delete(link.id);
      render();
      return selected.has(link.id);
    }
    function clear() {
      const restoreFocus = document.activeElement && (bar.contains(document.activeElement) || dialog.contains(document.activeElement));
      selected.clear(); close(); render();
      if (restoreFocus) $("page-title").focus();
    }
    function selectPage() {
      const checked = !visible.every(link => selected.has(link.id));
      let limited = false;
      for (const link of visible) {
        if (checked && !selected.has(link.id) && selected.size >= 500) {
          limited = true; break;
        }
        select(link, checked);
      }
      close(); render(); onSelectionChange();
      if (limited) toast("Only 500 bookmarks can be selected at a time. Some bookmarks on this page were not selected.", true);
      $(selected.size ? (phone.matches ? "bulk-open" : "select-page") : "page-title").focus();
    }
    $("select-page").addEventListener("click", selectPage);
    $("bulk-select-page").addEventListener("click", selectPage);
    $("clear-selection").addEventListener("click", () => { clear(); onSelectionChange(); $("page-title").focus(); });

    function renderCollections() {
      const query = $("bulk-collection-search").value.trim().toLocaleLowerCase();
      const nodes = [...$("bulk-collection").options].filter(option => option.textContent.toLocaleLowerCase().includes(query)).map(option => {
        const button = document.createElement("button"), label = document.createElement("span");
        button.type = "button"; button.className = "bulk-collection-option";
        label.textContent = option.textContent;
        button.setAttribute("aria-pressed", String(option.value === $("bulk-collection").value));
        button.append(icon("folder"), label);
        if (option.value === $("bulk-collection").value) button.append(icon("check"));
        button.addEventListener("click", () => {
          $("bulk-collection").value = option.value; renderCollections();
          // The list is replaced after selection; keep keyboard focus on its choice.
          $("bulk-collections").querySelector('[aria-pressed="true"]')?.focus();
        });
        return button;
      });
      $("bulk-collections").replaceChildren(...nodes);
      $("bulk-collections-empty").hidden = nodes.length > 0;
    }
    $("bulk-collection-search").addEventListener("input", renderCollections);
    function updateBusy() {
      const pending = !!session?.pending;
      $("bulk-apply").disabled = pending;
      $("bulk-status-true").disabled = $("bulk-status-false").disabled = pending;
      $("bulk-back").disabled = pending;
      dialog.setAttribute("aria-busy", String(pending));
    }
    function show(action, trigger = "bulk-open", fromMenu = false) {
      if (!selected.size || (action && !actionNames[action])) return;
      // Moving through the phone sheet preserves the original reviewed scope.
      const entries = fromMenu && session ? session.entries : [...selected].map(([id, entry]) => [id, { ...entry, identity: entry }]);
      session = { entries, action, trigger, fromMenu, pending: false };
      $("bulk-form").reset();
      $("bulk-error").textContent = "";
      dialog.dataset.action = action || "menu";
      dialog.setAttribute("role", action === "delete" ? "alertdialog" : "dialog");
      dialog.setAttribute("aria-describedby", ["delete", "capture"].includes(action) ? "bulk-scope bulk-description" : "bulk-scope");
      const count = entries.length, scope = bookmarks(count);
      const outside = entries.filter(([id]) => !visible.some(link => link.id === id)).length;
      $("bulk-title").textContent = !action ? `${count} selected` : ["favorite", "read"].includes(action) ? actionNames[action] : `${actionNames[action]} ${scope}${["delete", "capture"].includes(action) ? "?" : ""}`;
      $("bulk-scope").textContent = outside ? `${outside} outside these results. This action applies to all ${count} selected bookmarks.` : `${count} selected bookmark${count === 1 ? "" : "s"}`;
      $("bulk-review-label").textContent = `Review ${scope}`;
      $("bulk-review").hidden = !action;
      $("bulk-review").open = outside > 0 || action === "delete";
      $("bulk-items").replaceChildren(...entries.map(([, entry]) => { const li = document.createElement("li"); li.textContent = entry.label; return li; }));
      $("bulk-menu").hidden = !!action;
      $("bulk-back").hidden = !fromMenu;
      $("bulk-move-fields").hidden = action !== "move";
      $("bulk-tags-fields").hidden = action !== "tags";
      $("bulk-status-choices").hidden = !["favorite", "read"].includes(action);
      $("bulk-footer").hidden = !action || ["favorite", "read"].includes(action);
      $("bulk-description").hidden = !["capture", "delete"].includes(action);
      $("bulk-description").textContent = action === "delete" ? "Their saved content will also be deleted. This cannot be undone." : "Queue a new capture for each selected bookmark.";
      $("bulk-apply").textContent = ({ move: "Move here", tags: "Replace tags", capture: "Queue captures", delete: `Delete ${scope}` })[action] || "Apply";
      $("bulk-apply").className = `button ${action === "delete" ? "danger" : "primary"}`;
      if (action === "move") {
        fillCollections($("bulk-collection"), defaultCollection());
        $("bulk-collection-search").value = ""; renderCollections();
      }
      if (["favorite", "read"].includes(action)) {
        for (const value of [true, false]) {
          const prefix = `bulk-status-${value}`;
          $(prefix + "-label").textContent = action === "favorite" ? (value ? "Add to favorites" : "Remove from favorites") : (value ? "Mark as read" : "Mark as unread");
          $(prefix + "-icon").replaceChildren(icon(action === "favorite" ? (value ? "star" : "star-minus") : (value ? "check-circle" : "clock")));
        }
      }
      updateBusy();
      if (!dialog.open) { $(trigger).focus(); dialog.showModal(); }
      position();
      const focus = !action ? dialog.querySelector("[data-bulk-action]") : action === "move" ? $("bulk-collection-search") : action === "tags" ? ($("bulk-tags").hidden ? $("bulk-tags-query") : $("bulk-tags")) : action === "delete" ? $("bulk-cancel") : ["favorite", "read"].includes(action) ? $(`bulk-status-${action !== "read" || !entries.every(([, entry]) => entry.read)}`) : $("bulk-apply");
      focus.focus();
    }
    for (const [action, id] of Object.entries(triggers)) $(id).addEventListener("click", () => show(action, id));
    $("bulk-open").addEventListener("click", () => show(null));
    dialog.querySelectorAll("[data-bulk-action]").forEach(button => button.addEventListener("click", () => show(button.dataset.bulkAction, "bulk-open", true)));
    $("bulk-back").addEventListener("click", () => { if (!session?.pending) show(null); });
    // Arrow keys complement normal Tab navigation in the short action lists.
    for (const id of ["bulk-menu", "bulk-status-choices", "bulk-collections"]) $(id).addEventListener("keydown", event => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const buttons = [...$(id).querySelectorAll("button:not(:disabled)")];
      if (!buttons.length) return;
      const index = buttons.indexOf(document.activeElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      event.preventDefault(); buttons[next].focus();
    });
    async function undoStatus(entries, action, value) {
      // Restore only unchanged flags, never metadata edited after the operation.
      const groups = new Map([[true, []], [false, []]]);
      for (const [id, entry] of entries) {
        if (entry[action] === value) continue;
        let latest;
        try { latest = await api(`/api/links/${id}`); } catch (error) { if (error.status === 404) continue; throw error; }
        if (latest[action] === value) groups.get(entry[action]).push(id);
      }
      for (const [previous, ids] of groups) if (ids.length) await api("/api/links/bulk", { method: "POST", body: JSON.stringify({ ids, action, value: previous }) });
      await onChange(); toast("Change undone. Newer changes were kept.");
    }
    async function apply(value) {
      const current = session;
      if (!dialog.open || !current?.action || current.pending) return;
      const { action, entries } = current;
      const ids = entries.map(([id]) => id);
      const body = { ids, action, collectionId: $("bulk-collection").value ? Number($("bulk-collection").value) : null, tags: [...new Set($("bulk-tags").value.split(",").map(tag => tag.trim()).filter(Boolean))], value };
      current.pending = true; updateBusy(); $("bulk-error").textContent = "";
      const active = () => session === current && dialog.open;
      try {
        await api("/api/links/bulk", { method: "POST", body: JSON.stringify(body) });
        if (active()) {
          for (const [id, entry] of entries) if (selected.get(id) === entry.identity) selected.delete(id);
          close(); render(); onSelectionChange();
          $(selected.size ? (phone.matches ? "bulk-open" : triggers[action]) : "page-title").focus();
          const message = action === "capture" ? "Capture requests queued." : action === "read" ? `${bookmarks(ids.length)} marked as ${value ? "read" : "unread"}.` : action === "favorite" ? `${bookmarks(ids.length)} ${value ? "added to" : "removed from"} favorites.` : action === "delete" ? `${bookmarks(ids.length)} deleted.` : "Selected bookmarks updated.";
          toast(message, false, ["favorite", "read"].includes(action) ? { label: "Undo", run: () => undoStatus(entries, action, value) } : null);
        }
        await onChange();
      } catch (error) {
        if (error.status === 401) { clear(); onSelectionChange(); onSessionExpired(); }
        if (active()) $("bulk-error").textContent = error.message;
        else toast(error.message, true);
      } finally { current.pending = false; if (active()) updateBusy(); }
    }
    $("bulk-form").addEventListener("submit", event => { event.preventDefault(); if (!["favorite", "read"].includes(session?.action)) return apply(); });
    for (const value of [true, false]) $("bulk-status-" + value).addEventListener("click", () => apply(value));
    render();
    return { has: id => selected.has(id), select, clear, render, close };
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { create };
  else root.PocketmarkBulk = { create };
})(globalThis);
