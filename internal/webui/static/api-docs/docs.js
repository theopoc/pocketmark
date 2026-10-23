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
  themeButton.addEventListener("click", () => {
    const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    setTheme(theme);
    try { localStorage.setItem("pocketmark-theme", theme); } catch { /* Storage is optional. */ }
  });
  document.getElementById("docs-retry").addEventListener("click", () => location.reload());

  const status = document.getElementById("docs-status");
  const reference = document.getElementById("swagger-ui");
  function labelControls() {
    reference.querySelector(".operation-filter-input")?.setAttribute("aria-label", "Filter API operations");
    reference.querySelector(".modal-ux-header .close-modal")?.setAttribute("aria-label", "Close authorizations");
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
        })],
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
