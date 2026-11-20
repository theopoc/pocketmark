import { renderRegion } from "../../lib/render";
import { KeyPage } from "./tokens";
import { keyStatus } from "./key-roles";

export function createKeyRegister({ document, api, confirmAction, toast }) {
  const container = document.getElementById("token-list");
  let session = 0;
  let read = 0;
  let visible = false;
  let protectingValue = false;
  let records = null;
  let error = "";
  let timer;

  function draw() {
    clearTimeout(timer);
    const now = Date.now();
    const count = records?.filter(
      (key) => keyStatus(key, now) === "Active",
    ).length;
    document.querySelectorAll("[data-settings-key-count]").forEach((node) => {
      node.textContent = count == null ? "" : `${count} active`;
    });
    if (records?.length) {
      const expiry = records
        .filter((key) => key.active && key.expiresAt * 1000 > now)
        .reduce((next, key) => Math.min(next, key.expiresAt * 1000), Infinity);
      const delay = Math.min(visible ? 60000 : Infinity, expiry - now);
      if (Number.isFinite(delay))
        timer = setTimeout(draw, Math.min(delay, 2147483647));
    }
    const current = session;
    renderRegion(
      container,
      visible ? (
        <KeyPage
          records={records}
          error={error}
          now={now}
          api={api}
          toast={toast}
          confirmAction={confirmAction}
          reload={load}
          protectValue={(value) => {
            if (current === session) protectingValue = value;
          }}
          update={(key, remove = false) => {
            if (current !== session) return;
            ++read;
            const next = (records || []).filter((item) => item.id !== key.id);
            if (!remove) next.push(key);
            records = next.sort((a, b) => a.id - b.id);
            error = "";
            draw();
            // PATCH and rotate omit unchanged metadata and other clients’ changes.
            return load();
          }}
        />
      ) : null,
    );
  }
  async function load() {
    const attempt = ++read;
    try {
      const result = await api("/api/tokens");
      if (attempt !== read) return;
      records = result;
      error = "";
    } catch (failure) {
      if (attempt !== read) return;
      error = failure.message;
    }
    draw();
  }
  return {
    valueProtected() {
      return protectingValue;
    },
    dispose() {
      protectingValue = false;
      ++read;
      ++session;
      clearTimeout(timer);
    },
    visible(value) {
      if (visible === value) return;
      visible = value;
      draw();
    },
    start() {
      ++session;
      records = null;
      error = "";
      draw();
      return load();
    },
    clear() {
      protectingValue = false;
      ++session;
      ++read;
      visible = false;
      records = null;
      error = "";
      draw();
    },
  };
}
