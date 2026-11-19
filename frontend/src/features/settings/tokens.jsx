import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Icon } from "../../components/icon";
import { renderRegion } from "../../lib/render";
import { SettingsTimestamp } from "./timestamp";
import { keyRoles } from "./key-roles";
import "./keys.css";

function TokenDate({ value, fallback = "No recorded use" }) {
  const date = value ? new Date(value) : null;
  return <SettingsTimestamp date={date} fallback={fallback} />;
}

function RenameForm({ token, model, onCancel }) {
  const input = useRef(null);
  const [error, setError] = useState("");
  useLayoutEffect(() => {
    input.current.focus();
    input.current.select();
  }, []);
  async function submit(event) {
    event.preventDefault();
    if (model.busy || !model.isCurrent()) return;
    const name = input.current.value.trim();
    if (!name || new TextEncoder().encode(name).length > 120) {
      input.current.setCustomValidity(
        "Enter a name of 1–120 bytes. Shorten names with accented letters or emoji if needed.",
      );
      input.current.reportValidity();
      return;
    }
    if (name === token.name) {
      onCancel();
      return;
    }
    setError("");
    try {
      await model.onRename(token, name);
    } catch (failure) {
      if (model.isCurrent()) {
        setError(failure.message);
        input.current?.focus();
      }
    }
  }
  return (
    <form
      className="token-rename-form"
      aria-busy={model.busy || undefined}
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (!model.busy) onCancel();
        }
      }}
    >
      <label htmlFor={`token-rename-${token.id}`}>Name</label>
      <Input
        ref={input}
        id={`token-rename-${token.id}`}
        defaultValue={token.name}
        required
        maxLength={120}
        autoComplete="off"
        aria-describedby={`token-rename-help-${token.id}`}
        disabled={model.busy}
        onInput={() => {
          input.current.setCustomValidity("");
          setError("");
        }}
      />
      <p className="small muted" id={`token-rename-help-${token.id}`}>
        Only the name changes. Your apps keep using the same key.
      </p>
      <div className="token-edit-actions">
        <Button type="submit" variant="default" disabled={model.busy}>
          Save name
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={model.busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
      <p className="form-error" role="alert">
        {error}
      </p>
    </form>
  );
}

function TokenRows({ token, model }) {
  const [open, setOpen] = useState(false);
  const nameButton = useRef(null);
  const renameButton = useRef(null);
  const toggleButton = useRef(null);
  const expired = token.expiresAt > 0 && token.expiresAt * 1000 <= Date.now();
  const locked = model.busy || model.editingID !== null;
  const detailsID = `token-details-${token.id}`;
  useLayoutEffect(() => {
    if (model.focusID !== token.id) return;
    const toggle = toggleButton.current;
    const target =
      model.focusAction === "rename"
        ? renameButton.current
        : toggle.disabled
          ? nameButton.current
          : toggle;
    target?.focus();
  }, [model.focusID, model.focusAction, model.epoch, token.id]);

  return (
    <tbody data-token-id={token.id}>
      <tr className="key-line">
        <th scope="row">
          <Button
            ref={nameButton}
            className="key-name-button"
            type="button"
            aria-label={`Details for ${token.name}`}
            aria-expanded={open}
            aria-controls={detailsID}
            aria-disabled={locked}
            onClick={() => {
              if (!locked) setOpen(!open);
            }}
          >
            <Icon name="chevron-right" />
            <span>{token.name}</span>
          </Button>
        </th>
        <td className="key-role">
          <span className="key-caption" aria-hidden="true">
            Role
          </span>
          {keyRoles[token.profile]?.label || token.profile}
        </td>
        <td className="key-activity">
          <span className="key-caption" aria-hidden="true">
            Last activity
          </span>
          <TokenDate value={token.lastUsedAt} />
        </td>
        <td className="key-status">
          <Button
            type="button"
            className="key-toggle"
            role="switch"
            ref={toggleButton}
            aria-label={`Access for ${token.name}`}
            aria-checked={token.active}
            aria-describedby="token-access-hint"
            title={
              token.active && expired
                ? "Turn off this expired key to revoke it"
                : undefined
            }
            disabled={locked || (expired && !token.active)}
            onClick={() => model.onChange(token, false)}
          >
            <span className="key-switch-track" aria-hidden="true" />
            {token.active ? (expired ? "Expired" : "Active") : "Disabled"}
          </Button>
        </td>
        <td className="key-actions">
          <Button
            type="button"
            variant="destructive"
            className="key-revoke"
            aria-label={`Revoke ${token.name}`}
            disabled={locked || token.active}
            onClick={() => model.onChange(token, true)}
          >
            <Icon name="trash" /> Revoke
          </Button>
        </td>
      </tr>
      <tr id={detailsID} className="key-detail-row" hidden={!open}>
        <td colSpan={5}>
          <dl className="key-metadata">
            <div>
              <dt>Created</dt>
              <dd>
                <TokenDate value={token.createdAt} fallback="Unavailable" />
              </dd>
            </div>
            <div>
              <dt>{expired ? "Expired" : "Expires"}</dt>
              <dd>
                {token.expiresAt ? (
                  <TokenDate
                    value={token.expiresAt * 1000}
                    fallback="Unavailable"
                  />
                ) : (
                  "No expiry"
                )}
              </dd>
            </div>
          </dl>
          {expired && (
            <p className="small muted">
              Create a new key to reconnect this app.
            </p>
          )}
          {model.editingID === token.id ? (
            <RenameForm
              token={token}
              model={model}
              onCancel={() => {
                model.onEditing(null);
                renameButton.current?.focus();
              }}
            />
          ) : (
            <div className="key-detail-actions">
              <Button
                type="button"
                ref={renameButton}
                variant="outline"
                aria-label={`Rename ${token.name}`}
                disabled={locked}
                onClick={() => model.onEditing(token.id)}
              >
                <Icon name="edit" /> Rename
              </Button>
              {token.active && !expired && (
                <Button
                  type="button"
                  variant="outline"
                  aria-label={`Rotate ${token.name}`}
                  disabled={locked}
                  onClick={() => model.onRotate(token)}
                >
                  <Icon name="refresh" /> Rotate key
                </Button>
              )}
            </div>
          )}
        </td>
      </tr>
    </tbody>
  );
}

export function TokenList({ model }) {
  if (!model.tokens.length)
    return (
      <p className="token-empty muted">
        No API keys yet. Create a key to connect your first app.
      </p>
    );
  return (
    <>
      <p className="small muted" id="token-access-hint">
        Turn off a key to revoke it.
      </p>
      <table className="key-table" role="table" aria-label="API keys">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Role</th>
            <th scope="col">Last activity</th>
            <th scope="col">Status</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        {model.tokens.map((token) => (
          <TokenRows key={token.id} token={token} model={model} />
        ))}
      </table>
    </>
  );
}

export function renderTokenList(element, model) {
  renderRegion(element, <TokenList key={model.session} model={model} />);
}

function TokenStatus({ message, onRetry }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className={`token-empty${onRetry ? "" : " muted"}`}>
      {onRetry ? (
        <Button
          variant="default"
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onRetry();
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Loading API keys…" : message}
        </Button>
      ) : (
        message
      )}
    </div>
  );
}

export function renderTokenStatus(element, message, onRetry) {
  renderRegion(
    element,
    <TokenStatus key={message} message={message} onRetry={onRetry} />,
  );
}
