"use strict";
(() => {
  const themeButton = document.getElementById("docs-theme");
  function setTheme(theme) {
    const dark = theme === "dark";
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]').content = dark ? "#15161b" : "#ffffff";
    themeButton.textContent = dark ? "Dark" : "Light";
    themeButton.setAttribute("aria-label", dark ? "Dark mode" : "Light mode");
    themeButton.setAttribute("aria-pressed", String(dark));
    themeButton.title = dark ? "Switch to light mode" : "Switch to dark mode";
  }
  setTheme(document.documentElement.dataset.theme);
  const themeSwitch = globalThis.PocketmarkThemeSwitch.create({ initial: document.documentElement.dataset.theme, apply: setTheme });
  themeButton.addEventListener("click", () => {
    const theme = themeSwitch.requested === "dark" ? "light" : "dark";
    themeSwitch.set(theme);
    try { localStorage.setItem("pocketmark-theme", theme); } catch { /* Storage is optional. */ }
  });
  document.getElementById("docs-retry").addEventListener("click", () => location.reload());

  const status = document.getElementById("docs-status");
  const reference = document.getElementById("swagger-ui");
  // Swagger owns and may replace these DOM nodes during React updates. Leave
  // each native select in place and dispose its adjacent control when removed.
  const enhancedSelects = new Map();
  function selectorState(select) {
    return JSON.stringify([select.selectedIndex, select.disabled, [...select.options].map(option => [option.value, option.textContent, option.disabled])]);
  }
  function syncSelectors() {
    for (const [select] of enhancedSelects) {
      if (!reference.contains(select) || !select.nextElementSibling?.classList.contains("app-select")) {
        globalThis.PocketmarkSelect.destroy(select);
        enhancedSelects.delete(select);
      }
    }
    for (const select of reference.querySelectorAll("select:not([hidden]):not([multiple])")) {
      const state = selectorState(select);
      if (!enhancedSelects.has(select)) globalThis.PocketmarkSelect.enhance(select);
      else if (enhancedSelects.get(select) !== state) globalThis.PocketmarkSelect.sync(select);
      enhancedSelects.set(select, state);
    }
  }
  function labelControls() {
    const servers = reference.querySelector("#servers");
    if (servers && servers.getAttribute("aria-label") !== "API server") servers.setAttribute("aria-label", "API server");
    reference.querySelector(".operation-filter-input")?.setAttribute("aria-label", "Filter API operations");
    reference.querySelector(".modal-ux-header .close-modal")?.setAttribute("aria-label", "Close authorizations");
    for (const row of reference.querySelectorAll("tr[data-param-name]")) {
      for (const field of row.querySelectorAll("input, select, textarea")) {
        if (!field.getAttribute("aria-label") && !field.getAttribute("aria-labelledby") && !field.labels?.length) {
          field.setAttribute("aria-label", `${row.dataset.paramName} (${row.dataset.paramIn})`);
        }
      }
    }
    for (const example of reference.querySelectorAll(".highlight-code .microlight")) {
      example.setAttribute("tabindex", "0");
      example.setAttribute("role", "region");
      example.setAttribute("aria-label", "API example");
    }
    syncSelectors();
  }
  function accessibleOperations({ React }) {
    const plainPath = ({ text }) => React.createElement("span", null, text);
    return { wrapComponents: {
      // The upstream path link sits inside the summary button. Keep its text
      // there and expose the permalink as a separate keyboard target.
      OperationSummaryPath: (Original) => (props) => React.createElement(Original, {
        ...props,
        getComponent: (name, ...args) => name === "DeepLink" ? plainPath : props.getComponent(name, ...args),
      }),
      OperationSummary: (Original) => (props) => {
        const operation = props.operationProps;
        if (!operation.get("isDeepLinkingEnabled")) return React.createElement(Original, props);
        const label = `Permalink to ${operation.get("method").toUpperCase()} ${operation.get("path")}`;
        const href = `#/${encodeURIComponent(operation.get("tag"))}/${encodeURIComponent(operation.get("operationId"))}`;
        const openOperation = (event) => {
          if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
          if (!props.isShown) props.toggleShown(event);
        };
        return React.createElement("div", { className: "operation-summary-row" },
          React.createElement(Original, props),
          React.createElement("a", { className: "operation-permalink", href, onClick: openOperation, "aria-label": label, title: label },
            React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.7", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", focusable: "false" },
              React.createElement("path", { d: "M10 13a5 5 0 0 0 7 .1l3-3a5 5 0 0 0-7.1-7.1l-1.7 1.7M14 11a5 5 0 0 0-7-.1l-3 3a5 5 0 0 0 7.1 7.1l1.7-1.7" }))),
        );
      },
    } };
  }
  // Swagger renders these controls after its completion callback and on demand.
  const controls = new MutationObserver(labelControls);
  controls.observe(reference, { childList: true, subtree: true });
  async function load() {
    try {
      const response = await fetch("/api-docs/openapi.json", { cache: "no-store" });
      if (!response.ok) throw new Error("Specification unavailable");
      const spec = await response.json();
      if (!window.SwaggerUIBundle) throw new Error("Swagger UI unavailable");
      window.SwaggerUIBundle({
        spec,
        dom_id: "#swagger-ui",
        presets: [window.SwaggerUIBundle.presets.apis],
        plugins: [() => ({
          statePlugins: { auth: { wrapSelectors: {
            // The HttpOnly owner cookie is automatic, not a credential to paste.
            definitionsToAuthorize: (original) => (...args) => original(...args).filter((definition) => !definition.has("ownerSession")),
          } } },
        }), accessibleOperations],
        layout: "BaseLayout",
        deepLinking: true,
        filter: true,
        docExpansion: "none",
        defaultModelsExpandDepth: -1,
        displayRequestDuration: true,
        tryItOutEnabled: false,
        supportedSubmitMethods: ["get", "post", "put", "delete"],
        persistAuthorization: false,
        queryConfigEnabled: false,
        validatorUrl: null,
        syntaxHighlight: false,
        onComplete() {
          status.hidden = true;
          reference.setAttribute("aria-busy", "false");
          labelControls();
        },
      });
    } catch {
      controls.disconnect();
      status.hidden = true;
      reference.setAttribute("aria-busy", "false");
      document.getElementById("docs-error").hidden = false;
    }
  }
  load();
})();
