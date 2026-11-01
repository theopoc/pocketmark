"use strict";
// The select remains the source of truth for saving and for the popup's existing
// programmatic updates; the visible combobox supplies the themed option list.
(() => {
  const pickers = [], content = document.getElementById("content");
  let openPicker = null;
  const panel = document.createElement("div");
  panel.className = "choice-panel";
  panel.hidden = true;
  panel.setAttribute("role", "listbox");
  document.body.append(panel);

  function close() {
    if (!openPicker) return;
    openPicker.trigger.setAttribute("aria-expanded", "false");
    openPicker.trigger.removeAttribute("aria-activedescendant");
    openPicker = null;
    panel.hidden = true;
    panel.replaceChildren();
  }
  function position() {
    if (!openPicker) return;
    const rect = openPicker.anchor.getBoundingClientRect();
    const width = Math.max(0, Math.min(rect.width, window.innerWidth - 16));
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    panel.style.left = `${left}px`;
    panel.style.width = `${width}px`;
    panel.style.maxHeight = "";
    const desired = Math.min(panel.scrollHeight, 216);
    const below = window.innerHeight - rect.bottom - 8, above = rect.top - 8;
    const upward = below < Math.min(desired, 100) && above > below;
    const space = Math.max(0, upward ? above : below);
    panel.style.maxHeight = `${Math.min(216, space)}px`;
    panel.style.top = `${upward ? Math.max(8, rect.top - Math.min(desired, space) - 4) : rect.bottom + 4}px`;
  }
  function paint() {
    if (!openPicker) return;
    panel.replaceChildren();
    openPicker.items.forEach((item, index) => {
      const row = document.createElement("div"), text = document.createElement("span");
      row.id = `choice-option-${index}`;
      row.className = "choice-option";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(openPicker.selected(item)));
      if (index === openPicker.active) row.dataset.active = "true";
      text.textContent = item.label;
      row.append(text);
      if (openPicker.selected(item)) {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
        path.setAttribute("d", "m5 12 4 4L19 6"); svg.append(path); row.append(svg);
      }
      row.addEventListener("pointerdown", event => event.preventDefault());
      row.addEventListener("click", () => { if (openPicker) { const picker = openPicker; picker.choose(index); } });
      panel.append(row);
    });
    if (openPicker.active >= 0) openPicker.trigger.setAttribute("aria-activedescendant", `choice-option-${openPicker.active}`);
    else openPicker.trigger.removeAttribute("aria-activedescendant");
    position();
    panel.children[openPicker.active]?.scrollIntoView({ block: "nearest" });
  }
  function open(picker) {
    if (!picker.items.length || picker.trigger.matches(":disabled")) return;
    close(); openPicker = picker;
    picker.active = picker.items.findIndex(item => picker.selected(item));
    if (picker.active < 0) picker.active = picker.isTag ? -1 : 0;
    panel.id = picker.id;
    const label = picker.trigger.labels?.[0];
    if (label && !label.id) label.id = `${picker.id}-label`;
    panel.setAttribute("aria-labelledby", label?.id || picker.trigger.id);
    picker.trigger.setAttribute("aria-expanded", "true");
    panel.hidden = false; paint();
  }
  function changeActive(step, absolute) {
    const picker = openPicker;
    if (!picker) return;
    picker.active = absolute == null ? Math.max(0, Math.min(picker.items.length - 1, picker.active + step)) : absolute;
    paint();
  }
  function keys(event, picker) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); event.stopImmediatePropagation();
      if (openPicker !== picker) { open(picker); if (picker.isTag && openPicker) changeActive(1); }
      else changeActive(event.key === "ArrowDown" ? 1 : -1);
    } else if (openPicker === picker && event.key === "Escape") {
      event.preventDefault(); event.stopImmediatePropagation(); close();
    } else if (openPicker === picker && !picker.isTag && (event.key === "Home" || event.key === "End")) {
      event.preventDefault(); changeActive(0, event.key === "Home" ? 0 : picker.items.length - 1);
    } else if (openPicker === picker && (event.key === "Enter" || (!picker.isTag && event.key === " ")) && picker.active >= 0) {
      event.preventDefault(); event.stopImmediatePropagation(); picker.choose(picker.active);
    } else if (!picker.isTag && openPicker !== picker && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault(); open(picker);
    } else if (!picker.isTag && openPicker === picker && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      picker.query = (picker.query || "") + event.key.toLocaleLowerCase();
      clearTimeout(picker.queryTimer);
      picker.queryTimer = setTimeout(() => { picker.query = ""; }, 700);
      const match = picker.items.findIndex(item => item.label.toLocaleLowerCase().startsWith(picker.query));
      if (match >= 0) { event.preventDefault(); changeActive(0, match); }
    }
  }
  function createPicker(select) {
    const trigger = document.createElement("button"), label = document.querySelector(`label[for="${select.id}"]`);
    trigger.type = "button"; trigger.id = `${select.id}-trigger`; trigger.className = "choice-trigger";
    trigger.setAttribute("role", "combobox"); trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false"); trigger.setAttribute("aria-controls", `${select.id}-choices`);
    if (label) label.htmlFor = trigger.id;
    const value = document.createElement("span"), svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true"); path.setAttribute("d", "m6 9 6 6 6-6"); svg.append(path); trigger.append(value, svg);
    select.insertAdjacentElement("afterend", trigger); select.hidden = true;
    const picker = {
      id: `${select.id}-choices`, select, trigger, anchor: trigger, items: [], active: 0,
      selected: item => item.value === select.value,
      choose(index) {
        const item = picker.items[index]; if (!item) return;
        select.value = item.value; select.dispatchEvent(new Event("change", { bubbles: true }));
        sync(); close(); trigger.focus();
      },
      update() {
        picker.items = Array.from(select.options, option => ({ value: option.value, label: option.textContent, disabled: option.disabled })).filter(item => !item.disabled);
        value.textContent = select.selectedOptions[0]?.textContent || "";
        trigger.disabled = select.disabled;
        if (openPicker === picker) { if (trigger.matches(":disabled")) close(); else paint(); }
      },
    };
    trigger.addEventListener("click", () => { if (openPicker === picker) close(); else { picker.update(); open(picker); } });
    trigger.addEventListener("keydown", event => keys(event, picker));
    pickers.push(picker); picker.update();
  }
  for (const id of ["collection", "collection-parent"]) createPicker(document.getElementById(id));

  const tagInput = document.getElementById("tag-input"), tagOptions = document.getElementById("tag-options");
  const tagPicker = {
    id: "tag-suggestions", trigger: tagInput, anchor: tagInput, isTag: true, items: [], active: -1,
    selected: () => false,
    choose(index) {
      const item = tagPicker.items[index]; if (!item) return;
      tagInput.value = item.value; close(); addTags(); tagInput.focus();
    },
  };
  tagInput.setAttribute("role", "combobox"); tagInput.setAttribute("aria-autocomplete", "list");
  tagInput.setAttribute("aria-expanded", "false"); tagInput.setAttribute("aria-controls", tagPicker.id);
  function refreshTags() {
    tagPicker.items = Array.from(tagOptions.options, option => ({ label: option.label || option.value, value: option.value }));
    if (document.activeElement === tagInput && tagPicker.items.length) open(tagPicker);
    else if (openPicker === tagPicker) close();
  }
  tagInput.addEventListener("focus", refreshTags);
  // Capture so Enter on an active suggestion is handled before the popup's
  // Enter/comma tag-commit handler.
  tagInput.addEventListener("keydown", event => keys(event, tagPicker), true);
  function sync() { for (const picker of pickers) picker.update(); }
  document.addEventListener("pointerdown", event => {
    if (openPicker && !openPicker.trigger.contains(event.target) && !panel.contains(event.target)) close();
  });
  document.addEventListener("focusin", event => {
    if (openPicker && !openPicker.trigger.contains(event.target) && !panel.contains(event.target)) close();
  });
  content.addEventListener("scroll", () => {
    if (!openPicker) return;
    const anchor = openPicker.anchor.getBoundingClientRect(), viewport = content.getBoundingClientRect();
    if (anchor.bottom <= viewport.top || anchor.top >= viewport.bottom) close();
    else position();
  }, { passive: true });
  window.addEventListener("resize", close);
  globalThis.PocketmarkSelectors = { sync, refreshTags, trigger: id => pickers.find(picker => picker.select.id === id)?.trigger };
  sync();
})();
