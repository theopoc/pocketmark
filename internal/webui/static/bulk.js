"use strict";

((root) => {
  function create({ api, toast, onChange, onSelectionChange, fillCollections, defaultCollection, onSessionExpired }, browser = root) {
    const document = browser.document, $ = id => document.getElementById(id);
    // Entries carry identity, so a remove/reselect is newer than an in-flight action.
    const selected = new Map();
    let visible = [], session = null;
    const dialog = $("bulk-dialog");
    const actions = { move: "Move", tags: "Replace tags on", favorite: "Update favorites for", read: "Update reading status for", capture: "Refresh captures for", delete: "Delete" };
    function close() { session = null; if (dialog.open) dialog.close(); }
    dialog.addEventListener("close", () => { if (!dialog.open) session = null; });
    function render(links = visible) {
      visible = links;
      const count = visible.filter(link => selected.has(link.id)).length, outside = selected.size - count;
      $("selected-count").textContent = `${selected.size} selected`;
      $("selected-outside").textContent = outside ? `${outside} outside these results` : "";
      $("selected-outside").hidden = !outside;
      $("selected-count").hidden = !selected.size;
      $("bulk-open").hidden = !selected.size; $("bulk-open").disabled = !selected.size;
      $("clear-selection").hidden = !selected.size;
      $("select-page").disabled = visible.length === 0;
      $("select-page").setAttribute("aria-pressed", count > 0 && count < visible.length ? "mixed" : String(visible.length > 0 && count === visible.length));
      $("select-page").textContent = visible.length > 0 && count === visible.length ? "Deselect page" : "Select page";
    }
    function select(link, checked) {
      if (checked && !selected.has(link.id)) {
        if (selected.size >= 500) { toast("Select up to 500 bookmarks at a time.", true); return false; }
        selected.set(link.id, { label: link.title || link.url || `Bookmark ${link.id}` });
      } else if (!checked) selected.delete(link.id);
      render();
      return selected.has(link.id);
    }
    function clear() { selected.clear(); close(); render(); }
    function updateAction() {
      const action = $("bulk-action").value, count = session?.entries.length || 0;
      $("bulk-move-fields").hidden = action !== "move";
      $("bulk-tags-fields").hidden = action !== "tags";
      $("bulk-value-fields").hidden = !["favorite", "read"].includes(action);
      $("bulk-value-label").textContent = action === "read" ? "Reading status" : "Favorite status";
      $("bulk-value").options[0].textContent = action === "read" ? "Read" : "Favorite";
      $("bulk-value").options[1].textContent = action === "read" ? "To read" : "Not favorite";
      $("bulk-apply").textContent = actions[action] ? `${actions[action]} ${count} bookmark${count === 1 ? "" : "s"}` : "Choose an action";
      $("bulk-apply").disabled = !actions[action] || !count || !!session?.pending;
    }
    $("select-page").addEventListener("click", () => {
      const checked = !visible.length || !visible.every(link => selected.has(link.id));
      for (const link of visible) {
        if (checked && !selected.has(link.id) && selected.size >= 500) {
          toast("Only 500 bookmarks can be selected at a time. Some bookmarks on this page were not selected.", true);
          break;
        }
        select(link, checked);
      }
      render();
      onSelectionChange();
    });
    $("clear-selection").addEventListener("click", () => { clear(); onSelectionChange(); });
    $("bulk-open").addEventListener("click", () => {
      if (!selected.size) return;
      session = { entries: [...selected], pending: false };
      $("bulk-form").reset();
      fillCollections($("bulk-collection"), defaultCollection());
      $("bulk-error").textContent = "";
      const count = session.entries.length, outside = count - visible.filter(link => selected.has(link.id)).length;
      $("bulk-title").textContent = `${count} selected bookmark${count === 1 ? "" : "s"}`;
      $("bulk-scope").textContent = outside ? `${outside} selected bookmark${outside === 1 ? " is" : "s are"} outside the current results. Review the full selection before applying an action.` : "This action applies to the bookmarks listed below.";
      $("bulk-review").open = outside > 0;
      $("bulk-items").replaceChildren(...session.entries.map(([, entry]) => { const li = document.createElement("li"); li.textContent = entry.label; return li; }));
      updateAction(); dialog.showModal(); $("bulk-action").focus();
    });
    $("bulk-action").addEventListener("change", updateAction);
    $("bulk-form").addEventListener("submit", async event => {
      event.preventDefault();
      const current = session, action = $("bulk-action").value;
      if (!dialog.open || !current || current.pending || !actions[action] || !current.entries.length) return;
      const ids = current.entries.map(([id]) => id);
      if (action === "delete" && !browser.confirm(`Delete ${ids.length} selected bookmarks and their saved content?`)) return;
      const body = { ids, action, collectionId: $("bulk-collection").value ? Number($("bulk-collection").value) : null, tags: [...new Set($("bulk-tags").value.split(",").map(tag => tag.trim()).filter(Boolean))], value: $("bulk-value").value === "true" };
      current.pending = true; updateAction(); $("bulk-error").textContent = "";
      const active = () => session === current && dialog.open;
      try {
        await api("/api/links/bulk", { method: "POST", body: JSON.stringify(body) });
        // Only the dialog that submitted this operation may consume its selection.
        if (active()) {
          for (const [id, entry] of current.entries) if (selected.get(id) === entry) selected.delete(id);
          close(); render(); onSelectionChange(); toast("Selected bookmarks updated.");
        }
        await onChange();
      } catch (error) {
        if (error.status === 401) { clear(); onSelectionChange(); onSessionExpired(); }
        else if (active()) $("bulk-error").textContent = error.message;
        else toast(error.message, true);
      } finally { current.pending = false; if (active()) updateAction(); }
    });
    render();
    return { has: id => selected.has(id), select, clear, render, close };
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { create };
  else root.PocketmarkBulk = { create };
})(globalThis);
