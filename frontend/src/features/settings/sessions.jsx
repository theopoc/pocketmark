import { Button } from "../../components/ui/button";
import { Icon } from "../../components/icon";
import { renderRegion } from "../../lib/render";
import { SettingsTimestamp } from "./timestamp";
import { SessionBrowserIcon } from "./session-browser-icon";
import "./sessions.css";

function deviceIdentity(device = "") {
  const browser = [
    /Edg(?:e|A|iOS)?\//,
    /(?:Firefox|FxiOS)\//,
    /(?:Chrome|CriOS)\//,
    /Safari\//,
  ];
  const names = ["Edge", "Firefox", "Chrome", "Safari"];
  const brand = names[browser.findIndex((pattern) => pattern.test(device))];
  const platform = [
    "Android",
    "iPhone",
    "iPad",
    "Windows",
    "Macintosh",
    "Linux",
  ].find((name) => device.includes(name));
  const agent = brand || (device ? "Browser" : "Unknown browser");
  const title = platform
    ? agent + " on " + (platform === "Macintosh" ? "macOS" : platform)
    : agent;
  return { brand, title, mobile: /iPhone|iPad|Android/i.test(device) };
}

function lastActivity(seconds) {
  if (!seconds) return "Activity unavailable";
  const minutes = Math.max(0, Math.floor((Date.now() / 1000 - seconds) / 60));
  if (minutes === 0) return "Active just now";
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const [value, unit] = days
    ? [days, "day"]
    : hours
      ? [hours, "hour"]
      : [minutes, "minute"];
  return "Active " + value + " " + unit + (value === 1 ? "" : "s") + " ago";
}

function viewDetails(session, title, onAction, trigger) {
  const dialog = document.getElementById("session-details-dialog");
  renderRegion(
    document.getElementById("session-details-body"),
    <>
      <header className="dialog-heading">
        <h2 id="session-details-title">{title}</h2>
      </header>
      <p className="muted">
        {session.current ? "Current session" : "Other session"}
      </p>
      <dl className="session-card-metadata">
        <div>
          <dt>Sign-in IP</dt>
          <dd>{session.ipAddress || "Unavailable"}</dd>
        </div>
        {[
          ["Last activity", session.lastUsedAt],
          ["Signed in", session.createdAt],
          ["Expires", session.expiresAt],
        ].map(([label, time]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              <SettingsTimestamp date={time ? new Date(time * 1000) : null} />
            </dd>
          </div>
        ))}
      </dl>
      {session.device && (
        <details className="session-card-details">
          <summary>Raw browser description</summary>
          <p>{session.device}</p>
        </details>
      )}
      <div className="dialog-actions">
        <Button
          type="button"
          variant="outline"
          autoFocus
          onClick={() => dialog.close()}
        >
          Close
        </Button>
        <Button
          type="button"
          variant="destructive"
          onClick={() => {
            dialog.close();
            onAction(session, title, trigger);
          }}
        >
          Sign out
        </Button>
      </div>
    </>,
  );
  dialog.showModal();
}

function SessionCard({ session, onAction }) {
  const { brand, title, mobile } = deviceIdentity(session.device || "");
  return (
    <div className="session-card">
      <Button
        type="button"
        className="session-device-button"
        aria-haspopup="dialog"
        title="View session details"
        onClick={(e) => viewDetails(session, title, onAction, e.currentTarget)}
      >
        <SessionBrowserIcon browser={brand} mobile={mobile} />
        <span className="session-identity">
          <strong>{title}</strong>
          <span className="session-meta">
            {session.current ? (
              <span className="session-current">Current session</span>
            ) : (
              lastActivity(session.lastUsedAt)
            )}
            {" · "}
            <span>{session.ipAddress || "IP unavailable"}</span>
          </span>
        </span>
        <span className="sr-only">View session details</span>
      </Button>
      <Button
        type="button"
        aria-haspopup="dialog"
        className="session-quiet session-end"
        aria-label={"Sign out " + title}
        onClick={(e) => onAction(session, title, e.currentTarget)}
      >
        Sign out
      </Button>
    </div>
  );
}

export function renderSessions(container, sessions, onAction, notice) {
  const current = sessions.find((s) => s.current);
  const others = sessions.filter((s) => !s.current);
  renderRegion(
    container,
    notice ? (
      <p className="muted">{notice}</p>
    ) : sessions.length ? (
      <>
        {current && <SessionCard session={current} onAction={onAction} />}
        <h2 className="session-others-title" id="session-others-title">
          {others.length} other {others.length === 1 ? "session" : "sessions"}
        </h2>
        {others.length ? (
          <ul
            className="session-others-list"
            aria-labelledby="session-others-title"
          >
            {others.map((session) => (
              <li key={session.id}>
                <SessionCard session={session} onAction={onAction} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Only this browser is signed in.</p>
        )}
      </>
    ) : null,
  );
}

export function SessionsPanel() {
  return (
    <section
      className="settings-feature sessions-settings"
      data-settings-panel="sessions"
      aria-labelledby="sessions-title"
      hidden
    >
      <header className="sessions-titlebar">
        <div>
          <h1 id="sessions-title" tabIndex="-1">
            Sessions
          </h1>
          <p>Browsers signed in to Pocketmark.</p>
        </div>
        <Button
          type="button"
          id="sessions-others"
          variant="outline"
          aria-haspopup="dialog"
          disabled
        >
          Sign out all other sessions
        </Button>
      </header>
      <div id="sessions-list" />
      <div className="sessions-footer">
        <Button
          type="button"
          id="session-idle-open"
          className="session-quiet"
          aria-haspopup="dialog"
          title="Edit inactivity timeout"
          disabled
        >
          Inactivity timeout <span aria-hidden="true">·</span>{" "}
          <strong id="session-idle-value" /> <Icon name="edit" />
        </Button>
        <Button type="button" id="sessions-refresh" className="session-quiet">
          <Icon name="refresh" />
          Refresh sessions
        </Button>
      </div>
      <p id="sessions-feedback" className="small muted" role="status" />
      <p id="sessions-error" className="form-error" role="alert" />
      <dialog
        className="modal compact-modal"
        id="session-details-dialog"
        aria-labelledby="session-details-title"
        onClose={(e) => {
          if (!e.currentTarget.open)
            renderRegion(document.getElementById("session-details-body"), null);
        }}
      >
        <div id="session-details-body" />
      </dialog>
      <dialog
        className="modal compact-modal"
        id="session-idle-dialog"
        aria-labelledby="session-idle-title"
      >
        <header className="dialog-heading">
          <h2 id="session-idle-title">Inactivity timeout</h2>
        </header>
        <form id="session-idle-form">
          <label htmlFor="session-idle">
            Sign out this browser after inactivity
          </label>
          <select id="session-idle" aria-describedby="session-idle-help">
            <option value="15">15 minutes</option>
            <option value="60">1 hour</option>
            <option value="1440">24 hours</option>
            <option value="0">Seven-day expiry only</option>
          </select>
          <p id="session-idle-help" className="small muted">
            Requests from an open library count as activity. Changing this
            setting requires recent password confirmation.
          </p>
          <p id="session-idle-error" className="form-error" role="alert" />
          <div className="dialog-actions">
            <Button type="button" variant="outline" id="session-idle-cancel">
              Cancel
            </Button>
            <Button type="submit" variant="default">
              Save timeout
            </Button>
          </div>
        </form>
      </dialog>
    </section>
  );
}
