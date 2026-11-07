import { renderTokenList, renderTokenStatus } from "./tokens.jsx";
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
  const profileHelp = {
    read: "Can read and export library data, including saved files. Cannot change it.",
    capture:
      "For the browser extension: read bookmark metadata, add or edit bookmarks, create collections and upload captures. Cannot delete, bulk edit, import, export or download saved files.",
    sync: "WebDAV only. Floccus can read and replace the bookmark tree, including deletions. Cannot access the native library API or saved files.",
    full: "Can read, export, change and delete library data, including WebDAV sync. Cannot manage your account, keys, sessions or full backups.",
  };
  lifecycle.listen($("token-profile"), "change", () => {
    $("token-permissions-help").textContent =
      profileHelp[$("token-profile").value];
  });
  let tokenCount = 0;
  let tokensBusy = false;
  let editingTokenID = null;
  function setTokensBusy(busy) {
    tokensBusy = busy;
    $("token-form").querySelector("button[type='submit']").disabled =
      busy || editingTokenID !== null || tokenCount >= 32;
    updateTokenView();
  }
  function setTokenVisibility(visible) {
    $("new-token-value").type = visible ? "text" : "password";
    $("toggle-token").textContent = visible ? "Hide key" : "Show key";
    $("toggle-token").setAttribute(
      "aria-label",
      visible ? "Hide API key" : "Show API key",
    );
  }
  function clearNewToken() {
    $("new-token-value").value = "";
    $("new-token").hidden = true;
    setTokenVisibility(false);
  }
  async function loadTokens(session = state.settingsSession) {
    const tokens = await api("/api/tokens");
    if (session !== state.settingsSession) return;
    renderTokens(tokens, session);
  }
  function showTokenError(message) {
    const error = $("tokens-error");
    error.textContent = message;
    error.tabIndex = -1;
    error.focus();
  }
  function tokenLoadError(error, session) {
    if (session !== state.settingsSession) return;
    showTokenError(error.message);
    tokenSnapshot = null;
    renderTokenStatus($("token-list"), "Retry loading keys", async () => {
      $("tokens-error").textContent = "";
      try {
        await loadTokens(session);
      } catch (failure) {
        tokenLoadError(failure, session);
      }
    });
  }
  let tokenSnapshot = null,
    tokenEpoch = 0;
  function updateTokenView() {
    if (!tokenSnapshot) return;
    const { tokens, session } = tokenSnapshot;
    renderTokenList($("token-list"), {
      ...tokenSnapshot,
      busy: tokensBusy,
      isCurrent: () => session === state.settingsSession,
      onEditing: (id) => {
        editingTokenID = id;
        $("tokens-error").textContent = "";
        $("tokens-feedback").textContent = "";
        $("token-form").querySelector("button[type='submit']").disabled =
          tokensBusy || id !== null || tokenCount >= 32;
      },
      onRefresh: (next, id, action) => renderTokens(next, session, id, action),
      onRename: async (token, name) => {
        if (tokensBusy || session !== state.settingsSession) return;
        setTokensBusy(true);
        try {
          await api(`/api/tokens/${token.id}`, {
            method: "PATCH",
            body: JSON.stringify({ name }),
          });
          if (session !== state.settingsSession) return;
          editingTokenID = null;
          tokensBusy = false;
          renderTokens(
            tokens.map((item) =>
              item.id === token.id ? { ...item, name } : item,
            ),
            session,
            token.id,
            "rename",
          );
          $("tokens-feedback").textContent = `Key renamed to “${name}”.`;
        } finally {
          if (session === state.settingsSession) setTokensBusy(false);
        }
      },
      onChange: async (token, remove) => {
        if (tokensBusy || editingTokenID !== null) return;
        if (
          remove &&
          (!(await confirmAction(
            "Delete API key?",
            `Delete API key “${token.name}” permanently? Apps using it will lose access. This cannot be undone. To pause access, cancel and disable the key instead.`,
            "Delete API key",
          )) ||
            session !== state.settingsSession ||
            tokensBusy ||
            editingTokenID !== null)
        )
          return;
        $("tokens-error").textContent = "";
        $("tokens-feedback").textContent = "";
        setTokensBusy(true);
        const active = !token.active;
        try {
          await api(
            `/api/tokens/${token.id}`,
            remove
              ? { method: "DELETE" }
              : { method: "PATCH", body: JSON.stringify({ active }) },
          );
          if (session !== state.settingsSession) return;
          const next = remove
            ? tokens.filter((item) => item.id !== token.id)
            : tokens.map((item) =>
                item.id === token.id ? { ...item, active } : item,
              );
          tokensBusy = false;
          renderTokens(next, session, remove ? next[0]?.id : token.id);
          if (remove && !next.length)
            $("token-create").querySelector("summary").focus();
          $("tokens-feedback").textContent =
            `“${token.name}” ${remove ? "deleted permanently" : active ? "reactivated" : "disabled. Apps using this key can no longer connect"}.`;
        } catch (error) {
          if (session === state.settingsSession) showTokenError(error.message);
        } finally {
          if (session === state.settingsSession) setTokensBusy(false);
        }
      },
      onRotate: async (token) => {
        if (
          tokensBusy ||
          editingTokenID !== null ||
          !(await confirmAction(
            "Replace API key?",
            `Replace the key for “${token.name}”? The old key will stop working immediately. Update the connected app with the new key.`,
            "Replace key",
          )) ||
          session !== state.settingsSession ||
          tokensBusy
        )
          return;
        setTokensBusy(true);
        try {
          const result = await api(`/api/tokens/${token.id}/rotate`, {
            method: "POST",
          });
          if (session !== state.settingsSession) return;
          setTokenVisibility(false);
          $("new-token-value").value = result.token;
          $("new-token").hidden = false;
          $("new-token-value").focus();
          $("tokens-feedback").textContent =
            "Key replaced. Copy the new key into your app; its permissions and expiry are unchanged.";
          await loadTokens(session);
        } catch (error) {
          if (session === state.settingsSession) showTokenError(error.message);
        } finally {
          if (session === state.settingsSession) setTokensBusy(false);
        }
      },
    });
  }
  function renderTokens(tokens, session, focusID, focusAction = "toggle") {
    const rows = [...$("token-list").querySelectorAll(".token-accordion")];
    tokenCount = tokens.length;
    const usable = (token) =>
      token.active &&
      !(token.expiresAt > 0 && token.expiresAt * 1000 <= Date.now());
    $("token-count").textContent =
      `${tokens.filter(usable).length} active · ${tokens.length} of 32 keys`;
    tokenSnapshot = {
      tokens,
      session,
      focusID,
      focusAction,
      openIDs: new Set(
        rows.filter((row) => row.open).map((row) => row.dataset.tokenId),
      ),
      initial: rows.length === 0,
      epoch: ++tokenEpoch,
    };
    setTokensBusy(tokensBusy);
  }
  function syncSettingsNavigation() {
    document.querySelectorAll("[data-settings-section]").forEach((button) => {
      button.disabled =
        (state.mfaManagementBusy || state.deferredLogin) &&
        button.dataset.settingsSection !== state.settingsSection;
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
    const entering = active && $("settings-page").hidden;
    $("settings-page").hidden = !active;
    $("library-content").hidden = active;
    $("library-navigation").hidden = active;
    $("settings-navigation").hidden = !active;
    $("app-view").classList.toggle("showing-settings", active);
    renderBreadcrumb();
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
    const heading = document.querySelector(
      `[data-settings-panel="${state.settingsSection}"] h2`,
    );
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
    revealSettingsSection();
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  function navigateSettings(section) {
    if (state.mfaManagementBusy || state.deferredLogin) return;
    if (!state.settingsSection) state.libraryReturnScroll = window.scrollY;
    commitRoute(false, { ...route(), settingsSection: section });
    history.replaceState(
      { ...history.state, pocketmarkLibraryScroll: state.libraryReturnScroll },
      "",
    );
    restoreRoute();
  }
  document
    .querySelectorAll("[data-settings-section]")
    .forEach((button) =>
      lifecycle.listen(button, "click", () =>
        navigateSettings(button.dataset.settingsSection),
      ),
    );
  function leaveSettings(libraryRoot = false) {
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
    navigateSettings("api-keys"),
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
    $("settings-error").textContent = "";
    $("tokens-error").textContent = "";
    $("tokens-feedback").textContent = "";
    tokensBusy = false;
    tokenCount = 0;
    editingTokenID = null;
    $("token-count").textContent = "";
    $("token-form").querySelector("button[type='submit']").disabled = true;
    tokenSnapshot = null;
    renderTokenStatus($("token-list"), "Loading API keys…");
    clearNewToken();
    $("account-password").value = "";
    await Promise.all([
      security.loadSessions(),
      loadTokens(session).catch((error) => tokenLoadError(error, session)),
      api("/api/account")
        .then((account) => {
          if (session !== state.settingsSession) return;
          $("account-username").value = account.username || "";
          $("account-status").textContent = account.passwordEnabled
            ? "Password sign-in is enabled."
            : "Password sign-in is not configured.";
        })
        .catch((error) => {
          if (session === state.settingsSession)
            $("settings-error").textContent = error.message;
        }),
    ]);
  }
  lifecycle.listen($("account-form"), "submit", async (event) => {
    event.preventDefault();
    event.submitter.disabled = true;
    $("settings-error").textContent = "";
    try {
      await api("/api/account", {
        method: "PUT",
        body: JSON.stringify({
          username: $("account-username").value.trim(),
          password: $("account-password").value,
        }),
      });
      $("account-password").value = "";
      $("account-status").textContent = "Password sign-in is enabled.";
      toast("Password updated.");
    } catch (error) {
      $("settings-error").textContent = error.message;
    } finally {
      event.submitter.disabled = false;
    }
  });
  function clearMFAManagement() {
    $("mfa-manage-form").reset();
    $("mfa-manage-verify").reset();
    $("mfa-manage-form").hidden = false;
    $("mfa-manage-enrollment").hidden = $("mfa-manage-codes").hidden = true;
    $("mfa-manage-secret").value = "";
    $("mfa-manage-qr").removeAttribute("src");
    $("mfa-manage-codes-value").textContent = "";
    $("mfa-manage-feedback").textContent = $("mfa-manage-error").textContent =
      "";
  }
  function setMFAManagementBusy(busy) {
    state.mfaManagementBusy = busy;
    syncSettingsNavigation();
    $("mfa-manage-cancel").disabled = busy;
    document.querySelectorAll("[data-settings-panel]").forEach((section) => {
      if (section.getAttribute("aria-labelledby") !== "mfa-settings-title")
        section.inert = busy || state.deferredLogin;
    });
    document
      .querySelectorAll(
        "#mfa-manage-form button[type='submit'], #mfa-manage-verify button[type='submit']",
      )
      .forEach((button) => {
        button.disabled = busy || state.deferredLogin;
      });
    if (busy)
      $("mfa-manage-feedback").textContent =
        "Updating authentication. Keep settings open until this finishes.";
    else if (
      $("mfa-manage-feedback").textContent ===
      "Updating authentication. Keep settings open until this finishes."
    )
      $("mfa-manage-feedback").textContent = "";
    if (!busy && state.deferredLogin) showLogin();
  }
  function showManagedCodes(codes) {
    $("mfa-manage-codes-value").textContent = codes.join("\n");
    $("mfa-manage-codes").hidden = false;
    $("mfa-manage-codes-value").focus();
  }
  function normalizeRecoveryCode(code) {
    return code.trim().replaceAll("-", "").toUpperCase();
  }
  function removeManagedRecoveryCode(proof) {
    if ($("mfa-manage-codes").hidden) return false;
    const codes = $("mfa-manage-codes-value").textContent.split("\n");
    const remaining = codes.filter(
      (code) => normalizeRecoveryCode(code) !== normalizeRecoveryCode(proof),
    );
    if (remaining.length === codes.length) return false;
    $("mfa-manage-codes-value").textContent = remaining.join("\n");
    $("mfa-manage-codes").hidden = remaining.length === 0;
    return true;
  }
  function mfaOutcomeUncertain(error) {
    if (error.status === 401 && error.message === "invalid authentication code")
      return false;
    return (
      !error.status ||
      error.status === 401 ||
      error.status === 408 ||
      error.status === 409 ||
      error.status >= 500
    );
  }
  function mfaManagementFailure(error) {
    if (!mfaOutcomeUncertain(error)) return error.message;
    return "Could not confirm the result. The change may have completed. Use your authenticator to generate recovery codes, or reset MFA locally if needed.";
  }
  lifecycle.listen($("mfa-manage-form"), "submit", async (event) => {
    event.preventDefault();
    const session = state.settingsSession;
    const button = event.submitter;
    if (state.mfaManagementBusy) return;
    const previousCodes = $("mfa-manage-codes-value").textContent;
    const previousCodesVisible = !$("mfa-manage-codes").hidden;
    const proof = $("mfa-manage-code").value.trim();
    $("mfa-manage-error").textContent = $("mfa-manage-feedback").textContent =
      "";
    if (button.value === "codes") {
      $("mfa-manage-codes").hidden = true;
      $("mfa-manage-codes-value").textContent = "";
    }
    setMFAManagementBusy(true);
    try {
      const replace = button.value === "replace";
      const result = await api(
        replace ? "/api/mfa/replace" : "/api/mfa/recovery-codes",
        {
          method: "POST",
          body: JSON.stringify({
            password: $("mfa-manage-password").value,
            code: proof,
          }),
        },
      );
      if (session !== state.settingsSession) return;
      $("mfa-manage-password").value = $("mfa-manage-code").value = "";
      if (replace) {
        if (removeManagedRecoveryCode(proof))
          $("mfa-manage-feedback").textContent =
            "The recovery code used for this change was removed from the list.";
        $("mfa-manage-form").hidden = true;
        $("mfa-manage-enrollment").hidden = false;
        $("mfa-manage-secret").value = result.secret;
        $("mfa-manage-qr").src = result.qr;
        $("mfa-manage-new-code").focus();
      } else {
        state.deferredLoginNotice = "";
        showManagedCodes(result.recoveryCodes);
      }
    } catch (error) {
      if (session === state.settingsSession) {
        if (
          button.value === "codes" &&
          previousCodesVisible &&
          !mfaOutcomeUncertain(error)
        )
          showManagedCodes(previousCodes.split("\n"));
        let proofNotice = "";
        if (/^[0-9A-F]{32}$/.test(normalizeRecoveryCode(proof))) {
          const rejected =
            error.status === 403 &&
            error.message === "invalid or already used authentication code";
          if (
            rejected ||
            (button.value === "replace" &&
              error.status !== 400 &&
              error.status !== 403)
          ) {
            const removed = removeManagedRecoveryCode(proof);
            proofNotice = rejected
              ? `The recovery code entered is invalid or has already been used.${removed ? " It was removed from the list." : ""}`
              : `The recovery code entered may have been used.${removed ? " It was removed from the list." : " Try a different code or your authenticator."}`;
            $("mfa-manage-feedback").textContent = proofNotice;
          }
        }
        $("mfa-manage-error").textContent = mfaManagementFailure(error);
        if (mfaOutcomeUncertain(error) || proofNotice) {
          state.deferredLoginNotice = [
            mfaOutcomeUncertain(error) ? mfaManagementFailure(error) : "",
            proofNotice,
          ]
            .filter(Boolean)
            .join(" ");
        }
      }
    } finally {
      setMFAManagementBusy(false);
    }
  });
  lifecycle.listen($("mfa-manage-verify"), "submit", async (event) => {
    event.preventDefault();
    const session = state.settingsSession;
    if (state.mfaManagementBusy) return;
    const previousCodes = $("mfa-manage-codes-value").textContent;
    const previousCodesVisible = !$("mfa-manage-codes").hidden;
    $("mfa-manage-codes").hidden = true;
    $("mfa-manage-codes-value").textContent = "";
    $("mfa-manage-error").textContent = "";
    setMFAManagementBusy(true);
    try {
      const result = await api("/api/mfa/verify", {
        method: "POST",
        body: JSON.stringify({ code: $("mfa-manage-new-code").value.trim() }),
      });
      if (session !== state.settingsSession) return;
      $("mfa-manage-new-code").value = $("mfa-manage-secret").value = "";
      $("mfa-manage-qr").removeAttribute("src");
      $("mfa-manage-enrollment").hidden = true;
      $("mfa-manage-form").hidden = false;
      $("mfa-manage-feedback").textContent =
        "Authenticator replaced. Other browsers have been signed out.";
      state.deferredLoginNotice = "";
      showManagedCodes(result.recoveryCodes);
      void security.loadSessions();
    } catch (error) {
      if (session === state.settingsSession) {
        if (previousCodesVisible && !mfaOutcomeUncertain(error))
          showManagedCodes(previousCodes.split("\n"));
        $("mfa-manage-error").textContent = mfaManagementFailure(error);
        if (mfaOutcomeUncertain(error))
          state.deferredLoginNotice = mfaManagementFailure(error);
      }
    } finally {
      setMFAManagementBusy(false);
    }
  });
  lifecycle.listen($("mfa-manage-cancel"), "click", () => {
    if (state.mfaManagementBusy) return;
    $("mfa-manage-verify").reset();
    $("mfa-manage-secret").value = "";
    $("mfa-manage-qr").removeAttribute("src");
    $("mfa-manage-enrollment").hidden = true;
    $("mfa-manage-form").hidden = false;
    $("mfa-manage-error").textContent = "";
    $("mfa-manage-password").focus();
  });
  lifecycle.listen($("mfa-manage-download"), "click", () =>
    downloadRecoveryCodes($("mfa-manage-codes-value")),
  );
  lifecycle.listen($("mfa-manage-secret-copy"), "click", async () => {
    $("mfa-manage-error").textContent = $("mfa-manage-feedback").textContent =
      "";
    try {
      await navigator.clipboard.writeText($("mfa-manage-secret").value);
      $("mfa-manage-feedback").textContent = "Setup key copied.";
    } catch {
      $("mfa-manage-secret").select();
      $("mfa-manage-error").textContent =
        "Select and copy the setup key shown above.";
    }
  });
  lifecycle.listen($("mfa-manage-copy"), "click", async () => {
    try {
      await navigator.clipboard.writeText(
        $("mfa-manage-codes-value").textContent,
      );
      $("mfa-manage-feedback").textContent = "Recovery codes copied.";
    } catch {
      $("mfa-manage-error").textContent =
        "Select and copy the recovery codes shown above.";
    }
  });
  lifecycle.listen($("token-form"), "submit", async (event) => {
    const session = state.settingsSession;
    event.preventDefault();
    if (tokensBusy || editingTokenID !== null || tokenCount >= 32) return;
    setTokensBusy(true);
    $("tokens-error").textContent = "";
    $("tokens-feedback").textContent = "";
    try {
      const token = await api("/api/tokens", {
        method: "POST",
        body: JSON.stringify({
          name: $("token-name").value.trim(),
          profile: $("token-profile").value,
          expiresAt: Number($("token-expiry").value)
            ? Math.floor(Date.now() / 1000) +
              Number($("token-expiry").value) * 86400
            : 0,
        }),
      });
      if (session !== state.settingsSession) return;
      setTokenVisibility(false);
      $("new-token-value").value = token.token;
      $("new-token").hidden = false;
      $("token-name").value = "";
      $("token-create").open = false;
      $("new-token-value").focus();
      await loadTokens(session);
    } catch (error) {
      if (session === state.settingsSession) showTokenError(error.message);
    } finally {
      if (session === state.settingsSession) setTokensBusy(false);
    }
  });
  lifecycle.listen($("toggle-token"), "click", () =>
    setTokenVisibility($("new-token-value").type === "password"),
  );
  lifecycle.listen($("copy-token"), "click", async () => {
    try {
      await navigator.clipboard.writeText($("new-token-value").value);
      toast("Key copied.");
    } catch {
      setTokenVisibility(true);
      $("new-token-value").select();
      toast("Select and copy the key.");
    }
  });
  function clearSettings() {
    security.clear();
    state.settingsSession++;
    editingTokenID = null;
    $("account-password").value = "";
    clearNewToken();
    clearMFAManagement();
  }
  lifecycle.listen($("export-button"), "click", () =>
    $("export-dialog").showModal(),
  );

  return {
    renderSettings,
    clearSettings,
    focusSettings,
    loadSettings,
    navigateSettings,
    leaveSettings,
    setMFAManagementBusy,
    syncSettingsNavigation,
    clearMFAManagement,
    dispose() {
      state.settingsSession++;
      lifecycle.dispose();
    },
  };
}
