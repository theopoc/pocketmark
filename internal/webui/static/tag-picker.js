"use strict";

((root) => {
  const workspace = typeof module !== "undefined" && module.exports ? require("./workspace.js") : root.PocketmarkWorkspace;
  // Both forms use native input/reset events; callers only set saved tag names.
  function create({ id, api, icon, move = () => {} }, browser = root) {
    const document = browser.document, window = browser, $ = id => document.getElementById(id);
    const reducedMotion = browser.matchMedia("(prefers-reduced-motion: reduce)");
    const setTimeout = browser.setTimeout.bind(browser), clearTimeout = browser.clearTimeout.bind(browser);
    function el(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }
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
      if (emit) source.dispatchEvent(new browser.Event("input", { bubbles: true }));
    }
    function renderTags() {
      const previous = new Map();
      const animateTags = !reducedMotion.matches && input.closest("dialog").open;
      if (animateTags) {
        field.querySelectorAll(".tag-picker-chip").forEach((chip) => previous.set(chip.dataset.tagName, chip.getBoundingClientRect()));
      }
      rendering = true;
      field.querySelectorAll(".tag-picker-chip").forEach((chip) => { chip.getAnimations?.().forEach(animation => animation.cancel()); chip.remove(); });
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
    const picker = { set(names) { selected = workspace.tagValues(names); input.value = ""; renderTags(); sync(false); close(); } };
    function position() {
      if (panel.hidden) return;
      const bounds = field.getBoundingClientRect(), dialog = input.closest("dialog").getBoundingClientRect();
      const below = dialog.bottom - bounds.bottom - 12, above = bounds.top - dialog.top - 12;
      const upward = below < 240 && above > below;
      panel.dataset.side = Math.max(above, below) < 120 ? "inline" : upward ? "above" : "below";
      list.style.maxHeight = `${Math.max(44, Math.min(216, (upward ? above : below) - status.offsetHeight - 28))}px`;
    }
    function close() {
      clearTimeout(timer); generation++; panel.hidden = true; options = []; active = -1;
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
          if (request !== generation || !input.closest("dialog")?.open) return;
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
    input.addEventListener("compositionend", () => input.dispatchEvent(new browser.Event("input", { bubbles: true })));
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
    input.form.addEventListener("reset", () => picker.set([]));
    input.closest("dialog").addEventListener("close", () => { if (!input.closest("dialog").open) close(); });
    input.closest("dialog").addEventListener("scroll", position, { passive: true });
    window.addEventListener("resize", position);
    return picker;
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { create };
  else root.PocketmarkTagPicker = { create };
})(globalThis);
