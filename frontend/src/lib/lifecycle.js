// Every native browser integration has one owner and an explicit teardown.
export function createLifecycle(browser = globalThis) {
  const cleanups = [];
  let listeners = [];
  let nextSweep = 256;
  const weak =
    typeof WeakRef === "function"
      ? (value) => new WeakRef(value)
      : (value) => ({ deref: () => value });
  const timers = new Set();
  const schedule = (browser.setTimeout || globalThis.setTimeout).bind(browser);
  const cancel = (browser.clearTimeout || globalThis.clearTimeout).bind(
    browser,
  );
  return {
    listen(target, type, handler, options) {
      target.addEventListener(type, handler, options);
      // Detached transient controls can be collected before the whole feature
      // closes. Teardown must not keep old result rows and their callbacks alive.
      listeners.push({
        target: weak(target),
        handler: weak(handler),
        type,
        options,
      });
      if (listeners.length >= nextSweep) {
        listeners = listeners.filter(
          (item) => item.target.deref() && item.handler.deref(),
        );
        nextSweep = listeners.length + 256;
      }
    },
    timeout(handler, delay) {
      const id = schedule(() => {
        timers.delete(id);
        handler();
      }, delay);
      timers.add(id);
      return id;
    },
    cancelTimeout(id) {
      timers.delete(id);
      cancel(id);
    },
    observe(observer) {
      cleanups.push(() => observer.disconnect());
      return observer;
    },
    dispose() {
      for (const item of listeners) {
        const target = item.target.deref(),
          handler = item.handler.deref();
        if (target && handler)
          target.removeEventListener?.(item.type, handler, item.options);
      }
      listeners = [];
      for (const cleanup of cleanups.splice(0).reverse()) cleanup();
      for (const id of timers) cancel(id);
      timers.clear();
    },
  };
}
