import { createAccountPassword } from "./account-password";
import { createAuthenticator } from "./authenticator";
import { createKeyRegister } from "./key-register.jsx";
import { createSettingsDesk } from "./desk.js";
import { createLifecycle } from "../../lib/lifecycle.js";
export function createSettings(
  {
    state,
    api,
    toast,
    el,
    icon,
    confirmAction,
    renderBreadcrumb,
    move,
    activeMotion,
    route,
    commitRoute,
    restoreRoute,
    showLogin,
    security,
    downloadRecoveryCodes,
  },
  browser = globalThis,
) {
  const { document, history, location, navigator } = browser;
  const window = browser;
  const $ = (id) => document.getElementById(id);
  const lifecycle = createLifecycle(browser);
  const showSection = createSettingsDesk({
    document,
    history,
    lifecycle,
    icon,
    navigateSettings,
  });
  const navigationControls = document.querySelectorAll(
    "[data-settings-section], [data-settings-go]",
  );
  const keys = createKeyRegister({ document, api, confirmAction, toast });
  const password = createAccountPassword({
    document,
    lifecycle,
    api,
    state,
    security,
    toast,
  });
  const authenticator = createAuthenticator({
    document,
    navigator,
    lifecycle,
    state,
    api,
    security,
    confirmAction,
    showLogin,
    syncSettingsNavigation,
    downloadRecoveryCodes,
  });
  function syncSettingsNavigation() {
    navigationControls.forEach((button) => {
      button.disabled =
        (state.mfaManagementBusy || state.deferredLogin) &&
        (button.dataset.settingsSection || button.dataset.settingsGo) !==
          state.settingsSection;
    });
    document
      .querySelectorAll("[data-settings-back], [data-settings-home]")
      .forEach((button) => {
        button.disabled = state.mfaManagementBusy;
      });
    $("breadcrumb")
      .querySelectorAll("button")
      .forEach((button) => {
        button.disabled = state.mfaManagementBusy;
      });
  }
  function renderSettings(animate = false) {
    const active = Boolean(state.settingsSection);
    if (state.settingsSection !== "sessions") security.closeSessionDialogs();
    const entering = active && $("settings-page").hidden;
    $("settings-page").hidden = !active;
    $("library-content").hidden = active;
    $("library-navigation").hidden = active;
    $("settings-navigation").hidden = !active;
    $("app-view").classList.toggle("showing-settings", active);
    renderBreadcrumb();
    showSection(state.settingsSection);
    keys.visible(state.settingsSection === "api-keys");
    document.querySelectorAll("[data-settings-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.settingsPanel !== state.settingsSection;
    });
    document.querySelectorAll("[data-settings-section]").forEach((button) => {
      const selected = button.dataset.settingsSection === state.settingsSection;
      button.classList.toggle("active", selected);
      if (selected) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    syncSettingsNavigation();
    if (!active) {
      [$("settings-page"), $("settings-navigation")].forEach((element) =>
        activeMotion.get(element)?.cancel(),
      );
    } else if (animate && entering) {
      // The rail changes context as the settings workspace settles beside it.
      move($("settings-navigation"), [{ opacity: 0.75 }, { opacity: 1 }]);
      move(
        $("settings-page"),
        [
          { opacity: 0.75, transform: "translateX(12px)" },
          { opacity: 1, transform: "translateX(0)" },
        ],
        220,
      );
    }
  }
  function revealSettingsSection() {
    if (!state.settingsSection) return;
    const navigation = $("settings-navigation");
    const selected = navigation.querySelector('[aria-current="page"]');
    if (!selected) return;
    const panel = navigation.getBoundingClientRect();
    const item = selected.getBoundingClientRect();
    if (
      navigation.scrollWidth > navigation.clientWidth &&
      (item.left < panel.left || item.right > panel.right)
    )
      navigation.scrollLeft +=
        item.left < panel.left
          ? item.left - panel.left - 18
          : item.right - panel.right + 18;
    if (
      navigation.scrollHeight > navigation.clientHeight &&
      (item.top < panel.top || item.bottom > panel.bottom)
    )
      navigation.scrollTop +=
        item.top < panel.top
          ? item.top - panel.top - 18
          : item.bottom - panel.bottom + 18;
  }
  lifecycle
    .observe(new browser.ResizeObserver(revealSettingsSection))
    .observe($("settings-navigation"));
  function focusSettings() {
    const heading =
      document.querySelector("[data-settings-panel]:not([hidden]) h1") ||
      $("settings-detail-title");
    heading.focus({ preventScroll: true });
    revealSettingsSection();
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  function navigateSettings(section) {
    if (keys.valueProtected()) return;
    if (state.mfaManagementBusy || state.deferredLogin) return;
    if (!state.settingsSection) state.libraryReturnScroll = window.scrollY;
    commitRoute(false, { ...route(), settingsSection: section });
    history.replaceState(
      { ...history.state, pocketmarkLibraryScroll: state.libraryReturnScroll },
      "",
    );
    restoreRoute();
  }
  navigationControls.forEach((button) =>
    lifecycle.listen(button, "click", () =>
      navigateSettings(
        button.dataset.settingsSection || button.dataset.settingsGo,
      ),
    ),
  );
  function leaveSettings(libraryRoot = false) {
    if (keys.valueProtected()) return;
    if (state.mfaManagementBusy) return;
    const destination = { ...route(), settingsSection: null };
    if (libraryRoot)
      Object.assign(destination, {
        filter: "all",
        collection: null,
        tag: "",
        showingTags: false,
        page: 1,
      });
    commitRoute(false, destination);
    history.replaceState(
      { ...history.state, pocketmarkScroll: state.libraryReturnScroll },
      "",
    );
    if (state.deferredLogin) {
      clearSettings();
      showLogin();
    } else restoreRoute();
  }
  document
    .querySelectorAll("[data-settings-back], [data-settings-home]")
    .forEach((button) =>
      lifecycle.listen(button, "click", () => leaveSettings()),
    );
  lifecycle.listen($("settings-button"), "click", () =>
    navigateSettings("overview"),
  );
  document
    .querySelectorAll('#settings-page a[href="/?settings=api-keys"]')
    .forEach((link) =>
      lifecycle.listen(link, "click", (event) => {
        event.preventDefault();
        navigateSettings("api-keys");
      }),
    );
  $("sync-address").value = new URL("/dav/", location.origin).href;
  lifecycle.listen($("sync-copy"), "click", async () => {
    try {
      await navigator.clipboard.writeText($("sync-address").value);
      toast("WebDAV address copied.");
    } catch {
      $("sync-address").focus();
      $("sync-address").select();
      toast("Select and copy the WebDAV address.");
    }
  });
  async function loadSettings() {
    const session = ++state.settingsSession;
    document
      .querySelectorAll("[data-settings-key-count], [data-settings-mfa-status]")
      .forEach((node) => {
        node.textContent = "";
      });
    $("settings-error").textContent = $("account-load-error").textContent = "";
    password.reset();
    await Promise.all([
      security.loadSessions(),
      keys.start(),
      api("/api/account")
        .then((account) => {
          if (session !== state.settingsSession) return;
          document
            .querySelectorAll("[data-settings-mfa-status]")
            .forEach((node) => {
              if (typeof account.mfaEnabled !== "boolean") return;
              node.textContent = account.mfaEnabled ? "Enabled" : "Disabled";
              node.dataset.enabled = String(account.mfaEnabled);
            });
          password.setAccount(account);
        })
        .catch((error) => {
          if (session === state.settingsSession)
            $("settings-error").textContent = $(
              "account-load-error",
            ).textContent = error.message;
        }),
    ]);
  }
  function clearSettings() {
    security.clear();
    state.settingsSession++;
    keys.clear();
    password.reset();
    authenticator.clear();
  }
  lifecycle.listen($("export-button"), "click", () =>
    $("export-dialog").showModal(),
  );

  return {
    renderSettings,
    keyValueProtected: keys.valueProtected,
    clearSettings,
    focusSettings,
    loadSettings,
    navigateSettings,
    leaveSettings,
    setMFAManagementBusy: authenticator.setBusy,
    showIssuedCodes: authenticator.showIssued,
    passwordChangePending: password.isPending,
    allowAccountNavigation: authenticator.allowNavigation,
    syncSettingsNavigation,
    clearMFAManagement: authenticator.clear,
    dispose() {
      state.settingsSession++;
      keys.dispose();
      password.reset();
      authenticator.clear();
      lifecycle.dispose();
    },
  };
}
