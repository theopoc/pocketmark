export const readerTextSizes = [15, 17, 20, 22, 24, 28, 32];

export function bindReaderTextSize($, lifecycle, window) {
  const trigger = $("reader-size-trigger");
  const panel = $("reader-size-panel");
  const slider = $("reader-size");
  const reader = $("reader-dialog");

  function applySize() {
    const pixels = readerTextSizes[slider.value];
    const valueText = `${pixels} pixels`;
    for (const root of [$("reader-content"), $("reader-rich-article")])
      root.style.fontSize = `${pixels}px`;
    slider.setAttribute("aria-valuetext", valueText);
    trigger.setAttribute("aria-label", `Text size, ${valueText}`);
    $("reader-size-value").textContent = `${pixels} px`;
  }

  function positionPanel() {
    const anchor = trigger.getBoundingClientRect();
    panel.style.setProperty("--trigger-right", `${anchor.right}px`);
    panel.style.top = `${anchor.bottom + 6}px`;
  }
  lifecycle.listen(panel, "beforetoggle", (event) => {
    const open = event.newState === "open";
    trigger.setAttribute("aria-expanded", String(open));
    if (open) positionPanel();
  });
  lifecycle.listen(window, "resize", () => {
    if (panel.matches(":popover-open")) positionPanel();
  });
  lifecycle.listen(reader, "focusin", ({ target }) => {
    if (
      target !== reader &&
      target !== trigger &&
      !panel.contains(target) &&
      panel.matches(":popover-open")
    )
      panel.hidePopover();
  });
  lifecycle.listen(reader, "keydown", (event) => {
    if (event.key !== "Escape" || !panel.matches(":popover-open")) return;
    // WebKit can otherwise dismiss the enclosing reader with the same Escape.
    event.preventDefault();
    event.stopPropagation();
    panel.hidePopover();
    trigger.focus({ preventScroll: true });
  });
  lifecycle.listen(slider, "input", applySize);

  return (available) => {
    trigger.disabled = !available;
    if (available) applySize();
    else panel.hidePopover();
  };
}
