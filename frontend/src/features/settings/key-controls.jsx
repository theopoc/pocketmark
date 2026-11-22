import { Button } from "../../components/ui/button";
import { keyExpired, keyStatus } from "./key-roles";
const dateFormat = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});

export function keyDate(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime())
    ? dateFormat.format(date)
    : "Unavailable";
}

export function AccessSwitch({
  token,
  busy,
  onClick,
  now,
  showStatus = false,
}) {
  const status = keyStatus(token, now);
  return (
    <Button
      type="button"
      className={`ak-toggle ${status.toLowerCase()}`}
      role="switch"
      aria-label={`${showStatus ? status + " · " : ""}Key access for ${token.name}`}
      aria-checked={token.active}
      disabled={busy || (!token.active && keyExpired(token, now))}
      onClick={onClick}
    >
      <span className="ak-track" aria-hidden="true">
        <i />
      </span>
      {showStatus && status}
    </Button>
  );
}
