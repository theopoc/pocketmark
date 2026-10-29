"use strict";
globalThis.PocketmarkSecurity = {
  create({ api, toast, onSessionExpired }) {
    const $ = id => document.getElementById(id);
    const dialog = $("reauth-dialog");
    let pending, resolveConfirmation, rejectConfirmation, confirmed = false, submitting = false, generation = 0;
    function confirmPassword() {
      if (pending) return pending;
      confirmed = false;
      $("reauth-form").reset(); $("reauth-error").textContent = "";
      pending = new Promise((resolve, reject) => { resolveConfirmation = resolve; rejectConfirmation = reject; });
      dialog.showModal(); $("reauth-password").focus();
      return pending;
    }
    dialog.addEventListener("close", () => {
      $("reauth-password").value = "";
      if (confirmed) resolveConfirmation?.();
      else rejectConfirmation?.(new Error("Password confirmation cancelled. No action was taken."));
      pending = resolveConfirmation = rejectConfirmation = null;
    });
    dialog.addEventListener("cancel", event => { if (submitting) event.preventDefault(); });
    $("reauth-cancel").addEventListener("click", () => { if (!submitting) dialog.close(); });
    $("reauth-form").addEventListener("submit", async event => {
      event.preventDefault(); if (submitting) return;
      submitting = true; $("reauth-submit").disabled = $("reauth-cancel").disabled = true;
      $("reauth-error").textContent = "";
      try {
        await api("/api/reauth", { method: "POST", body: JSON.stringify({ password: $("reauth-password").value }) });
        confirmed = true; dialog.close();
      } catch (error) { $("reauth-error").textContent = error.message; $("reauth-password").select(); }
      finally { submitting = false; $("reauth-submit").disabled = $("reauth-cancel").disabled = false; }
    });
    const date = value => value ? new Date(value * 1000).toLocaleString() : "Unavailable for older sessions";
    const node = (tag, text, className = "") => { const n = document.createElement(tag); n.textContent = text; n.className = className; return n; };
    function clearSessionMessages() { $("sessions-error").textContent = $("sessions-feedback").textContent = ""; }
    async function loadSessions() {
      const attempt = ++generation;
      clearSessionMessages();
      $("sessions-list").replaceChildren(node("li", "Loading sessions…", "muted"));
      try {
        const sessions = await api("/api/sessions");
        if (attempt !== generation || !$("settings-dialog").open) return;
        $("sessions-list").replaceChildren();
        const current = sessions.find(session => session.current);
        $("session-idle").value = String(current?.idleTimeoutMinutes ?? 1440);
        $("sessions-others").disabled = !sessions.some(session => !session.current);
        if (!sessions.length) $("sessions-list").append(node("li", "No active browser sessions.", "muted"));
        for (const session of sessions) {
          const row = node("li", "", "token-row");
          const details = node("div", "", "token-details");
          details.append(node("strong", session.current ? "This browser" : "Other browser"));
          details.append(node("p", session.device || "Browser details unavailable", "small muted session-device"));
          details.append(node("p", `Signed in: ${date(session.createdAt)} · Last active: ${date(session.lastUsedAt)} · Expires: ${date(session.expiresAt)}`, "small muted"));
          const button = node("button", session.current ? "Sign out" : "Revoke session", "button subtle");
          button.type = "button";
          button.setAttribute("aria-label", session.current ? "Sign out this browser" : `Revoke session ${session.id}`);
          button.addEventListener("click", async () => {
            clearSessionMessages();
            button.disabled = true;
            try {
              await api(session.current ? "/api/logout" : `/api/sessions/${session.id}`, { method: session.current ? "POST" : "DELETE" });
              if (session.current) onSessionExpired();
              else { await loadSessions(); $("sessions-feedback").textContent = "Session revoked. That browser must sign in again."; $("sessions-refresh").focus(); }
            } catch (error) { $("sessions-error").textContent = error.message; button.disabled = false; }
          });
          row.append(details, button); $("sessions-list").append(row);
        }
      } catch (error) { if (attempt === generation) { $("sessions-list").replaceChildren(); $("sessions-error").textContent = `${error.message} Use Refresh sessions to retry.`; } }
    }
    $("sessions-refresh").addEventListener("click", loadSessions);
    $("sessions-others").addEventListener("click", async () => {
      clearSessionMessages();
      $("sessions-others").disabled = true;
      try { await api("/api/sessions/others", { method: "DELETE" }); await loadSessions(); $("sessions-feedback").textContent = "All other browsers have been signed out."; }
      catch (error) { $("sessions-error").textContent = error.message; $("sessions-others").disabled = false; }
    });
    $("session-idle-form").addEventListener("submit", async event => {
      event.preventDefault(); clearSessionMessages(); event.submitter.disabled = true;
      try { await api("/api/sessions/current", { method: "PATCH", body: JSON.stringify({ idleTimeoutMinutes: Number($("session-idle").value) }) }); $("sessions-feedback").textContent = "Inactivity timeout saved for this browser."; }
      catch (error) { $("sessions-error").textContent = error.message; }
      finally { event.submitter.disabled = false; }
    });
    document.querySelectorAll('a[href="/api/backup"]').forEach(link => link.addEventListener("click", async event => {
      event.preventDefault();
      try { await confirmPassword(); window.location.assign("/api/backup"); }
      catch (error) { toast(error.message, true); }
    }));
    $("settings-dialog").addEventListener("close", () => { generation++; $("sessions-feedback").textContent = ""; });
    return { confirm: confirmPassword, loadSessions };
  },
};
