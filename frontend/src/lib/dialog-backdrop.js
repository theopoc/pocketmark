// A drag out of a dialog must preserve the contents being selected.
export function bindDialogBackdrop(dialog, lifecycle) {
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
}
