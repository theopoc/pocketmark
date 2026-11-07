import { createRoot, hydrateRoot } from "react-dom/client";
import { useLayoutEffect } from "react";
import { Shell } from "./shell";
import { Sidebar } from "./components/sidebar";
import { Toast } from "./components/toast";
import { createApplication } from "./application";
import "./styles.css";

const roots = [];
let readyCount = 0,
  disposeApplication;
function ready() {
  if (++readyCount === 3) disposeApplication = createApplication();
}
function Ready({ children }) {
  useLayoutEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) ready();
    });
    return () => {
      active = false;
    };
  }, []);
  return children;
}
function mount(id, view) {
  const container = document.getElementById(id);
  if (container.hasChildNodes()) return hydrateRoot(container, view);
  const root = createRoot(container);
  root.render(view);
  return root;
}
roots.push(
  mount(
    "root",
    <Shell
      onReady={() => {
        ready();
        return () => {
          disposeApplication?.();
          queueMicrotask(() => {
            for (const root of roots.slice(1)) root.unmount();
          });
        };
      }}
    />,
  ),
);
// These containers are outside the shell's React tree. Native dialog/rail
// positioning moves the containers, never the React-owned sidebar or toast.
roots.push(
  mount(
    "navigation-root",
    <Ready>
      <Sidebar />
    </Ready>,
  ),
);
roots.push(
  mount(
    "toast-root",
    <Ready>
      <Toast />
    </Ready>,
  ),
);
