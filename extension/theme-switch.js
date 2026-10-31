"use strict";
((root) => {
  // The requested theme advances immediately; browser snapshots may settle later.
  function create({ initial = "dark", apply }, browser = root) {
    const document = browser.document;
    const reduced = browser.matchMedia?.("(prefers-reduced-motion: reduce)");
    let requested = initial, transition = null;
    function set(theme) {
      requested = theme;
      if (transition) { transition.skipTransition(); apply(requested); return; }
      if (!document.startViewTransition || document.hidden || reduced?.matches) { apply(requested); return; }
      document.documentElement.classList.add("theme-transition");
      try {
        const current = document.startViewTransition(() => apply(requested));
        transition = current;
        current.ready.catch(() => {});
        current.finished.catch(() => {}).then(() => {
          if (transition === current) { transition = null; document.documentElement.classList.remove("theme-transition"); }
        });
      } catch { document.documentElement.classList.remove("theme-transition"); apply(requested); }
    }
    reduced?.addEventListener?.("change", () => { if (reduced.matches) transition?.skipTransition(); });
    return { set, get requested() { return requested; } };
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { create };
  else root.PocketmarkThemeSwitch = { create };
})(globalThis);
