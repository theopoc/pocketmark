"use strict";
globalThis.PocketmarkSaveToast = (() => {
  function outcome(job) {
    if (job?.status === "done") return { message: "Saved to Pocketmark.", error: false, duration: 5000 };
    const message = job?.linkId
      ? "Bookmark saved. Some captures need attention. Reopen Pocketmark to retry."
      : "Pocketmark couldn’t confirm the save. Reopen the extension to try again.";
    return { message, error: true, duration: 12000 };
  }

  // Chrome serializes this function into the tab's isolated world. Only the
  // fixed outcome text is rendered, never bookmark metadata or server errors.
  function render(expectedURL, feedback, theme, deadline) {
    if (deadline && Date.now() >= deadline) return false;
    if (expectedURL && location.href !== expectedURL) return false;
    const host = document.createElement("div");
    host.popover = "manual";
    const root = host.attachShadow({ mode: "closed" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      :host {
        all: initial !important;
        position: fixed !important;
        inset: auto 16px max(16px, env(safe-area-inset-bottom)) !important;
        width: max-content !important;
        max-width: min(560px, calc(100% - 32px)) !important;
        margin: 0 auto !important;
        pointer-events: none !important;
      }
      :host::backdrop { display: none !important; }
      .toast {
        --surface: #1e2029; --line: #30323e; --ink: #e8e9ef;
        --success: #80c9a3; --danger: #f58a96;
        box-sizing: border-box; display: flex; align-items: center; gap: 12px;
        min-height: 60px; padding: 12px 16px; border-radius: 12px;
        border: 1px solid var(--line);
        background: var(--surface); color: var(--ink);
        box-shadow: 0 6px 24px #20232c25; overflow-wrap: anywhere;
        font: 500 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .toast.light {
        --surface: #f8f9fb; --line: #e3e5eb; --ink: #20232c;
        --success: #23714a; --danger: #b12e35;
      }
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
    globalThis.pocketmarkSaveToastHost?.remove();
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
    label.textContent = feedback.message;
    globalThis.pocketmarkSaveToastHost = host;
    const port = globalThis.chrome?.runtime?.connect?.({ name: "save-toast-theme" });
    port?.onMessage.addListener((value) => toast.classList.toggle("light", value === "light"));
    setTimeout(() => {
      port?.disconnect();
      host.remove();
      if (globalThis.pocketmarkSaveToastHost === host) delete globalThis.pocketmarkSaveToastHost;
    }, feedback.duration);
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
  return { outcome, render, showInTab };
})();
