import PocketmarkSelect from "../../../internal/webui/static/select.js";
import { createLifecycle } from "../lib/lifecycle.js";
("use strict");
const security = {
  create({ api, toast, onSessionExpired }, browser = globalThis) {
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
    const date = (value) =>
      value
        ? new Date(value * 1000).toLocaleString()
        : "Unavailable for older sessions";
    const node = (tag, text, className = "") => {
      const n = document.createElement(tag);
      n.textContent = text;
      n.className = className;
      return n;
    };
    function clearSessionMessages() {
      $("sessions-error").textContent = $("sessions-feedback").textContent = "";
    }
    async function loadSessions() {
      const attempt = ++generation;
      clearSessionMessages();
      $("sessions-list").replaceChildren(
        node("li", "Loading sessions…", "muted"),
      );
      try {
        const sessions = await api("/api/sessions");
        if (attempt !== generation || $("settings-page").hidden) return;
        $("sessions-list").replaceChildren();
        const current = sessions.find((session) => session.current);
        $("session-idle").value = String(current?.idleTimeoutMinutes ?? 1440);
        PocketmarkSelect.sync($("session-idle"));
        $("sessions-others").disabled = !sessions.some(
          (session) => !session.current,
        );
        if (!sessions.length)
          $("sessions-list").append(
            node("li", "No active browser sessions.", "muted"),
          );
        for (const session of sessions) {
          const row = node("li", "", "token-row");
          const details = node("div", "", "token-details");
          details.append(
            node("strong", session.current ? "This browser" : "Other browser"),
          );
          const device = session.device || "";
          const browserName = /Edg\//.test(device)
            ? "Edge"
            : /Firefox\//.test(device)
              ? "Firefox"
              : /Chrome\//.test(device)
                ? "Chrome"
                : /Safari\//.test(device)
                  ? "Safari"
                  : "Browser";
          const platform = /Android/.test(device)
            ? "Android"
            : /iPhone|iPad/.test(device)
              ? "iOS"
              : /Windows/.test(device)
                ? "Windows"
                : /Macintosh/.test(device)
                  ? "macOS"
                  : /Linux/.test(device)
                    ? "Linux"
                    : "";
          details.append(
            node(
              "p",
              device
                ? `${browserName}${platform ? ` on ${platform}` : ""}`
                : "Browser details unavailable",
              "small muted",
            ),
          );
          const times = node("dl", "", "session-times");
          for (const [label, value] of [
            ["Signed in", session.createdAt],
            ["Last active", session.lastUsedAt],
            ["Expires", session.expiresAt],
          ])
            times.append(node("dt", label), node("dd", date(value)));
          details.append(times);
          if (device) {
            const technical = node("details", "", "session-technical");
            technical.append(
              node("summary", "Technical details"),
              node("p", device, "small muted session-device"),
            );
            details.append(technical);
          }
          const button = node(
            "button",
            session.current ? "Sign out" : "Revoke session",
            "button subtle",
          );
          button.type = "button";
          button.setAttribute(
            "aria-label",
            session.current
              ? "Sign out this browser"
              : `Revoke session ${session.id}`,
          );
          lifecycle.listen(button, "click", async () => {
            clearSessionMessages();
            button.disabled = true;
            try {
              await api(
                session.current ? "/api/logout" : `/api/sessions/${session.id}`,
                { method: session.current ? "POST" : "DELETE" },
              );
              if (session.current) onSessionExpired();
              else {
                await loadSessions();
                $("sessions-feedback").textContent =
                  "Session revoked. That browser must sign in again.";
                $("sessions-refresh").focus();
              }
            } catch (error) {
              $("sessions-error").textContent = error.message;
              button.disabled = false;
            }
          });
          row.append(details, button);
          $("sessions-list").append(row);
        }
      } catch (error) {
        if (attempt === generation) {
          $("sessions-list").replaceChildren();
          $("sessions-error").textContent =
            `${error.message} Use Refresh sessions to retry.`;
        }
      }
    }
    lifecycle.listen($("sessions-refresh"), "click", loadSessions);
    lifecycle.listen($("sessions-others"), "click", async () => {
      clearSessionMessages();
      $("sessions-others").disabled = true;
      try {
        await api("/api/sessions/others", { method: "DELETE" });
        await loadSessions();
        $("sessions-feedback").textContent =
          "All other browsers have been signed out.";
      } catch (error) {
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
      generation++;
      clearSessionMessages();
    }
    return {
      confirm: confirmPassword,
      loadSessions,
      clear,
      dispose() {
        generation++;
        lifecycle.dispose();
        pending = resolveConfirmation = rejectConfirmation = null;
      },
    };
  },
};

export default security;
