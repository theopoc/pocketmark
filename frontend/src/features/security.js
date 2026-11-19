import PocketmarkSelect from "../../../internal/webui/static/select.js";
import { createLifecycle } from "../lib/lifecycle.js";
("use strict");
const security = {
  create(
    { api, toast, confirmAction, onSessionExpired, renderSessions },
    browser = globalThis,
  ) {
    const lifecycle = createLifecycle(browser);
    const { document } = browser;
    const window = browser;
    const $ = (id) => document.getElementById(id);
    const dialog = $("reauth-dialog");
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
      $("sessions-count").textContent = count ?? "";
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
      const action = session.current ? "Sign out" : "Revoke session";
      const target =
        title + (session.ipAddress ? " (" + session.ipAddress + ")" : "");
      const accepted = await confirmAction(
        action + "?",
        target + " will need to sign in again.",
        action,
      );
      if (!accepted || visit !== view) return;
      clearSessionMessages();
      button.disabled = true;
      try {
        await api(
          session.current ? "/api/logout" : "/api/sessions/" + session.id,
          {
            method: session.current ? "POST" : "DELETE",
          },
        );
        if (session.current) {
          onSessionExpired();
        } else if (visit === view) {
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
      clearSessionMessages();
      updateCount(null);
      $("sessions-others").disabled = true;
      const container = $("sessions-list");
      renderSessions(container, [], sessionAction, "Loading sessions…");
      try {
        const sessions = await api("/api/sessions");
        if (attempt !== generation || $("settings-page").hidden) return;
        const current = sessions.find((session) => session.current);
        $("session-idle").value = String(current?.idleTimeoutMinutes ?? 1440);
        PocketmarkSelect.sync($("session-idle"));
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
          "Sign out other browsers?",
          "All other browsers will need to sign in again.",
          "Sign out other browsers",
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
    lifecycle.listen($("session-idle-form"), "submit", async (event) => {
      event.preventDefault();
      clearSessionMessages();
      event.submitter.disabled = true;
      try {
        await api("/api/sessions/current", {
          method: "PATCH",
          body: JSON.stringify({
            idleTimeoutMinutes: Number($("session-idle").value),
          }),
        });
        $("sessions-feedback").textContent =
          "Inactivity timeout saved for this browser.";
      } catch (error) {
        $("sessions-error").textContent = error.message;
      } finally {
        event.submitter.disabled = false;
      }
    });
    document.querySelectorAll('a[href="/api/backup"]').forEach((link) =>
      lifecycle.listen(link, "click", async (event) => {
        event.preventDefault();
        try {
          await confirmPassword();
          window.location.assign("/api/backup");
        } catch (error) {
          toast(error.message, true);
        }
      }),
    );
    function clear() {
      view++;
      generation++;
      updateCount(null);
      renderSessions($("sessions-list"), [], sessionAction);
      clearSessionMessages();
    }
    return {
      confirm: confirmPassword,
      loadSessions,
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
