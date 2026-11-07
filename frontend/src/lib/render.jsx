import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";

const roots = new Map();

// Native browser integrations (selection geometry, dialogs, animation snapshots)
// read the committed DOM after a command. Keep the React commit at this seam.
export function renderRegion(element, content) {
  let root = roots.get(element);
  if (!root) {
    root = createRoot(element);
    roots.set(element, root);
  }
  flushSync(() => root.render(content));
}

export function disposeRegions() {
  const previous = [...roots.values()];
  roots.clear();
  // React may be disposing the owning shell. Unmount the independent regions
  // after that commit; detached region containers still own their child trees.
  queueMicrotask(() => {
    for (const root of previous) root.unmount();
  });
}
