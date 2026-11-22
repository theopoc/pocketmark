export function createReaderPage({ document, lifecycle, breadcrumbs, close }) {
  const byId = (id) => document.getElementById(id);
  const dialog = byId("reader-dialog");
  const panel = byId("reader-text-panel");
  const nav = byId("reader-page-breadcrumb");
  const toggle = byId("reader-page-toggle");
  let currentTitle;

  function setTitle(title) {
    if (currentTitle) currentTitle.textContent = currentTitle.title = title;
    nav.scrollLeft = nav.scrollWidth;
  }

  function setPage(expand) {
    const previousScroll = panel.scrollTop;
    const previousHeight = panel.scrollHeight - panel.clientHeight;
    const bounds = previousScroll ? panel.getBoundingClientRect() : null;
    const visible =
      bounds &&
      document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + 1);
    const anchor =
      visible &&
      panel.contains(visible) &&
      visible.closest(
        "p, h1, h2, h3, h4, h5, h6, li, pre, figure, table, blockquote, mark",
      );
    const offset = anchor && anchor.getBoundingClientRect().top - bounds.top;
    dialog.dataset.layout = expand ? "page" : "panel";
    nav.hidden = !expand;
    nav.replaceChildren();
    currentTitle = null;
    const name = expand ? "Return to side panel" : "Expand to full page";
    toggle.title = name;
    toggle.setAttribute("aria-label", name);
    if (expand) {
      const levels = breadcrumbs();
      for (const [index, crumb] of levels.entries()) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = button.title = crumb.label;
        lifecycle.listen(button, "click", () => {
          close();
          if (index < levels.length - 1) crumb.action();
          const target = [
            ...byId("breadcrumb").querySelectorAll("button"),
          ].find((node) => node.dataset.focusKey === crumb.key);
          target?.focus({ preventScroll: true });
        });
        const separator = document.createElement("span");
        separator.className = "reader-crumb-separator";
        separator.setAttribute("aria-hidden", "true");
        nav.append(button, separator);
      }
      currentTitle = document.createElement("span");
      currentTitle.setAttribute("aria-current", "page");
      nav.append(currentTitle);
      setTitle(byId("reader-title").textContent);
    }
    if (anchor)
      panel.scrollTop +=
        anchor.getBoundingClientRect().top -
        panel.getBoundingClientRect().top -
        offset;
    else if (previousScroll && previousHeight > 0)
      panel.scrollTop =
        (previousScroll / previousHeight) *
        (panel.scrollHeight - panel.clientHeight);
  }
  lifecycle.listen(toggle, "click", () => setPage(nav.hidden));
  lifecycle.listen(dialog, "cancel", (event) => {
    if (event.target !== dialog || nav.hidden) return;
    event.preventDefault();
    setPage(false);
    toggle.focus({ preventScroll: true });
  });
  return { setTitle, reset: () => setPage(false) };
}
