"use strict";

// File-manager selection without changing the links and controls inside each card.
((root) => {
  function create({ grid, bulk, links, onChange }, browser = root) {
    let anchor = null, gesture = null, suppressClick = false;
    const interactive = "button,a,input,select,textarea,label,summary,[contenteditable]";
    const cardFor = target => target.closest(".bookmark-card[data-id]");
    function choose(card, range = false) {
      const visible = links(), id = Number(card.dataset.id), index = visible.findIndex(link => link.id === id);
      if (index < 0) return;
      const start = visible.findIndex(link => link.id === anchor);
      if (range && start >= 0) {
        for (const link of visible.slice(Math.min(start, index), Math.max(start, index) + 1)) {
          if (!bulk.select(link, true)) break;
        }
      } else { bulk.select(visible[index], !bulk.has(id)); anchor = id; }
      onChange();
      card.focus({ preventScroll: true });
    }
    grid.addEventListener("click", event => {
      if (suppressClick) { suppressClick = false; event.preventDefault(); event.stopPropagation(); return; }
      const card = cardFor(event.target);
      if (!card) return;
      // Modifiers on titles select; all other controls always keep their action.
      const title = event.target.closest(".card-title button");
      if (event.target.closest(interactive) && !(title && (event.shiftKey || event.ctrlKey || event.metaKey))) return;
      event.preventDefault(); event.stopPropagation();
      choose(card, event.shiftKey);
    }, true);
    grid.addEventListener("keydown", event => {
      const card = cardFor(event.target);
      if (!card || event.target !== card || event.key !== " ") return;
      event.preventDefault(); choose(card, event.shiftKey);
    });
    browser.document.addEventListener("keydown", event => {
      if (event.key !== "Escape" || browser.document.querySelector("dialog[open]") || event.target.closest("input,textarea,select,[contenteditable]")) return;
      const help = browser.document.querySelector(".selection-help[open]");
      if (help) { help.open = false; help.querySelector("summary").focus(); event.preventDefault(); return; }
      cancel(); bulk.clear(); onChange();
    });
    function cancel() {
      if (!gesture) return;
      const current = gesture; gesture = null;
      current.box?.remove();
      grid.classList.remove("is-selecting");
      if (grid.hasPointerCapture(current.pointerId)) grid.releasePointerCapture(current.pointerId);
    }
    grid.addEventListener("pointerdown", event => {
      // Touch keeps native scrolling and taps; marquee is a primary-mouse gesture.
      if (event.pointerType !== "mouse" || event.button !== 0 || event.target.closest(interactive)) return;
      cancel(); suppressClick = false;
      gesture = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, additive: event.ctrlKey || event.metaKey || event.shiftKey,
        cards: [...grid.querySelectorAll(".bookmark-card")].map(card => ({ card, id: Number(card.dataset.id), rect: card.getBoundingClientRect(), selected: bulk.has(Number(card.dataset.id)) })) };
    });
    grid.addEventListener("pointermove", event => {
      const current = gesture;
      if (!current || current.pointerId !== event.pointerId) return;
      if (!(event.buttons & 1)) { cancel(); return; }
      if (!current.box && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 5) return;
      if (!current.box) {
        current.box = browser.document.createElement("div");
        current.box.className = "selection-marquee"; current.box.setAttribute("aria-hidden", "true");
        browser.document.body.append(current.box);
        grid.classList.add("is-selecting"); grid.setPointerCapture(event.pointerId);
        browser.getSelection()?.removeAllRanges();
      }
      event.preventDefault();
      const left = Math.min(current.x, event.clientX), top = Math.min(current.y, event.clientY), right = Math.max(current.x, event.clientX), bottom = Math.max(current.y, event.clientY);
      Object.assign(current.box.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
      const visible = new Map(links().map(link => [link.id, link]));
      let limited = false;
      for (const entry of current.cards) {
        const hit = entry.rect.right > left && entry.rect.left < right && entry.rect.bottom > top && entry.rect.top < bottom;
        const selected = hit || (current.additive && entry.selected), link = visible.get(entry.id);
        if (!link || selected === bulk.has(entry.id)) continue;
        if (selected && limited) continue;
        if (bulk.select(link, selected) !== selected) limited = true;
      }
      onChange();
    });
    browser.document.addEventListener("pointerup", event => {
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      suppressClick = !!gesture.box;
      // A drag may release outside the grid; don't suppress a later, unrelated click.
      if (suppressClick) browser.setTimeout(() => { suppressClick = false; }, 0);
      cancel();
    });
    browser.document.addEventListener("pointercancel", cancel);
    grid.addEventListener("lostpointercapture", cancel);
    browser.addEventListener("blur", cancel);
    browser.document.addEventListener("click", event => {
      const help = browser.document.querySelector(".selection-help[open]");
      if (help && !help.contains(event.target)) help.open = false;
    });
    // Scrolling invalidates the viewport rectangles; native scrolling wins.
    browser.addEventListener("scroll", cancel, true);
    return { cancel };
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { create };
  else root.PocketmarkSelection = { create };
})(globalThis);
