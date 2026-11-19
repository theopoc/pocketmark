import { Button } from "../../components/ui/button";
import { Icon } from "../../components/icon";
import { renderRegion } from "../../lib/render";
import { SettingsTimestamp } from "./timestamp";
import "./sessions.css";

function deviceName(device) {
  if (!device) return "Unknown browser";
  const browser = [
    /Edg(?:e|A|iOS)?\//,
    /(?:Firefox|FxiOS)\//,
    /(?:Chrome|CriOS)\//,
    /Safari\//,
  ];
  const names = ["Edge", "Firefox", "Chrome", "Safari"];
  const agent =
    names[browser.findIndex((pattern) => pattern.test(device))] || "Browser";
  const platform = [
    "Android",
    "iPhone",
    "iPad",
    "Windows",
    "Macintosh",
    "Linux",
  ].find((name) => device.includes(name));
  return platform
    ? agent + " on " + (platform === "Macintosh" ? "macOS" : platform)
    : agent;
}

function SessionCard({ session, onAction }) {
  const title = deviceName(session.device);
  const action = (
    <Button
      type="button"
      variant="outline"
      aria-label={session.current ? "Sign out this browser" : "Revoke " + title}
      onClick={(e) => onAction(session, title, e.currentTarget)}
    >
      {session.current ? "Sign out this browser" : "Revoke"}
    </Button>
  );
  return (
    <li className="session-card">
      <div className="session-card-heading">
        <span className="session-card-icon">
          <Icon
            name={
              /iPhone|iPad|Android/i.test(session.device) ? "phone" : "monitor"
            }
          />
        </span>
        <h3>{title}</h3>
        {session.current ? (
          <span className="session-card-current">This browser</span>
        ) : (
          action
        )}
      </div>
      <dl className="session-card-metadata">
        <div>
          <dt>IP address</dt>
          <dd>
            {session.ipAddress ? (
              <code>{session.ipAddress}</code>
            ) : (
              "Unavailable"
            )}
          </dd>
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
      {(session.device || session.current) && (
        <details className="session-card-details">
          <summary>Browser details</summary>
          {session.device && <p>{session.device}</p>}
          {session.current && action}
        </details>
      )}
    </li>
  );
}

export function renderSessions(container, sessions, onAction, notice) {
  renderRegion(
    container,
    notice ? (
      <li className="muted">{notice}</li>
    ) : (
      sessions.map((session) => (
        <SessionCard key={session.id} session={session} onAction={onAction} />
      ))
    ),
  );
}
