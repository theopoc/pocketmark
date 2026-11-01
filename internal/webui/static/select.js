"use strict";

// Keep native selects as the form/state source while drawing their options in the app.
((root) => {
  const instances = new WeakMap();
  let activePicker = null, sequence = 0;
  function enhance(source, browser = root) {
    if (instances.has(source)) return instances.get(source);
    const document = source.ownerDocument;
    if (!source.id) source.id = `pocketmark-select-${++sequence}`;
    const host = document.createElement("span"), trigger = document.createElement("button"), value = document.createElement("span"), panel = document.createElement("div");
    host.className = "app-select"; trigger.className = "app-select-trigger"; value.className = "app-select-value"; panel.className = "app-select-panel";
    trigger.type = "button"; trigger.id = `${source.id}-trigger`;
    trigger.setAttribute("role", "combobox"); trigger.setAttribute("aria-haspopup", "listbox"); trigger.setAttribute("aria-expanded", "false");
    panel.id = `${source.id}-options`; panel.setAttribute("role", "listbox"); panel.hidden = true;
    trigger.setAttribute("aria-controls", panel.id);
    panel.setAttribute("aria-labelledby", trigger.id);
    for (const attribute of ["aria-label", "aria-labelledby", "aria-describedby"]) {
      if (source.hasAttribute(attribute)) trigger.setAttribute(attribute, source.getAttribute(attribute));
    }
    const labels = [...source.labels || []];
    for (const label of labels) if (label.htmlFor === source.id) label.htmlFor = trigger.id;
    source.after(host); host.append(trigger, panel); source.classList.add("app-select-source");
    source.setAttribute("aria-hidden", "true"); source.tabIndex = -1;
    trigger.append(value);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"), path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true"); path.setAttribute("d", "m6 9 6 6 6-6"); svg.append(path); trigger.append(svg);
    const supportsPopover = typeof panel.showPopover === "function";
    if (supportsPopover) panel.setAttribute("popover", "manual");
    let active = -1, typing = "", typingTimer;
    const options = () => [...source.options];
    const enabled = option => option && !option.matches(":disabled");
    function sync() {
      value.textContent = source.selectedOptions[0]?.textContent || "";
      for (const attribute of ["aria-label", "aria-labelledby", "aria-describedby"]) {
        if (source.hasAttribute(attribute)) trigger.setAttribute(attribute, source.getAttribute(attribute));
        else trigger.removeAttribute(attribute);
      }
      trigger.disabled = source.matches(":disabled");
      if (trigger.disabled) close();
      else if (!panel.hidden) render();
    }
    function render() {
      panel.replaceChildren();
      options().forEach((option, index) => {
        const row = document.createElement("div"), label = document.createElement("span"), check = document.createElementNS("http://www.w3.org/2000/svg", "svg"), mark = document.createElementNS("http://www.w3.org/2000/svg", "path");
        row.className = "app-select-option"; row.id = `${source.id}-option-${index}`; row.setAttribute("role", "option");
        row.setAttribute("aria-selected", String(option.selected));
        if (!enabled(option)) row.setAttribute("aria-disabled", "true");
        if (active === index) row.classList.add("is-active");
        label.textContent = option.textContent; row.append(label);
        check.setAttribute("viewBox", "0 0 24 24"); check.setAttribute("aria-hidden", "true"); mark.setAttribute("d", "m5 12 4 4L19 6"); check.append(mark); row.append(check);
        row.addEventListener("mousedown", event => event.preventDefault());
        row.addEventListener("mousemove", () => { if (enabled(option) && active !== index) highlight(index); });
        row.addEventListener("click", () => { if (enabled(option)) choose(index); });
        panel.append(row);
      });
      if (active >= 0 && panel.children[active]) trigger.setAttribute("aria-activedescendant", panel.children[active].id);
      else trigger.removeAttribute("aria-activedescendant");
      position();
    }
    function position() {
      if (panel.hidden || !supportsPopover) return;
      const rect = trigger.getBoundingClientRect(), width = Math.min(Math.max(rect.width, 180), browser.innerWidth - 16);
      const below = browser.innerHeight - rect.bottom - 8, above = rect.top - 8;
      const upward = below < 200 && above > below;
      const available = Math.max(44, Math.min(264, upward ? above : below));
      panel.style.width = `${width}px`; panel.style.maxHeight = `${available}px`;
      panel.style.left = `${Math.max(8, Math.min(rect.left, browser.innerWidth - width - 8))}px`;
      panel.style.top = upward ? `${Math.max(8, rect.top - 4 - Math.min(panel.scrollHeight, available))}px` : `${rect.bottom + 4}px`;
    }
    function highlight(index) {
      active = index;
      [...panel.children].forEach((row, i) => row.classList.toggle("is-active", i === index));
      const row = panel.children[index];
      if (row) { trigger.setAttribute("aria-activedescendant", row.id); row.scrollIntoView({ block: "nearest" }); }
      else trigger.removeAttribute("aria-activedescendant");
    }
    function close() {
      if (panel.hidden) return;
      if (supportsPopover && panel.matches(":popover-open")) panel.hidePopover();
      panel.hidden = true; trigger.setAttribute("aria-expanded", "false"); trigger.removeAttribute("aria-activedescendant");
      if (activePicker === picker) activePicker = null;
    }
    function open() {
      sync(); if (trigger.disabled || !options().some(enabled)) return;
      if (activePicker && activePicker !== picker) activePicker.close();
      activePicker = picker; active = enabled(options()[source.selectedIndex]) ? source.selectedIndex : options().findIndex(enabled);
      panel.hidden = false; trigger.setAttribute("aria-expanded", "true");
      if (supportsPopover) panel.showPopover();
      render(); highlight(active);
    }
    function choose(index) {
      const changed = source.selectedIndex !== index;
      source.selectedIndex = index; sync(); close(); trigger.focus();
      if (changed) {
        source.dispatchEvent(new browser.Event("input", { bubbles: true }));
        source.dispatchEvent(new browser.Event("change", { bubbles: true }));
      }
    }
    function step(direction) {
      const all = options(); let index = active;
      for (let count = 0; count < all.length; count++) {
        index = (index + direction + all.length) % all.length;
        if (enabled(all[index])) { highlight(index); return; }
      }
    }
    trigger.addEventListener("click", () => { if (panel.hidden) open(); else close(); });
    trigger.addEventListener("keydown", event => {
      if (event.key === "Escape" && !panel.hidden) { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key === "Tab") { close(); return; }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        if (panel.hidden) open();
        else if (event.key === "Home") highlight(options().findIndex(enabled));
        else if (event.key === "End") highlight(options().findLastIndex(enabled));
        else step(event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault(); if (panel.hidden) open(); else if (active >= 0) choose(active); return;
      }
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing) {
        event.preventDefault(); event.stopPropagation();
        if (panel.hidden) open();
        typing += event.key.toLocaleLowerCase(); browser.clearTimeout(typingTimer); typingTimer = browser.setTimeout(() => { typing = ""; }, 700);
        const all = options(), start = active < 0 ? 0 : active + 1;
        for (let i = 0; i < all.length; i++) { const index = (start + i) % all.length; if (enabled(all[index]) && all[index].textContent.trim().toLocaleLowerCase().startsWith(typing)) { highlight(index); break; } }
      }
    });
    const form = source.form, dialog = source.closest("dialog");
    const reset = () => browser.setTimeout(sync, 0);
    const outside = event => { if (!host.contains(event.target)) close(); };
    source.addEventListener("change", sync);
    form?.addEventListener("reset", reset);
    dialog?.addEventListener("close", close);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("scroll", position, true); browser.addEventListener("resize", position);
    const observer = new browser.MutationObserver(sync);
    observer.observe(source, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["disabled", "selected", "label", "value", "aria-label", "aria-labelledby", "aria-describedby"] });
    for (let ancestor = source.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.tagName === "FIELDSET") observer.observe(ancestor, { attributes: true, attributeFilter: ["disabled"] });
    }
    function destroy() {
      close(); observer.disconnect(); browser.clearTimeout(typingTimer);
      source.removeEventListener("change", sync); form?.removeEventListener("reset", reset); dialog?.removeEventListener("close", close);
      document.removeEventListener("pointerdown", outside); document.removeEventListener("focusin", outside);
      document.removeEventListener("scroll", position, true); browser.removeEventListener("resize", position);
      for (const label of labels) if (label.htmlFor === trigger.id) label.htmlFor = source.id;
      source.classList.remove("app-select-source"); source.removeAttribute("aria-hidden"); source.removeAttribute("tabindex");
      host.remove(); instances.delete(source);
    }
    const picker = { sync, close, open, destroy };
    instances.set(source, picker); sync();
    return picker;
  }
  function enhanceAll(container = root.document) {
    container.querySelectorAll("select:not([hidden]):not([multiple])").forEach(source => enhance(source));
  }
  function sync(source) { instances.get(source)?.sync(); }
  function destroy(source) { instances.get(source)?.destroy(); }
  if (typeof module !== "undefined" && module.exports) module.exports = { enhance, enhanceAll, sync, destroy };
  else root.PocketmarkSelect = { enhance, enhanceAll, sync, destroy };
})(globalThis);
