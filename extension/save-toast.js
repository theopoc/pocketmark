"use strict";
globalThis.PocketmarkSaveToast = (() => {
  function outcome(job, surface = "page") {
    const inPopup = surface === "popup";
    if (job?.status === "done") return { message: "Saved to Pocketmark.", error: false, duration: inPopup ? 3500 : 9000 };
    let message = job?.linkId ? "Bookmark saved. Some captures need attention." : "Pocketmark couldn’t confirm the save.";
    if (!inPopup) message += job?.linkId ? " Reopen Pocketmark to retry." : " Reopen the extension to try again.";
    return { message, error: true, duration: inPopup ? 8000 : 12000 };
  }

  // Chrome serializes this function into the tab's isolated world. Only the
  // fixed outcome text is rendered, never bookmark metadata or server errors.
  function render(expectedURL, feedback, theme, deadline) {
    if (deadline && Date.now() >= deadline) return false;
    if (expectedURL && location.href !== expectedURL) return false;
    const slot = expectedURL === null ? document.getElementById("save-feedback") : null;
    const host = document.createElement("div");
    if (!slot) host.popover = "manual";
    const root = host.attachShadow({ mode: "closed" });
    const sheet = new CSSStyleSheet();
    const exitMs = 220;
    const offset = slot ? "-6px" : "6px";
    sheet.replaceSync(`
      :host {
        all: initial !important;
        pointer-events: none !important;
      }
      :host(:not([popover])) { display: block !important; margin: 12px 16px 0 !important; }
      :host([popover]) {
        position: fixed !important;
        inset: auto 16px max(16px, env(safe-area-inset-bottom)) !important;
        width: max-content !important;
        max-width: min(560px, calc(100% - 32px)) !important;
        margin: 0 auto !important;
      }
      :host::backdrop { display: none !important; }
      .toast {
        --surface: #1b212c; --line: #262d3a; --ink: #eef1f6;
        --success: #7fe8d9; --danger: #ffa39a;
        box-sizing: border-box; display: flex; align-items: center; gap: 12px;
        min-height: 60px; padding: 12px 16px; border-radius: 12px;
        border: 1px solid var(--line);
        background: var(--surface); color: var(--ink);
        box-shadow: 0 6px 24px #10182825; overflow-wrap: anywhere;
        font: 500 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .toast.light {
        --surface: #f7f8fb; --line: #e4e8ef; --ink: #12161f;
        --success: #0a6d60; --danger: #b42318;
      }
      .toast.leaving { opacity: 0; }
      @media (prefers-reduced-motion: no-preference) {
        .toast { transition: opacity 280ms ease-out, transform 280ms ease-out; }
        @starting-style { .toast { opacity: 0; transform: translateY(${offset}); } }
        .toast.leaving {
          transform: translateY(${offset});
          transition-duration: ${exitMs}ms;
          transition-timing-function: ease-in;
        }
      }
      @media (prefers-reduced-motion: reduce) { .toast { transition: none; } }
      svg { flex: none; width: 20px; height: 20px; fill: none; stroke: currentColor;
        stroke-width: 1.7; stroke-linejoin: round; stroke-linecap: round;
        color: var(${feedback.error ? "--danger" : "--success"}); }
    `);
    root.adoptedStyleSheets = [sheet];
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.classList.toggle("light", theme === "light");
    toast.setAttribute("role", feedback.error ? "alert" : "status");
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("viewBox", "0 0 24 24");
    const path = document.createElementNS(icon.namespaceURI, "path");
    path.setAttribute("d", feedback.error ? "M12 3 2 20h20ZM12 9v4m0 3v.1" : "m5 12 4 4L19 6");
    icon.append(path);
    const label = document.createElement("span");
    toast.append(icon, label);
    root.append(toast);
    globalThis.pocketmarkDismissSaveToast?.();
    if (slot) {
      slot.append(host);
    } else {
      // Earlier modal dialogs stay in the DOM but become inert. Follow focus
      // into the active dialog, including dialogs in open shadow trees.
      let modal;
      for (let focus = document.activeElement; focus; focus = focus.shadowRoot?.activeElement) {
        modal = focus.closest("dialog:modal") || modal;
      }
      if (!modal && document.querySelector("dialog:modal")) {
        modal = document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest("dialog:modal")
          || [...document.querySelectorAll("dialog:modal")].at(-1);
      }
      (modal || document.documentElement).append(host);
      host.showPopover();
    }
    label.textContent = feedback.message;
    const port = globalThis.chrome?.runtime?.connect?.({ name: "save-toast-theme" });
    port?.onMessage.addListener((value) => toast.classList.toggle("light", value === "light"));
    const exitTimer = setTimeout(() => {
      if (!matchMedia("(prefers-reduced-motion: reduce)").matches) toast.classList.add("leaving");
    }, Math.max(0, feedback.duration - exitMs));
    function dismiss() {
      clearTimeout(exitTimer);
      clearTimeout(removeTimer);
      port?.disconnect();
      host.remove();
      delete globalThis.pocketmarkDismissSaveToast;
    }
    const removeTimer = setTimeout(dismiss, feedback.duration);
    globalThis.pocketmarkDismissSaveToast = dismiss;
    return true;
  }

  async function showInTab(tabId, url, feedback, theme) {
    const timeout = 1500, deadline = Date.now() + timeout;
    let timer;
    async function deliver() {
      const tab = await chrome.tabs.get(tabId);
      if (Date.now() >= deadline || !tab.active || tab.discarded || tab.url !== url) return false;
      const [frame] = await chrome.scripting.executeScript({
        target: { tabId }, injectImmediately: true,
        func: render, args: [url, feedback, theme === "light" ? "light" : "dark", deadline],
      });
      return frame?.result === true;
    }
    try {
      // A suspended renderer must not keep the durable save job running.
      return await Promise.race([deliver(), new Promise(resolve => { timer = setTimeout(() => resolve(false), timeout); })]);
    } catch { return false; } // Chrome can deny injection or the source tab can disappear.
    finally { clearTimeout(timer); }
  }
  return { outcome, render, showInTab, dismiss: () => globalThis.pocketmarkDismissSaveToast?.() };
})();
