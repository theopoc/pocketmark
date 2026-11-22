import PocketmarkSelect from "../../../internal/webui/static/select.js";
import { createLifecycle } from "../lib/lifecycle.js";
("use strict");
const security = {
  create(
    { api, toast, confirmAction, signOutCurrent, renderSessions },
    browser = globalThis,
  ) {
    const lifecycle = createLifecycle(browser);
    const { document } = browser;
    const window = browser;
    const $ = (id) => document.getElementById(id);
    const dialog = $("reauth-dialog");
    const timeoutDialog = $("session-idle-dialog");
    const timeoutSelect = $("session-idle");
    let savedTimeout = null,
      savingTimeout = false,
      timeoutRevision = 0;
    let pending,
      resolveConfirmation,
      rejectConfirmation,
      confirmed = false,
      submitting = false,
      view = 0,
      generation = 0;
    function confirmPassword() {
      if (pending) return pending;
      confirmed = false;
      $("reauth-form").reset();
      $("reauth-error").textContent = "";
      pending = new Promise((resolve, reject) => {
        resolveConfirmation = resolve;
        rejectConfirmation = reject;
      });
      dialog.showModal();
      $("reauth-password").focus();
      return pending;
    }
    lifecycle.listen(dialog, "close", () => {
      $("reauth-password").value = "";
      if (confirmed) resolveConfirmation?.();
      else
        rejectConfirmation?.(
          new Error("Password confirmation cancelled. No action was taken."),
        );
      pending = resolveConfirmation = rejectConfirmation = null;
    });
    lifecycle.listen(dialog, "cancel", (event) => {
      if (submitting) event.preventDefault();
    });
    lifecycle.listen($("reauth-cancel"), "click", () => {
      if (!submitting) dialog.close();
    });
    lifecycle.listen($("reauth-form"), "submit", async (event) => {
      event.preventDefault();
      if (submitting) return;
      submitting = true;
      $("reauth-submit").disabled = $("reauth-cancel").disabled = true;
      $("reauth-error").textContent = "";
      try {
        await api("/api/reauth", {
          method: "POST",
          body: JSON.stringify({ password: $("reauth-password").value }),
        });
        confirmed = true;
        dialog.close();
      } catch (error) {
        $("reauth-error").textContent = error.message;
        $("reauth-password").select();
      } finally {
        submitting = false;
        $("reauth-submit").disabled = $("reauth-cancel").disabled = false;
      }
    });
    function updateCount(count) {
      document
        .querySelectorAll("[data-settings-session-count]")
        .forEach((node) => {
          node.textContent = count == null ? "" : count + " signed in";
        });
    }
    function clearSessionMessages() {
      $("sessions-error").textContent = $("sessions-feedback").textContent = "";
    }
    async function sessionAction(session, title, button) {
      const visit = view;
      const target =
        title + (session.ipAddress ? " (" + session.ipAddress + ")" : "");
      if (session.current) {
        signOutCurrent(target, button);
        return;
      }
      const accepted = await confirmAction(
        "Sign out this session?",
        target + " will need to sign in again.",
        "Sign out",
      );
      if (!accepted || visit !== view) return;
      clearSessionMessages();
      button.disabled = true;
      try {
        await api("/api/sessions/" + session.id, { method: "DELETE" });
        if (visit === view) {
          $("sessions-refresh").focus();
          await loadSessions(
            "Session revoked. That browser must sign in again.",
          );
        }
      } catch (error) {
        if (visit === view) {
          $("sessions-error").textContent = error.message;
          button.disabled = false;
        }
      }
    }
    async function loadSessions(notice = "") {
      const attempt = ++generation;
      const timeoutAtStart = timeoutRevision;
      clearSessionMessages();
      updateCount(null);
      $("sessions-others").disabled = true;
      $("session-idle-open").disabled = true;
      const container = $("sessions-list");
      renderSessions(container, [], sessionAction, "Loading sessions…");
      try {
        const sessions = await api("/api/sessions");
        if (attempt !== generation || $("settings-page").hidden) return;
        const current = sessions.find((session) => session.current);
        if (timeoutAtStart === timeoutRevision) {
          savedTimeout = current
            ? String(current.idleTimeoutMinutes ?? 1440)
            : null;
          if (!timeoutDialog.open) syncTimeout();
        }
        $("session-idle-open").disabled = !current;
        $("sessions-others").disabled = !sessions.some(
          (session) => !session.current,
        );
        renderSessions(
          container,
          sessions,
          sessionAction,
          sessions.length ? "" : "No signed-in devices.",
        );
        updateCount(sessions.length);
        if (notice || timeoutAtStart === timeoutRevision)
          $("sessions-feedback").textContent = notice;
      } catch (error) {
        if (attempt === generation) {
          renderSessions(container, [], sessionAction);
          $("sessions-error").textContent =
            error.message + " Use Refresh sessions to retry.";
        }
      }
    }
    lifecycle.listen($("sessions-refresh"), "click", () => loadSessions());
    lifecycle.listen($("sessions-others"), "click", async () => {
      const visit = view;
      if (
        !(await confirmAction(
          "Sign out all other sessions?",
          "All other browsers will need to sign in again.",
          "Sign out other sessions",
        )) ||
        visit !== view
      )
        return;
      clearSessionMessages();
      $("sessions-others").disabled = true;
      try {
        await api("/api/sessions/others", { method: "DELETE" });
        if (visit === view)
          await loadSessions("All other browsers have been signed out.");
      } catch (error) {
        if (visit !== view) return;
        $("sessions-error").textContent = error.message;
        $("sessions-others").disabled = false;
      }
    });
    function syncTimeout() {
      timeoutSelect.value = savedTimeout ?? "";
      PocketmarkSelect.sync(timeoutSelect);
      $("session-idle-value").textContent =
        timeoutSelect.selectedOptions?.[0]?.textContent || "";
    }
    lifecycle.listen($("session-idle-open"), "click", () => {
      if (savedTimeout === null) return;
      syncTimeout();
      $("session-idle-error").textContent = "";
      timeoutDialog.showModal();
      ($("session-idle-trigger") || timeoutSelect).focus();
    });
    lifecycle.listen($("session-idle-cancel"), "click", () => {
      if (!savingTimeout) timeoutDialog.close();
    });
    lifecycle.listen(timeoutDialog, "cancel", (event) => {
      if (savingTimeout) event.preventDefault();
    });
    lifecycle.listen($("session-idle-form"), "submit", async (event) => {
      event.preventDefault();
      if (savingTimeout) return;
      const visit = view,
        value = timeoutSelect.value;
      savingTimeout = true;
      clearSessionMessages();
      $("session-idle-error").textContent = "";
      event.submitter.disabled =
        timeoutSelect.disabled =
        $("session-idle-cancel").disabled =
          true;
      PocketmarkSelect.sync(timeoutSelect);
      try {
        await api("/api/sessions/current", {
          method: "PATCH",
          body: JSON.stringify({ idleTimeoutMinutes: Number(value) }),
        });
        if (visit !== view) return;
        timeoutRevision++;
        savedTimeout = value;
        syncTimeout();
        if (timeoutDialog.open) timeoutDialog.close();
        $("sessions-feedback").textContent =
          "Inactivity timeout saved for this browser.";
      } catch (error) {
        if (visit === view) $("session-idle-error").textContent = error.message;
      } finally {
        savingTimeout = false;
        event.submitter.disabled =
          timeoutSelect.disabled =
          $("session-idle-cancel").disabled =
            false;
        PocketmarkSelect.sync(timeoutSelect);
      }
    });
    lifecycle.listen(document, "click", async (event) => {
      if (!event.target.closest?.('a[href="/api/backup"]')) return;
      event.preventDefault();
      try {
        await confirmPassword();
        window.location.assign("/api/backup");
      } catch (error) {
        toast(error.message, true);
      }
    });
    function closeSessionDialogs() {
      if (timeoutDialog.open) timeoutDialog.close();
      if ($("session-details-dialog").open) $("session-details-dialog").close();
    }
    function clear() {
      view++;
      generation++;
      savedTimeout = null;
      $("session-idle-open").disabled = true;
      $("session-idle-value").textContent = $(
        "session-idle-error",
      ).textContent = "";
      closeSessionDialogs();
      updateCount(null);
      renderSessions($("sessions-list"), [], sessionAction);
      clearSessionMessages();
    }
    return {
      confirm: confirmPassword,
      loadSessions,
      closeSessionDialogs,
      clear,
      dispose() {
        view++;
        generation++;
        lifecycle.dispose();
        pending = resolveConfirmation = rejectConfirmation = null;
      },
    };
  },
};

export default security;
