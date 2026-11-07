import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Icon } from "../../components/icon";
import { renderRegion } from "../../lib/render";

function TokenDate({ value }) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime()))
    return <span className="muted">No recorded use</span>;
  return (
    <time
      dateTime={value}
      title={date.toLocaleString(undefined, { timeZoneName: "short" })}
    >
      {date.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })}
    </time>
  );
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
      <label htmlFor={`token-rename-${token.id}`}>Key name</label>
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

export function TokenList({ model }) {
  const [editingID, setEditingID] = useState(null);
  const refs = useRef(new Map());
  useLayoutEffect(() => {
    if (!model.focusID) return;
    const row = refs.current.get(model.focusID);
    (model.focusAction === "rename"
      ? row?.querySelector(".token-rename")
      : row?.querySelector("[data-token-toggle]:not([hidden])") ||
        row?.querySelector(".token-rename")
    )?.focus();
  }, [model.focusID, model.focusAction]);
  if (!model.tokens.length)
    return (
      <li className="token-empty muted">
        No API keys yet. Create a key to connect your first app.
      </li>
    );
  return model.tokens.map((token, index) => {
    const expired = token.expiresAt > 0 && token.expiresAt * 1000 <= Date.now();
    const disabled = model.busy || editingID !== null;
    const permissions = {
      read: "Read only",
      capture: "Add, edit & capture",
      sync: "Floccus sync",
      full: "Full library access",
    };
    const expiryDate = token.expiresAt
      ? new Date(token.expiresAt * 1000).toLocaleDateString()
      : "No expiry";
    function cancelRename() {
      model.onEditing(null);
      setEditingID(null);
      model.onRefresh(model.tokens, token.id, "rename");
    }
    return (
      <li
        className="token-row"
        key={token.id}
        ref={(node) => {
          if (node) refs.current.set(token.id, node);
          else refs.current.delete(token.id);
        }}
      >
        <details
          className="token-accordion"
          data-token-id={token.id}
          open={
            model.openIDs.has(String(token.id)) ||
            model.focusID === token.id ||
            (model.initial && index === 0)
          }
        >
          <summary
            className="token-summary"
            aria-disabled={disabled}
            onClick={(event) => {
              if (disabled) event.preventDefault();
            }}
          >
            <Icon name="chevron-right" className="icon token-chevron" />
            <span className="token-overview">
              <span className="token-name-row">
                <span className="token-name-group">
                  <strong className="token-name">{token.name}</strong>
                </span>
                <span
                  className={`token-status${token.active && !expired ? " is-active" : ""}`}
                >
                  {expired ? "Expired" : token.active ? "Active" : "Disabled"}
                </span>
              </span>
              <span className="token-permissions small muted">
                {permissions[token.profile] || token.profile}
              </span>
              <span className="token-summary-activity small muted">
                Last used: <TokenDate value={token.lastUsedAt} />
              </span>
            </span>
            <span className="token-summary-expiry small muted">
              {token.expiresAt
                ? `${expired ? "Expired" : "Expires"} ${expiryDate}`
                : "No expiry"}
            </span>
          </summary>
          <div className="token-details">
            {editingID === token.id && (
              <RenameForm token={token} model={model} onCancel={cancelRename} />
            )}
            <dl className="token-metadata">
              <div>
                <dt>Created</dt>
                <dd>
                  <TokenDate value={token.createdAt} />
                </dd>
              </div>
              <div>
                <dt>Last used</dt>
                <dd>
                  <TokenDate value={token.lastUsedAt} />
                </dd>
              </div>
              <div>
                <dt>{expired ? "Expired" : "Expires"}</dt>
                <dd>{expiryDate}</dd>
              </div>
            </dl>
            {expired && (
              <p className="small muted">
                Create a new key to reconnect this app.
              </p>
            )}
            <div className="token-row-actions">
              <Button
                className="button subtle token-rename"
                type="button"
                title={`Rename ${token.name}`}
                aria-label={`Rename ${token.name}`}
                disabled={disabled}
                onClick={() => {
                  model.onEditing(token.id);
                  setEditingID(token.id);
                }}
              >
                <Icon name="edit" />
                Rename
              </Button>
              <Button
                data-token-toggle=""
                variant="outline"
                type="button"
                hidden={expired}
                title={
                  token.active
                    ? "Pause access without changing the key"
                    : "Restore access with the same key"
                }
                aria-label={`${token.active ? "Disable" : "Reactivate"} ${token.name}`}
                disabled={disabled}
                onClick={() => model.onChange(token, false)}
              >
                <Icon name={token.active ? "pause" : "refresh"} />
                {token.active ? "Disable" : "Reactivate"}
              </Button>
              <Button
                variant="outline"
                type="button"
                hidden={!token.active || expired}
                aria-label={`Rotate ${token.name}`}
                disabled={disabled}
                onClick={() => model.onRotate(token)}
              >
                <Icon name="refresh" />
                Rotate key
              </Button>
              <Button
                className="button subtle token-revoke"
                type="button"
                title="Permanently remove this key and its access"
                aria-label={`Delete ${token.name} permanently`}
                disabled={disabled}
                onClick={() => model.onChange(token, true)}
              >
                <Icon name="trash" />
                Delete key
              </Button>
            </div>
          </div>
        </details>
      </li>
    );
  });
}

export function renderTokenList(element, model) {
  renderRegion(element, <TokenList key={model.epoch} model={model} />);
}

function TokenStatus({ message, onRetry }) {
  const [busy, setBusy] = useState(false);
  return (
    <li className={`token-empty${onRetry ? "" : " muted"}`}>
      {onRetry ? (
        <Button
          variant="outline"
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
    </li>
  );
}

export function renderTokenStatus(element, message, onRetry) {
  renderRegion(
    element,
    <TokenStatus key={message} message={message} onRetry={onRetry} />,
  );
}
