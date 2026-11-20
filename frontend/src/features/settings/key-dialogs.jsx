import { bindDialogBackdrop } from "../../lib/dialog-backdrop";
import { createLifecycle } from "../../lib/lifecycle";
import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Icon } from "../../components/icon";
import { SettingsTimestamp } from "./timestamp";
import {
  displayKeyRole,
  keyExpired,
  keyNameError,
  keyRoles,
  keyStatus,
} from "./key-roles";
import { AccessSwitch, keyDate } from "./key-controls";
import "./key-dialogs.css";

function CreateForm({ busy, error, full, close, mutate }) {
  const [name, setName] = useState(""),
    [profile, setProfile] = useState("read"),
    [days, setDays] = useState(30);
  const nameError = name ? keyNameError(name) : "";
  return (
    <form
      id="token-form"
      className="akd-form akd-create"
      aria-busy={busy}
      onSubmit={(e) => {
        e.preventDefault();
        if (busy || full || keyNameError(name)) return;
        mutate("create", null, {
          name: name.trim(),
          profile,
          expiresAt: days ? Math.floor(Date.now() / 1000) + days * 86400 : 0,
        });
      }}
    >
      <div className="akd-body">
        <div className="akd-field">
          <label htmlFor="token-name">Name</label>
          <Input
            id="token-name"
            data-initial-focus
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={120}
            disabled={busy}
            autoComplete="off"
            placeholder="e.g. My browser extension"
            aria-invalid={!!nameError}
            aria-describedby={nameError ? "token-name-error" : undefined}
          />
          {nameError && (
            <p id="token-name-error" className="form-error" role="alert">
              {nameError}
            </p>
          )}
        </div>
        <fieldset
          className="akd-fieldset"
          aria-describedby="token-permissions-help"
          disabled={busy}
        >
          <legend>Role</legend>
          <div className="akd-roles">
            {Object.entries(keyRoles).map(([value, role]) => (
              <label key={value} className="akd-option">
                <input
                  type="radio"
                  name="token-profile"
                  value={value}
                  aria-label={role.label}
                  checked={profile === value}
                  onChange={() => setProfile(value)}
                />
                <span className="akd-card">
                  <span className="akd-card-line">
                    <span className="akd-card-icon">
                      <Icon name={role.icon} />
                    </span>
                    <strong>{role.label}</strong>
                    <span className="akd-radio-dot" aria-hidden="true" />
                  </span>
                  <span className="akd-summary">{role.summary}</span>
                </span>
              </label>
            ))}
          </div>
          <p
            id="token-permissions-help"
            className="akd-privilege"
            aria-live="polite"
          >
            {keyRoles[profile].description}
          </p>
        </fieldset>
        <fieldset className="akd-fieldset" disabled={busy}>
          <legend>Expires after</legend>
          <div className="akd-expiries">
            {[
              [30, "30 days"],
              [90, "90 days"],
              [365, "1 year"],
              [0, "Never"],
            ].map(([value, label]) => (
              <label key={value} className="akd-expiry-option">
                <input
                  type="radio"
                  name="token-expiry"
                  checked={days === value}
                  value={value}
                  onChange={() => setDays(value)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {error && (
          <p
            id="tokens-error"
            className="form-error"
            role="alert"
            tabIndex="-1"
          >
            {error}
          </p>
        )}
      </div>
      <footer className="akd-footer">
        <Button type="button" variant="outline" disabled={busy} onClick={close}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="default"
          disabled={busy || full || !!keyNameError(name)}
        >
          Create key
        </Button>
      </footer>
    </form>
  );
}

function Reveal({ token, secret, close, toast }) {
  const input = useRef(null);
  const [shown, setShown] = useState(false);
  useLayoutEffect(() => {
    const field = input.current;
    field.value = secret.current;
    secret.current = "";
    return () => {
      field.value = "";
    };
  }, [secret]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(input.current.value);
      if (input.current) toast("Key copied.");
    } catch {
      if (!input.current) return;
      setShown(true);
      input.current.type = "text";
      input.current.focus();
      input.current.select();
      toast("Key selected. Use your copy shortcut.");
    }
  }
  return (
    <div id="new-token" className="akd-form">
      <div className="akd-body">
        <div className="akd-reveal-title">
          <span className="akd-success">
            <Icon name="check" />
          </span>
          <div>
            <strong>{token.name}</strong>
            <p>
              {displayKeyRole(token.profile).label} ·{" "}
              {token.expiresAt
                ? "Expires " + keyDate(token.expiresAt * 1000)
                : "No expiry"}
            </p>
          </div>
        </div>
        <div className="akd-field">
          <label htmlFor="new-token-value">New API key</label>
          <div className="akd-value">
            <Input
              id="new-token-value"
              type={shown ? "text" : "password"}
              ref={input}
              readOnly
              autoComplete="off"
              spellCheck="false"
              aria-describedby="key-once"
            />
            <Button
              type="button"
              id="toggle-token"
              variant="outline"
              aria-pressed={shown}
              aria-controls="new-token-value"
              aria-label={shown ? "Hide API key" : "Show API key"}
              onClick={() => setShown(!shown)}
            >
              {shown ? "Hide" : "Show"}
            </Button>
          </div>
          <p id="key-once" className="akd-hint">
            Copy this key before closing. You can only view it once.
          </p>
        </div>
      </div>
      <footer className="akd-footer">
        <Button
          type="button"
          id="copy-token"
          variant="outline"
          data-initial-focus
          onClick={copy}
        >
          Copy key
        </Button>
        <Button type="button" variant="default" onClick={close}>
          Done
        </Button>
      </footer>
    </div>
  );
}

function Inspector({ token, busy, error, now, mutate, toggle }) {
  const [draft, setDraft] = useState(null);
  const renameButton = useRef(null),
    nameInput = useRef(null);
  const role = displayKeyRole(token.profile),
    expired = keyExpired(token, now),
    status = keyStatus(token, now);
  const editing = draft !== null;
  useLayoutEffect(() => {
    if (editing) {
      nameInput.current.focus();
      nameInput.current.select();
    }
  }, [editing]);
  function cancelRename() {
    setDraft(null);
    requestAnimationFrame(() => renameButton.current?.focus());
  }
  const nameError = editing ? keyNameError(draft) : "";
  return (
    <div className="ak-inspector">
      <div className="aki-overview">
        <div className="aki-badges">
          <span className={`aki-status aki-${status.toLowerCase()}`}>
            <i aria-hidden="true" />
            {status}
          </span>
          <span className="aki-role">
            <Icon name={role.icon} />
            {role.label}
          </span>
        </div>
        {!editing && (
          <Button
            type="button"
            className="aki-text-btn"
            ref={renameButton}
            aria-label={`Rename ${token.name}`}
            disabled={busy}
            onClick={() => setDraft(token.name)}
          >
            <Icon name="edit" />
            Rename
          </Button>
        )}
      </div>
      {editing && (
        <form
          className="aki-rename-form"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              e.preventDefault();
              if (!busy) cancelRename();
            }
          }}
          onSubmit={async (e) => {
            e.preventDefault();
            if (nameError || busy) return;
            if (
              draft.trim() === token.name ||
              (await mutate("rename", token, { name: draft.trim() }))
            )
              cancelRename();
          }}
        >
          <label htmlFor="token-rename">Key name</label>
          <Input
            id="token-rename"
            ref={nameInput}
            required
            maxLength={120}
            autoComplete="off"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={busy}
            aria-invalid={!!nameError}
            aria-describedby="rename-key-note"
          />
          <p id="rename-key-note">
            {nameError || "Renaming keeps the same key value."}
          </p>
          <div className="aki-edit-actions">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={cancelRename}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="default"
              disabled={busy || !!nameError}
            >
              Save name
            </Button>
          </div>
        </form>
      )}
      <section className="aki-section">
        <h3>Key details</h3>
        <dl className="aki-facts">
          {[
            ["Created", token.createdAt, "Unavailable"],
            ["Last activity", token.lastUsedAt, "No recorded use"],
            [
              expired ? "Expired" : "Expires",
              token.expiresAt * 1000,
              "No expiry",
            ],
          ].map(([label, value, fallback]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>
                <SettingsTimestamp
                  date={value ? new Date(value) : null}
                  fallback={fallback}
                />
              </dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="aki-section">
        <h3>Permissions</h3>
        <div className="aki-permissions">
          <span className="aki-role-icon">
            <Icon name={role.icon} />
          </span>
          <div>
            <strong>{role.summary}</strong>
            <p>{role.description}</p>
          </div>
        </div>
      </section>
      <section className="aki-section">
        <div className="aki-access-line">
          <h3>Key access</h3>
          <AccessSwitch
            {...{ token, now }}
            busy={busy || editing}
            onClick={() => toggle(token)}
          />
        </div>
        <p className="aki-note">
          {expired
            ? token.active
              ? "This key has expired. Turn off access to revoke it."
              : "Expired keys cannot be enabled. Create a new key to reconnect this app."
            : token.active
              ? "Turn off access to pause requests from this app."
              : "Turn on access to let this app connect again."}
        </p>
        {status === "Active" && (
          <Button
            type="button"
            className="aki-rotate"
            variant="outline"
            aria-label={`Rotate key for ${token.name}`}
            disabled={busy || editing}
            onClick={() => mutate("rotate", token)}
          >
            <Icon name="refresh" />
            Rotate key
          </Button>
        )}
      </section>
      <section className="aki-revoke-section">
        <div>
          <h3>Revoke key</h3>
          <p id="revoke-key-note">
            {token.active
              ? "Disable this key before revoking it."
              : "Revoking permanently removes this key."}
          </p>
        </div>
        <Button
          type="button"
          variant="destructive"
          aria-label={`Revoke ${token.name}`}
          aria-describedby="revoke-key-note"
          disabled={token.active || busy || editing}
          onClick={() => mutate("revoke", token)}
        >
          <Icon name="trash" />
          Revoke
        </Button>
      </section>
      {error && (
        <p className="form-error" role="alert" tabIndex="-1">
          {error}
        </p>
      )}
    </div>
  );
}

export function KeyDialog(props) {
  const { view, token, busy, requestDismiss, error } = props;
  const dialog = useRef(null);
  const inspect = view.kind === "inspect",
    create = view.kind === "create";
  const title = inspect
    ? token.name
    : create
      ? "Create API key"
      : view.rotated
        ? "API key rotated"
        : "API key created";
  useLayoutEffect(() => {
    const node = dialog.current;
    const lifecycle = createLifecycle();
    bindDialogBackdrop(node, lifecycle);
    node.showModal();
    return () => {
      lifecycle.dispose();
      if (node.open) node.close();
    };
  }, []);
  useLayoutEffect(() => {
    const node = dialog.current;
    (
      node.querySelector("[data-initial-focus]") ||
      node.querySelector(".key-close")
    )?.focus();
  }, [view.kind]);
  useLayoutEffect(() => {
    if (error) dialog.current.querySelector("[role=alert]")?.focus();
  }, [error]);
  return (
    <dialog
      className="modal key-dialog"
      ref={dialog}
      id="key-dialog"
      aria-labelledby="key-dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) requestDismiss();
      }}
      onClose={() => {
        const node = dialog.current;
        if (!node || node.open) return;
        if (busy || view.kind === "reveal") node.showModal();
        if (!busy) requestDismiss();
      }}
    >
      <header className="key-dialog-head">
        <h2 id="key-dialog-title">{title}</h2>
        <Button
          type="button"
          className="key-close"
          size="icon"
          aria-label="Close dialog"
          disabled={busy}
          onClick={requestDismiss}
        >
          <Icon name="close" />
        </Button>
      </header>
      <div className="key-dialog-body">
        {inspect ? (
          <Inspector {...props} />
        ) : create ? (
          <CreateForm {...props} />
        ) : (
          <Reveal {...props} />
        )}
      </div>
    </dialog>
  );
}
