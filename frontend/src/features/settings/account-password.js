export function createAccountPassword({
  document,
  lifecycle,
  api,
  state,
  security,
  toast,
}) {
  const get = (id) => document.getElementById(id);
  const dialog = get("account-dialog"),
    form = get("account-form");
  const name = get("account-username"),
    current = get("account-current");
  const password = get("account-password"),
    confirmation = get("account-confirm"),
    save = get("account-save");
  const length = new TextEncoder();
  const triggers = [
    ...document.querySelectorAll("[data-edit-password],#account-edit-username"),
  ];
  let account,
    editingName = false,
    busy = false,
    revision = 0;

  function setAccount(value) {
    account = value;
    get("account-username-value").textContent =
      value?.username || "Unavailable";
    for (const button of triggers) button.disabled = !value;
    for (const node of document.querySelectorAll(
      "[data-account-password-mask]",
    )) {
      node.textContent = value
        ? value.passwordEnabled
          ? "••••••••••••"
          : "Not configured"
        : "Unavailable";
    }
    for (const node of document.querySelectorAll(
      "[data-account-password-status]",
    )) {
      node.textContent = value
        ? value.passwordEnabled
          ? "Password set"
          : "Password not configured"
        : "Password status unavailable";
    }
  }
  function update() {
    const next = password.value,
      match = next === confirmation.value;
    const bytes = length.encode(next).length;
    const enough = bytes >= 12;
    const overflow = bytes > 1024;
    const mismatch = !editingName && Boolean(confirmation.value) && !match;
    const criteria = [enough, /\p{Lu}/u.test(next), /[\p{P}\p{S}]/u.test(next)];
    const count = criteria.filter(Boolean).length;
    get("account-checks")
      .querySelectorAll("li")
      .forEach((li, i) => {
        li.classList.toggle("met", criteria[i]);
        li.querySelector("[data-check-state]").textContent = criteria[i]
          ? "Met. "
          : "Unmet. ";
      });
    get("account-checks")
      .querySelectorAll("i")
      .forEach((bar, i) => bar.classList.toggle("filled", i < count));
    password.setAttribute("aria-invalid", String(overflow));
    confirmation.setAttribute("aria-invalid", String(mismatch));
    get("account-match-error").hidden = !mismatch;
    get("account-length-error").hidden = !overflow;
    const chosenName = name.value.trim();
    const invalidName = !chosenName || length.encode(chosenName).length > 120;
    name.setCustomValidity(
      invalidName && editingName ? "Use a username of 1–120 bytes." : "",
    );
    save.disabled =
      busy ||
      !enough ||
      overflow ||
      (editingName
        ? !chosenName || chosenName === account?.username
        : !current.value || !confirmation.value || !match);
  }
  function clear() {
    revision++;
    busy = false;
    dialog.removeAttribute("aria-busy");
    form.reset();
    for (const control of dialog.querySelectorAll("button,input"))
      control.disabled = false;
    for (const button of dialog.querySelectorAll(
      "[data-password-visibility]",
    )) {
      get(button.getAttribute("aria-controls")).type = "password";
      button.setAttribute("aria-pressed", "false");
    }
    get("account-form-error").textContent = "";
    update();
  }
  function close() {
    if (busy) return;
    clear();
    dialog.close();
  }
  for (const button of triggers)
    lifecycle.listen(button, "click", () => {
      if (!account || busy || dialog.open) return;
      clear();
      editingName = button.id === "account-edit-username";
      get("account-dialog-title").textContent = editingName
        ? "Edit username"
        : "Change password";
      save.textContent = editingName
        ? "Save sign-in details"
        : "Change password";
      name.required = editingName;
      name.value = account.username;
      name.disabled = !editingName;
      current.disabled = confirmation.disabled = editingName;
      get("account-name-field").hidden = !editingName;
      get("account-current-field").hidden = get(
        "account-confirm-field",
      ).hidden = editingName;
      get("account-checks").hidden = editingName;
      get("account-impact").textContent = editingName
        ? "Changing your username also updates your password and signs out your other browsers. Use a new password with at least 12 bytes."
        : "Changing your password signs out your other browsers.";
      update();
      dialog.showModal();
      (editingName ? name : current).focus();
    });
  lifecycle.listen(form, "input", update);
  for (const button of form.querySelectorAll("[data-password-visibility]"))
    lifecycle.listen(button, "click", () => {
      const input = get(button.getAttribute("aria-controls"));
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      button.setAttribute("aria-pressed", String(show));
    });
  for (const id of ["account-dialog-close", "account-cancel"])
    lifecycle.listen(get(id), "click", close);
  lifecycle.listen(dialog, "cancel", (e) => {
    if (busy) e.preventDefault();
  });
  lifecycle.listen(dialog, "close", () => {
    if (!dialog.open) clear();
  });
  lifecycle.listen(form, "submit", async (event) => {
    event.preventDefault();
    update();
    if (!account || save.disabled || !form.reportValidity()) return;
    const run = ++revision,
      session = state.settingsSession;
    const username = editingName ? name.value.trim() : account.username;
    const newPassword = password.value;
    busy = true;
    dialog.setAttribute("aria-busy", "true");
    const fields = [
      ...dialog.querySelectorAll("button:not(:disabled),input:not(:disabled)"),
    ];
    for (const element of fields) element.disabled = true;
    get("account-form-error").textContent = "";
    try {
      if (!editingName)
        await api("/api/reauth", {
          method: "POST",
          body: JSON.stringify({ password: current.value }),
        });
      if (run !== revision || session !== state.settingsSession || !dialog.open)
        return;
      await api("/api/account", {
        method: "PUT",
        body: JSON.stringify({ username, password: newPassword }),
      });
      if (run !== revision || session !== state.settingsSession) return;
      setAccount({ ...account, username, passwordEnabled: true });
      busy = false;
      close();
      toast(
        editingName
          ? "Sign-in details updated. Other browsers were signed out."
          : "Password changed. Other browsers were signed out.",
      );
      void security.loadSessions();
    } catch (error) {
      if (run === revision && dialog.open)
        get("account-form-error").textContent = error.message;
    } finally {
      if (run === revision) {
        busy = false;
        dialog.removeAttribute("aria-busy");
        for (const element of fields) element.disabled = false;
        update();
      }
    }
  });
  return {
    setAccount,
    isPending: () => busy,
    reset() {
      if (dialog.open) dialog.close();
      clear();
      setAccount(null);
    },
  };
}
