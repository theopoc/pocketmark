export function createAuthenticator({
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
}) {
  const $ = (id) => document.getElementById(id);
  const dialog = $("mfa-manage-dialog");
  let view = "";
  function setView(next) {
    view = next;
    const proof = next === "replace" || next === "codes";
    $("mfa-manage-form").hidden = !proof;
    $("mfa-manage-enrollment").hidden = next !== "enroll";
    $("mfa-codes-view").hidden = next !== "issued";
    $("mfa-method-hint").hidden = $("mfa-grant-hint").hidden =
      next !== "replace";
    $("mfa-codes-warning").hidden = next !== "codes";
    $("mfa-manage-code").required = next === "codes";
    $("mfa-manage-form").querySelector('[value="replace"]').hidden =
      next !== "replace";
    $("mfa-manage-form").querySelector('[value="codes"]').hidden =
      next !== "codes";
    $("mfa-dialog-title").textContent =
      {
        replace: "Change verification method",
        codes: "Regenerate recovery codes",
        enroll: "Connect your authenticator",
        issued: "Save your recovery codes",
      }[next] || "";
  }
  function showIssued() {
    if ($("mfa-manage-codes").hidden || !state.settingsSection) return;
    clearProof();
    setView("issued");
    if (!dialog.open) dialog.showModal();
    $("mfa-codes-back").hidden = state.deferredLogin;
    $("mfa-manage-codes-value").focus();
  }
  function clearProof() {
    $("mfa-manage-form").reset();
    $("mfa-manage-verify").reset();
    $("mfa-manage-secret").value = "";
    $("mfa-manage-qr").removeAttribute("src");
  }
  function clearCodes() {
    $("mfa-codes-view-start").hidden = $("mfa-manage-codes").hidden = true;
    $("mfa-manage-codes-value").textContent = "";
  }
  function clearMFAManagement() {
    if (dialog.open) dialog.close();
    setView("");
    clearProof();
    clearCodes();
    $("mfa-codes-description").textContent =
      "Use a one-time code if you lose access to your authenticator.";
    $("mfa-manage-error").textContent = $("mfa-manage-feedback").textContent =
      "";
  }
  function closeView() {
    clearProof();
    setView("");
    if (dialog.open) dialog.close();
  }
  function acceptCodes() {
    clearCodes();
    closeView();
    if (state.deferredLogin) showLogin();
  }
  async function allowNavigation(leavingSettings = false) {
    if (state.mfaManagementBusy) return false;
    const current = view,
      visit = state.settingsSession;
    const enrollment = dialog.open && current === "enroll";
    const codes =
      !$("mfa-manage-codes").hidden &&
      (leavingSettings || (dialog.open && current === "issued"));
    if (!enrollment && !codes) return true;
    if (
      !(await confirmAction(
        codes ? "Have you saved your codes?" : "Discard this setup?",
        codes
          ? "Save a copy before continuing. These recovery codes will be cleared." +
              (enrollment
                ? " Your pending authenticator setup will also be discarded."
                : "")
          : "Your current authenticator will continue to work.",
        codes ? "I saved my codes" : "Discard setup",
      ))
    )
      return false;
    if (
      visit !== state.settingsSession ||
      view !== current ||
      state.mfaManagementBusy
    )
      return false;
    if (codes) acceptCodes();
    else closeView();
    return true;
  }
  async function requestClose() {
    if ((await allowNavigation()) && dialog.open) closeView();
  }
  function openProof(kind) {
    if (state.mfaManagementBusy || state.deferredLogin) return;
    clearProof();
    $("mfa-manage-error").textContent = $("mfa-manage-feedback").textContent =
      "";
    setView(kind);
    dialog.showModal();
    $("mfa-manage-password").focus();
  }
  lifecycle.listen($("mfa-manage-start"), "click", () => openProof("replace"));
  lifecycle.listen($("mfa-codes-start"), "click", () => openProof("codes"));
  lifecycle.listen($("mfa-codes-view-start"), "click", showIssued);
  lifecycle.listen($("mfa-codes-back"), "click", () => {
    if (!state.deferredLogin) closeView();
  });
  lifecycle.listen($("mfa-codes-done"), "click", acceptCodes);
  for (const id of [
    "mfa-dialog-close",
    "mfa-proof-cancel",
    "mfa-manage-cancel",
  ])
    lifecycle.listen($(id), "click", requestClose);
  lifecycle.listen(dialog, "cancel", (event) => {
    event.preventDefault();
    void requestClose();
  });
  lifecycle.listen(dialog, "close", () => {
    if (!dialog.open) {
      clearProof();
      setView("");
    }
  });
  function setMFAManagementBusy(busy) {
    state.mfaManagementBusy = busy;
    syncSettingsNavigation();
    for (const id of [
      "mfa-manage-cancel",
      "mfa-proof-cancel",
      "mfa-dialog-close",
    ])
      $(id).disabled = busy;
    for (const id of [
      "mfa-manage-password",
      "mfa-manage-code",
      "mfa-manage-new-code",
    ])
      $(id).readOnly = busy;
    dialog.setAttribute("aria-busy", String(busy));
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
  function showManagedCodes(codes, reveal = true) {
    $("mfa-manage-codes-value").textContent = codes.join("\n");
    $("mfa-manage-codes").hidden = false;
    $("mfa-codes-view-start").hidden = false;
    if (reveal) {
      const when = new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date());
      $("mfa-codes-description").textContent = "Last generated " + when + ".";
      showIssued();
    }
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
    $("mfa-codes-view-start").hidden = $("mfa-manage-codes").hidden =
      remaining.length === 0;
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
    const replace = view === "replace";
    if (state.mfaManagementBusy || state.deferredLogin) return;
    const previousCodes = $("mfa-manage-codes-value").textContent;
    const previousCodesVisible = !$("mfa-manage-codes").hidden;
    const proof = $("mfa-manage-code").value.trim();
    $("mfa-manage-error").textContent = $("mfa-manage-feedback").textContent =
      "";
    if (!replace) {
      $("mfa-codes-view-start").hidden = $("mfa-manage-codes").hidden = true;
      $("mfa-manage-codes-value").textContent = "";
    }
    setMFAManagementBusy(true);
    try {
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
        setView("enroll");
        $("mfa-manage-secret").value = result.secret;
        $("mfa-manage-qr").src = result.qr;
        $("mfa-manage-new-code").focus();
      } else {
        state.deferredLoginNotice = "";
        showManagedCodes(result.recoveryCodes);
      }
    } catch (error) {
      if (session === state.settingsSession) {
        if (!replace && previousCodesVisible && !mfaOutcomeUncertain(error))
          showManagedCodes(previousCodes.split("\n"), false);
        let proofNotice = "";
        if (/^[0-9A-F]{32}$/.test(normalizeRecoveryCode(proof))) {
          const rejected =
            error.status === 403 &&
            error.message === "invalid or already used authentication code";
          if (
            rejected ||
            (replace && error.status !== 400 && error.status !== 403)
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
    if (state.mfaManagementBusy || state.deferredLogin) return;
    const previousCodes = $("mfa-manage-codes-value").textContent;
    const previousCodesVisible = !$("mfa-manage-codes").hidden;
    $("mfa-codes-view-start").hidden = $("mfa-manage-codes").hidden = true;
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

      $("mfa-manage-feedback").textContent =
        "Authenticator replaced. Other browsers have been signed out.";
      state.deferredLoginNotice = "";
      showManagedCodes(result.recoveryCodes);
      void security.loadSessions();
    } catch (error) {
      if (session === state.settingsSession) {
        if (previousCodesVisible && !mfaOutcomeUncertain(error))
          showManagedCodes(previousCodes.split("\n"), false);
        $("mfa-manage-error").textContent = mfaManagementFailure(error);
        if (mfaOutcomeUncertain(error))
          state.deferredLoginNotice = mfaManagementFailure(error);
      }
    } finally {
      setMFAManagementBusy(false);
    }
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
      const codes = $("mfa-manage-codes-value");
      const range = document.createRange();
      range.selectNodeContents(codes);
      codes.focus();
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      $("mfa-manage-error").textContent =
        "Recovery codes selected. Use your copy shortcut.";
    }
  });
  return {
    clear: clearMFAManagement,
    setBusy: setMFAManagementBusy,
    showIssued,
    allowNavigation,
  };
}
