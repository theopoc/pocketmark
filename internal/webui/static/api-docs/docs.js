"use strict";
(() => {
  const themeButton = document.getElementById("docs-theme");
  function setTheme(theme) {
    const dark = theme === "dark";
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]').content = dark ? "#1a1b1d" : "#faf9f6";
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
  function enableSearch(spec, swagger) {
    const region = document.getElementById("operation-search");
    const input = document.getElementById("docs-query");
    const clear = document.getElementById("clear-query");
    const results = document.getElementById("operation-results");
    const count = document.getElementById("result-count");
    const quick = document.getElementById("quick-operation");
    const operations = [];
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        if (!operation.operationId || !operation.tags?.length) continue;
        const tag = operation.tags[0], verb = method.toUpperCase();
        operations.push({ path, verb, summary: operation.summary || "", href: `#/${encodeURIComponent(tag)}/${encodeURIComponent(operation.operationId)}`,
          words: [path, operation.summary, ...operation.tags].join(" ").toLowerCase() });
      }
    }
    function update() {
      const query = input.value.trim();
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const matches = query ? operations.filter(operation => terms.every(term =>
        /^(get|post|put|delete|head|options|patch|trace)$/.test(term) ? term === operation.verb.toLowerCase() : operation.words.includes(term))) : [];
      clear.hidden = !query;
      quick.hidden = Boolean(query);
      results.hidden = !matches.length;
      reference.hidden = Boolean(query);
      count.textContent = !query ? "" : matches.length ? `${matches.length} matching operation${matches.length === 1 ? "" : "s"}` : `No operations match “${query}”.`;
      results.replaceChildren();
      for (const operation of matches) {
        const item = document.createElement("li"), link = document.createElement("a");
        const method = document.createElement("strong"), path = document.createElement("code"), summary = document.createElement("span");
        link.href = operation.href; method.textContent = operation.verb; path.textContent = operation.path; summary.textContent = operation.summary;
        link.append(method, path, summary); item.append(link); results.append(item);
      }
    }
    region.addEventListener("click", event => {
      const link = event.target.closest("a");
      if (!link || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      if (input.value) { input.value = ""; update(); }
      swagger.layoutActions.parseDeepLinkHash(decodeURIComponent(link.hash));
      requestAnimationFrame(() => {
        const target = [...reference.querySelectorAll(".operation-permalink")].find(item => item.hash === link.hash);
        const button = target?.parentElement.querySelector(".opblock-summary-control");
        if (button) { button.focus({ preventScroll: true }); button.scrollIntoView({ block: "nearest" }); }
      });
    });
    clear.addEventListener("click", () => { input.value = ""; update(); input.focus(); });
    input.addEventListener("input", update);
    region.hidden = false;
  }
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
    reference.querySelector(".modal-ux-header .close-modal")?.setAttribute("aria-label", "Close authorizations");
    for (const form of reference.querySelectorAll(".auth-container")) {
      const title = form.querySelector("h4 code");
      if (title?.textContent === "bearerAuth") title.textContent = "Pocketmark API key";
      if (title?.textContent === "davBasic") title.textContent = "WebDAV credentials";
      for (const label of form.querySelectorAll("label[for]")) {
        const field = document.getElementById(label.htmlFor);
        if (!field) continue;
        if (title?.textContent === "Pocketmark API key" && label.textContent !== "API key") label.textContent = "API key";
        else if (title?.textContent === "WebDAV credentials" && field.type === "password" && label.textContent !== "Sync API key") label.textContent = "Sync API key";
        if (field.hasAttribute("aria-label")) field.removeAttribute("aria-label");
      }
    }
    for (const button of reference.querySelectorAll(".modal-ux .auth-btn-wrapper button[aria-label]")) {
      if (button.textContent.trim()) button.removeAttribute("aria-label");
    }
    for (const button of reference.querySelectorAll(".model-box-control")) {
      const title = button.querySelector(".model-title__text")?.textContent.trim();
      const property = button.closest(".property-row")?.firstElementChild?.textContent.replace(/\*/g, "").trim();
      const name = title || (button.closest(".prop-enum") ? `${property || "Schema"} allowed values` : property) || "Schema details";
      if (button.getAttribute("aria-label") !== name) button.setAttribute("aria-label", name);
    }
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
      reference.setAttribute("data-single-server", String(spec.servers?.length === 1));
      const swagger = window.SwaggerUIBundle({
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
        filter: false,
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
      enableSearch(spec, swagger);
    } catch {
      controls.disconnect();
      status.hidden = true;
      reference.setAttribute("aria-busy", "false");
      document.getElementById("docs-error").hidden = false;
    }
  }
  load();
})();
