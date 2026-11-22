import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Icon } from "../../components/icon";
import { displayKeyRole, keyExpired, keyStatus } from "./key-roles";
import { AccessSwitch, keyDate } from "./key-controls";
import { KeyDialog } from "./key-dialogs";
import "./keys.css";

const filters = ["All keys", "Active", "Disabled", "Expired"];
const day = 86400000;
function Activity({ value, now }) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return <span>No recorded use</span>;
  const minutes = Math.max(0, Math.floor((now - time) / 60000));
  let label = "Just now";
  if (minutes >= 1440) {
    const days = Math.floor(minutes / 1440);
    label = days + (days === 1 ? " day ago" : " days ago");
  } else if (minutes >= 60) label = Math.floor(minutes / 60) + " hr ago";
  else if (minutes) label = minutes + " min ago";
  return (
    <time dateTime={value} title={new Date(time).toLocaleString()}>
      {label}
    </time>
  );
}

function KeySummary({ records, now, inspect }) {
  const next = records
    .filter((token) => token.active && token.expiresAt * 1000 > now)
    .reduce(
      (first, token) =>
        !first || first.expiresAt > token.expiresAt ? token : first,
      null,
    );
  const days = next ? Math.ceil((next.expiresAt * 1000 - now) / day) : 0;
  return (
    <div className="ak-overview">
      <section className="ak-capacity">
        <div className="ak-quota-line">
          <h2>Key capacity</h2>
          <span className="ak-quota-count">
            <strong id="token-count" title={`${records.length} of 32 keys`}>
              {records.length}
            </strong>{" "}
            / 32
          </span>
        </div>
        <div className="ak-meter" aria-hidden="true">
          {Array.from({ length: 32 }, (_, i) => (
            <i key={i} className={i < records.length ? "used" : undefined} />
          ))}
        </div>
      </section>
      {next ? (
        <Button
          type="button"
          className="ak-expiry"
          onClick={() => inspect(next)}
          aria-haspopup="dialog"
        >
          <span className="ak-expiry-icon">
            <Icon name="clock" />
          </span>
          <span className="ak-expiry-copy">
            <span className="ak-small-label">Next expiry</span>
            <span className="ak-expiry-detail">
              <strong>{next.name}</strong>
              <span className={`ak-due${days <= 7 ? " soon" : ""}`}>
                {days === 1 ? "Within 24 hours" : `In ${days} days`}
              </span>
            </span>
          </span>
          <span className="ak-expiry-arrow">
            <Icon name="chevron-right" />
          </span>
        </Button>
      ) : (
        <section className="ak-expiry static">
          <span className="ak-expiry-icon">
            <Icon name="clock" />
          </span>
          <div>
            <h2>Next expiry</h2>
            <p>No upcoming expiries</p>
          </div>
        </section>
      )}
    </div>
  );
}

function KeyRow({ token, busy, now, inspect, toggle }) {
  const role = displayKeyRole(token.profile);
  return (
    <tr
      data-token-id={token.id}
      className="ak-row"
      onClick={(event) => {
        if (event.target.closest("button") || window.getSelection()?.toString())
          return;
        inspect(token);
      }}
    >
      <td className="ak-name-cell">
        <span className="ak-identity">
          <span className={`ak-symbol ak-${token.profile}`}>
            <Icon name={role.icon} />
          </span>
          <span className="ak-identity-text">
            <strong>{token.name}</strong>
            <small>Created {keyDate(token.createdAt)}</small>
          </span>
        </span>
      </td>
      <td className="ak-role-cell">
        <span className="ak-mobile-label" aria-hidden="true">
          Role
        </span>
        <span className="ak-role">{role.label}</span>
      </td>
      <td className="ak-time-cell">
        <span className="ak-mobile-label" aria-hidden="true">
          Last activity
        </span>
        <Activity value={token.lastUsedAt} now={now} />
      </td>
      <td className="ak-state-cell">
        <AccessSwitch
          token={token}
          busy={busy}
          now={now}
          onClick={() => toggle(token)}
          showStatus
        />
      </td>
      <td className="ak-action-cell">
        <Button
          type="button"
          className="ak-row-open"
          aria-haspopup="dialog"
          aria-label={`Manage ${token.name}`}
          title={`Manage ${token.name}`}
          disabled={busy}
          id={`manage-key-${token.id}`}
          onClick={() => inspect(token)}
        >
          <Icon name="chevron-right" />
        </Button>
      </td>
    </tr>
  );
}

export function KeyPage({
  records,
  error: loadError,
  now,
  api,
  confirmAction,
  toast,
  update,
  reload,
  protectValue,
}) {
  const [filter, setFilter] = useState(filters[0]),
    [query, setQuery] = useState("");
  const [view, setView] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const search = useRef(null),
    alive = useRef(false),
    pending = useRef(false),
    secret = useRef("");
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      secret.current = "";
    };
  }, []);
  // Issued metadata stays with its receipt even if another owner session revokes
  // or renames the key before the server list refresh finishes.
  const selected = view?.receipt || records?.find((key) => key.id === view?.id);
  function open(kind, key) {
    if (pending.current || loadError) return;
    setError("");
    setView({ kind, id: key?.id });
  }
  function close(id) {
    protectValue(false);
    secret.current = "";
    setView(null);
    setError("");
    requestAnimationFrame(() => {
      if (!alive.current) return;
      const target =
        document.getElementById("manage-key-" + id) ||
        document.querySelector("#token-create:not(:disabled)") ||
        document.getElementById("api-keys-title");
      target?.focus({ preventScroll: true });
    });
  }
  async function requestDismiss() {
    if (pending.current) return;
    if (view?.kind === "reveal") {
      const discard = await confirmAction(
        "Close this key value?",
        "Save a copy before closing. The value cannot be retrieved again.",
        "Close key value",
      );
      if (!discard || !alive.current) return;
    }
    close(view?.id);
  }
  function restoreSwitch(key, origin) {
    requestAnimationFrame(() => {
      if (!alive.current) return;
      const active = document.activeElement;
      if (active && active !== document.body && active !== origin) return;
      const container = origin?.closest("#key-dialog")
        ? document.querySelector("#key-dialog")
        : document.querySelector(`tr[data-token-id="${key.id}"]`);
      const target =
        container?.querySelector('[role="switch"]:not(:disabled)') ||
        container?.querySelector("button:not(:disabled)") ||
        search.current;
      target?.focus({ preventScroll: true });
    });
  }
  async function mutate(action, token, body) {
    if (pending.current) return false;
    if (action === "access" && body.active && keyExpired(token)) {
      setError(
        "An expired key cannot be enabled. Create a new key to reconnect this app.",
      );
      return false;
    }
    if (action === "revoke" && token.active) return false;
    if (action === "rotate" && keyStatus(token) !== "Active") return false;
    const issuing = action === "create" || action === "rotate";
    const switchOrigin = action === "access" ? document.activeElement : null;
    let receipt = false;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      if (action === "revoke" || action === "rotate") {
        const revoke = action === "revoke";
        const accepted = await confirmAction(
          revoke ? `Revoke ${token.name}?` : `Rotate ${token.name}?`,
          revoke
            ? "Apps using this key will need a new one to reconnect."
            : "The old value will stop working immediately. Update the connected app with the new key.",
          revoke ? "Revoke key" : "Rotate key",
        );
        if (!accepted || !alive.current) return false;
      }
      if (issuing) protectValue(true);
      const path = token ? `/api/tokens/${token.id}` : "/api/tokens";
      const result = await api(action === "rotate" ? path + "/rotate" : path, {
        method:
          action === "revoke"
            ? "DELETE"
            : action === "rotate" || action === "create"
              ? "POST"
              : "PATCH",
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (issuing) {
        const { token: value, ...metadata } = result;
        const updated =
          action === "create" ? metadata : { ...token, lastUsedAt: "" };
        update(updated);
        if (alive.current) {
          receipt = true;
          secret.current = value;
          if (action === "create") {
            setFilter(filters[0]);
            setQuery("");
          }
          setView({
            kind: "reveal",
            id: updated.id,
            rotated: action === "rotate",
            receipt: updated,
          });
        }
      } else {
        await update({ ...token, ...body }, action === "revoke");
        if (!alive.current) return true;
        if (action === "revoke") close();
        toast(
          action === "rename"
            ? "Key renamed."
            : action === "revoke"
              ? "Key revoked."
              : body.active
                ? "Key enabled."
                : "Key disabled. Apps using this key can no longer connect.",
        );
      }
      return true;
    } catch (failure) {
      if (alive.current) {
        setError(failure.message);
        if ([404, 409].includes(failure.status)) await reload();
      }
      return false;
    } finally {
      if (issuing && !receipt) protectValue(false);
      pending.current = false;
      if (alive.current) {
        setBusy(false);
        if (action === "access") restoreSwitch(token, switchOrigin);
      }
    }
  }
  const toggle = (key) => mutate("access", key, { active: !key.active });
  const inspect = (key) => open("inspect", key);
  const term = query.trim().toLowerCase();
  const visible = (records || []).filter(
    (key) =>
      (filter === filters[0] || keyStatus(key, now) === filter) &&
      (key.name + " " + displayKeyRole(key.profile).label)
        .toLowerCase()
        .includes(term),
  );
  const full = records?.length >= 32;
  const dialogOpen = view && (view.kind === "create" || selected);
  return (
    <div className="ak-page">
      <header className="ak-head">
        <div>
          <h1 id="api-keys-title" tabIndex="-1">
            API keys
          </h1>
          <p>Manage how apps and extensions access your library.</p>
        </div>
        <Button
          id="token-create"
          type="button"
          variant="default"
          className="ak-create"
          aria-haspopup="dialog"
          disabled={!records || full || busy || !!loadError}
          onClick={() => open("create")}
        >
          <Icon name="plus" /> Create key
        </Button>
      </header>
      {loadError && (
        <div>
          <p role="alert" className="form-error">
            {loadError}
          </p>
          <Button type="button" variant="outline" onClick={reload}>
            Retry loading keys
          </Button>
        </div>
      )}
      {!records && !loadError && <p role="status">Loading API keys…</p>}
      {records && (
        <>
          <KeySummary records={records} now={now} inspect={inspect} />
          {full && (
            <p>
              All 32 key slots are in use. Revoke a disabled key to create
              another.
            </p>
          )}
          <div className="ak-register">
            <div className="ak-tools">
              <div
                className="ak-filters"
                role="group"
                aria-label="Filter keys by status"
              >
                {filters.map((option) => (
                  <Button
                    key={option}
                    type="button"
                    aria-pressed={filter === option}
                    onClick={() => setFilter(option)}
                  >
                    {option}
                  </Button>
                ))}
              </div>
              <label className="ak-filter-select">
                <span className="sr-only">Filter keys by status</span>
                <select
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  {filters.map((option) => (
                    <option key={option}>{option}</option>
                  ))}
                </select>
              </label>
              <label className="ak-find">
                <Icon name="search" />
                <Input
                  ref={search}
                  aria-label="Find a key by name or role"
                  type="search"
                  placeholder="Find a key…"
                  maxLength={160}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
            </div>
            {visible.length ? (
              <table className="ak-table" aria-label="API keys">
                <colgroup>
                  {["name", "role", "time", "state", "action"].map((name) => (
                    <col key={name} className={`ak-col-${name}`} />
                  ))}
                </colgroup>
                <thead>
                  <tr>
                    {["Name", "Role", "Last activity", "Status", "Actions"].map(
                      (label, i) => (
                        <th key={label} scope="col">
                          {i < 4 ? (
                            label
                          ) : (
                            <span className="sr-only">{label}</span>
                          )}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((token) => (
                    <KeyRow
                      key={token.id}
                      {...{ token, now, inspect, toggle }}
                      busy={busy || !!loadError}
                    />
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="ak-empty">
                <span className="ak-empty-icon">
                  <Icon name={records.length ? "search" : "key"} />
                </span>
                <h2>
                  {records.length ? "No matching keys" : "No API keys yet"}
                </h2>
                <p>
                  {records.length
                    ? "Try another name or clear the filters."
                    : "Create a key to connect your first app."}
                </p>
                {records.length > 0 && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setFilter(filters[0]);
                      setQuery("");
                      search.current?.focus();
                    }}
                  >
                    Clear filters
                  </Button>
                )}
              </div>
            )}
          </div>
          <span className="sr-only" role="status">
            {visible.length} {visible.length === 1 ? "key" : "keys"} shown.
          </span>
        </>
      )}
      {!dialogOpen && error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {dialogOpen && (
        <KeyDialog
          {...{
            view,
            token: selected,
            busy,
            error,
            full,
            mutate,
            requestDismiss,
            secret,
            toggle,
            now,
            toast,
          }}
          close={() => close(view.id)}
        />
      )}
    </div>
  );
}
