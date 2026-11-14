import { Fragment, useState, useEffect, useRef } from "react";
import { renderRegion } from "../../lib/render";
import { Icon } from "../../components/icon";

const base = "/api/backups";
const date = (t, zone) =>
  t
    ? new Date(t).toLocaleString(undefined, {
        timeZone: zone,
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "—";
const size = (n) =>
  n != null
    ? Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(
        n / 1048576,
      ) + " MiB"
    : "—";
const statusNames = {
  queued: "Queued",
  running: "In progress",
  retry: "Retry scheduled",
  failed: "Failed",
  warning: "Retention warning",
  succeeded: "Succeeded",
  cancelled: "Cancelled",
};
const columns = ["Started", "Contents", "Duration", "Size", "Status"];
const options = {
  Text: "Extracted text",
  Archives: "Archived pages and resources",
  Files: "Attachments and thumbnails",
};
function Pager({ page, count, change, compact }) {
  if (count < 2) return null;
  const shown = Array.from({ length: count }, (_, i) => i + 1).filter(
    (n) =>
      n === 1 ||
      n === count ||
      Math.abs(page - n) <= (compact && page > 2 && page < count - 1 ? 0 : 1) ||
      (page <= 2 && n <= 3) ||
      (page >= count - 1 && n >= count - 2),
  );
  return (
    <nav className="backup-pages" aria-label="Backup history pages">
      <button
        disabled={page === 1}
        aria-label="Previous page"
        onClick={() => change(page - 1)}
      >
        ‹
      </button>
      {shown.map((n, i) => (
        <Fragment key={n}>
          {i > 0 &&
            n - shown[i - 1] > 1 &&
            (!compact && n - shown[i - 1] === 2 ? (
              <button
                aria-label={"Page " + (n - 1)}
                onClick={() => change(n - 1)}
              >
                {n - 1}
              </button>
            ) : (
              <span>…</span>
            ))}
          <button
            aria-label={"Page " + n}
            aria-current={n === page ? "page" : undefined}
            onClick={() => change(n)}
          >
            {n}
          </button>
        </Fragment>
      ))}
      <button
        disabled={page === count}
        aria-label="Next page"
        onClick={() => change(page + 1)}
      >
        ›
      </button>
    </nav>
  );
}
function BackupPanel({ api, toast }) {
  const [compact, setCompact] = useState(
    () => window.matchMedia("(max-width: 730px)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(max-width: 730px)");
    const resize = () => setCompact(media.matches);
    media.addEventListener("change", resize);
    return () => media.removeEventListener("change", resize);
  }, []);
  const [data, setData] = useState(null),
    [error, setError] = useState(""),
    [draft, edit] = useState(null),
    [busy, setBusy] = useState(false),
    [page, setPage] = useState(1),
    [open, expand] = useState(null),
    [nexts, setNexts] = useState([]),
    [cronError, setCronError] = useState(""),
    [file, setFile] = useState(null),
    [manifest, setManifest] = useState(null);
  const alive = useRef(true),
    revision = useRef(0),
    upload = useRef(null);
  async function refresh() {
    const i = ++revision.current;
    try {
      const d = await api(base);
      if (alive.current && i === revision.current) {
        setData(d);
        setError("");
      }
    } catch (e) {
      if (alive.current && i === revision.current) setError(e.message);
    }
  }
  useEffect(() => {
    alive.current = true;
    refresh();
    const timer = setInterval(() => {
      if (!document.hidden) refresh();
    }, 5000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [api]);
  const cron = draft?.Cron,
    zone = draft?.Zone;
  useEffect(() => {
    if (cron === undefined) return;
    let current = true;
    setNexts([]);
    setCronError("");
    const timer = setTimeout(async () => {
      try {
        const n = await api(base + "/preview", {
          method: "POST",
          body: JSON.stringify({ Cron: cron, Zone: zone }),
        });
        if (current) setNexts(n);
      } catch (e) {
        if (current) setCronError(e.message);
      }
    }, 300);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [cron, zone, api]);
  const post = (path, obj, method = "POST") =>
    api(base + path, { method, body: obj ? JSON.stringify(obj) : undefined });
  async function action(fn, message) {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      if (alive.current) {
        toast(message);
        await refresh();
      }
    } catch (e) {
      if (alive.current) toast(e.message, true);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  if (!data) return <p role="status">{error || "Loading backup history…"}</p>;
  const c = data.settings,
    runs = data.runs,
    active = runs.find((r) => !r.Finished),
    last = data.lastSuccess
      ? data.lastSuccess * 1000
      : runs.find((r) => ["succeeded", "warning"].includes(r.Status))?.Finished,
    perPage = 3,
    p = Math.min(page, Math.max(1, Math.ceil(runs.length / perPage)));
  const save = (cfg) => post("/settings", cfg, "PUT");
  const change = (key, val) => edit((d) => ({ ...d, [key]: val }));
  const input = (key, label, type = "text", required = true) => (
    <label>
      {label}
      <input
        type={type}
        required={required}
        autoComplete={type === "password" ? "new-password" : "off"}
        value={draft[key] || ""}
        onChange={(e) => change(key, e.target.value)}
      />
    </label>
  );
  const backupNow = () =>
    action(async () => {
      const r = await post("/run");
      setPage(1);
      expand(r.id);
    }, "Backup queued.");
  const generate = () =>
    action(async () => {
      const k = await post("/key");
      if (!alive.current) return;
      const url = URL.createObjectURL(
        new Blob([k.identity + "\n"], { type: "text/plain" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = "pocketmark-backup-private-key.txt";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      change("Recipient", k.recipient);
    }, "Private key downloaded. Store it separately.");
  const restore = async (confirm) => {
    const m = await api(base + "/library" + (confirm ? "?confirm=1" : ""), {
      method: "POST",
      body: file,
      headers: { "Content-Type": "application/zip" },
    });
    if (!alive.current) return;
    if (confirm) {
      setFile(null);
      setManifest(null);
      upload.current.value = "";
    } else setManifest(m);
  };
  const stat = (name, value) => (
    <div>
      <small>{name}</small>
      <strong>{value}</strong>
    </div>
  );
  const state = (r) => (
    <span className={"backup-status " + r.Status}>
      <Icon
        name={
          {
            succeeded: "check-circle",
            failed: "warning",
            warning: "warning",
            retry: "clock",
            running: "refresh",
            cancelled: "pause",
          }[r.Status] || "clock"
        }
      />{" "}
      {statusNames[r.Status] || r.Status}
    </span>
  );
  return (
    <div className="backups">
      {error && <p role="alert">{error}</p>}
      <div className="backup-actions">
        <span className="muted">
          {c.Bucket
            ? c.Bucket + "/" + c.Prefix
            : "No S3 destination configured"}
        </span>
        <button
          className="button subtle"
          disabled={busy}
          onClick={() =>
            edit(draft ? null : { ...c, AccessKey: "", SecretKey: "" })
          }
        >
          {draft ? "Back to history" : "Configure"}
        </button>
        <button
          className="button primary"
          disabled={busy || !!active || !!draft || !c.HasCredentials}
          onClick={backupNow}
        >
          Back up now
        </button>
      </div>
      {draft ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            action(async () => {
              await save(draft);
              edit(null);
            }, "Backup settings saved.");
          }}
        >
          <fieldset disabled={busy}>
            <legend>Schedule</legend>
            <label>
              <input
                type="checkbox"
                checked={draft.Enabled}
                onChange={(e) => change("Enabled", e.target.checked)}
              />{" "}
              Enable scheduled backups
            </label>
            <div className="backup-fields">
              {input("Cron", "Cron expression")}
              <label>
                Time zone
                <select
                  value={draft.Zone}
                  onChange={(e) => change("Zone", e.target.value)}
                >
                  {Array.from(
                    new Set([
                      draft.Zone,
                      "UTC",
                      "Europe/Paris",
                      ...(Intl.supportedValuesOf?.("timeZone") || []),
                    ]),
                  ).map((z) => (
                    <option key={z}>{z}</option>
                  ))}
                </select>
              </label>
            </div>
            <small role="status">
              {cronError || nexts.map((t) => date(t, draft.Zone)).join(" · ")}
            </small>
          </fieldset>
          <fieldset disabled={busy}>
            <legend>S3 destination</legend>
            <div className="backup-fields">
              {input("Endpoint", "Endpoint", "url")}
              {input("Region", "Region")}
              {input("Bucket", "Bucket")}
              {input("Prefix", "Object prefix")}
              {input(
                "AccessKey",
                c.HasCredentials ? "Access key ID (replace)" : "Access key ID",
                "text",
                !c.HasCredentials,
              )}
              {input(
                "SecretKey",
                c.HasCredentials
                  ? "Secret access key (replace)"
                  : "Secret access key",
                "password",
                !c.HasCredentials,
              )}
            </div>
            <label>
              <input
                type="checkbox"
                checked={draft.AllowHTTP}
                onChange={(e) => change("AllowHTTP", e.target.checked)}
              />{" "}
              Allow unencrypted HTTP transport
            </label>
            <button
              type="button"
              className="button primary"
              onClick={() =>
                action(
                  () => post("/test", draft),
                  "Connection successful. Test object written, read and deleted.",
                )
              }
            >
              Test connection
            </button>
          </fieldset>
          <fieldset disabled={busy}>
            <legend>Backup contents</legend>
            <label>
              Backup mode
              <select
                value={draft.Mode}
                onChange={(e) => change("Mode", e.target.value)}
              >
                <option value="full">Full instance</option>
                <option value="library">Custom library</option>
              </select>
            </label>
            <small>
              Bookmark metadata, notes and annotations are always included.
            </small>
            {Object.entries(options).map(([k, label]) => (
              <label key={k}>
                <input
                  type="checkbox"
                  checked={draft.Mode === "full" || draft[k]}
                  disabled={draft.Mode === "full"}
                  onChange={(e) => change(k, e.target.checked)}
                />{" "}
                {label}
              </label>
            ))}
          </fieldset>
          <fieldset disabled={busy}>
            <legend>Retention &amp; encryption</legend>
            <label htmlFor="backup-keep">Successful backups to keep</label>
            <div className="backup-stepper">
              <button
                type="button"
                disabled={draft.Keep <= 1}
                aria-label="Decrease retention"
                onClick={() => change("Keep", Math.max(1, draft.Keep - 1))}
              >
                −
              </button>
              <input
                id="backup-keep"
                required
                type="number"
                min="1"
                max="10000"
                step="1"
                value={draft.Keep}
                onChange={(e) =>
                  change(
                    "Keep",
                    e.target.value === "" ? "" : Number(e.target.value),
                  )
                }
              />
              <button
                type="button"
                aria-label="Increase retention"
                disabled={draft.Keep >= 10000}
                onClick={() => change("Keep", Number(draft.Keep) + 1)}
              >
                +
              </button>
            </div>
            {input("Recipient", "Age public recipient key")}
            <button className="button subtle" type="button" onClick={generate}>
              Generate recovery key
            </button>
            <small>Keep the private key and server secret separately.</small>
          </fieldset>
          <button className="button primary" disabled={busy || !!cronError}>
            Save settings
          </button>
        </form>
      ) : (
        <>
          <div className="backup-summary">
            {stat(
              "Scheduled backups",
              <button
                className="backup-switch"
                role="switch"
                aria-label="Scheduled backups"
                aria-checked={c.Enabled}
                disabled={busy || !c.HasCredentials}
                onClick={() =>
                  action(
                    () => save({ ...c, Enabled: !c.Enabled }),
                    c.Enabled ? "Schedule paused." : "Schedule enabled.",
                  )
                }
              >
                <i />
                {c.Enabled ? "On" : "Off"}
              </button>,
            )}
            {stat(
              "Next scheduled run",
              c.Enabled ? date(c.Next, c.Zone) + " · " + c.Zone : "Paused",
            )}
            {stat(
              "Last successful backup",
              last ? date(last, c.Zone) : "No successful backup yet",
            )}
            {stat("Latest attempt", runs[0] ? state(runs[0]) : "—")}
          </div>
          {active && (
            <p role="status">
              {statusNames[active.Status]} · {active.Stage} ·{" "}
              {active.Total
                ? size(active.Bytes) + " / " + size(active.Total)
                : "Preparing"}{" "}
              · attempt {active.Attempt}
              {active.Stage === "upload" && active.Total > 0 && (
                <progress
                  aria-label="Backup upload"
                  value={active.Bytes}
                  max={active.Total}
                />
              )}
              {active.Status === "retry" && " · " + date(active.Due, c.Zone)}{" "}
              <button
                className="button subtle"
                disabled={busy}
                onClick={() =>
                  action(
                    () => post("/" + active.ID + "/cancel"),
                    "Cancellation requested.",
                  )
                }
              >
                Cancel run
              </button>
            </p>
          )}
          <h3>Recent backups</h3>
          {runs.length === 0 ? (
            <p className="muted">
              No backups yet. Configure a destination to run your first backup.
            </p>
          ) : (
            <>
              <table className="backup-table">
                <thead>
                  <tr>
                    {columns.map((h) => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {runs.slice((p - 1) * perPage, p * perPage).map((r) => (
                    <Fragment key={r.ID}>
                      <tr onClick={() => expand(open === r.ID ? null : r.ID)}>
                        <td>
                          <button
                            aria-expanded={open === r.ID}
                            onClick={(e) => {
                              e.stopPropagation();
                              expand(open === r.ID ? null : r.ID);
                            }}
                          >
                            <Icon name="chevron-right" />{" "}
                            {date(r.Started, c.Zone)}
                          </button>
                        </td>
                        <td>
                          {r.Config.Mode === "full"
                            ? "Full instance"
                            : "Custom library"}
                        </td>
                        <td>
                          {Math.round(
                            ((r.Finished
                              ? Date.parse(r.Finished)
                              : Date.now()) -
                              Date.parse(r.Started)) /
                              1000,
                          )}{" "}
                          s
                        </td>
                        <td>{size(r.Total)}</td>
                        <td>{state(r)}</td>
                      </tr>
                      {open === r.ID && (
                        <tr className="backup-detail">
                          <td colSpan={compact ? 2 : 5}>
                            <dl className="backup-facts">
                              {Object.entries({
                                Started:
                                  date(r.Started, c.Zone) + " · " + c.Zone,
                                Finished: date(r.Finished, c.Zone),
                                Duration:
                                  Math.round(
                                    ((r.Finished
                                      ? Date.parse(r.Finished)
                                      : Date.now()) -
                                      Date.parse(r.Started)) /
                                      1000,
                                  ) + " s",
                                "Archive size": r.Total ? size(r.Total) : "—",
                                Contents:
                                  r.Config.Mode === "full"
                                    ? "Full instance"
                                    : [
                                        "Bookmark metadata",
                                        ...Object.entries(options)
                                          .filter(([k]) => r.Config[k])
                                          .map(([, v]) => v),
                                      ].join(", "),
                                Object: r.ObjectKey
                                  ? r.Config.Bucket + "/" + r.ObjectKey
                                  : "Awaiting verification",
                                ...(r.Removed
                                  ? { Retention: "Archive removed" }
                                  : {}),
                                Trigger: r.Trigger,
                                Attempt: r.Attempt,
                                Stage: r.Stage,
                                ...(r.Status === "retry"
                                  ? { "Next retry": date(r.Due, c.Zone) }
                                  : {}),
                                ...(r.Diagnostic?.error_code
                                  ? { Error: r.Diagnostic.error_code }
                                  : {}),
                              }).map(([label, v]) => (
                                <div key={label}>
                                  <dt>{label}</dt>
                                  <dd>{v}</dd>
                                </div>
                              ))}
                            </dl>
                            <details>
                              <summary>Diagnostic log</summary>
                              <pre>
                                {JSON.stringify(
                                  {
                                    backup_id: r.ID,
                                    diagnostic: r.Diagnostic,
                                    stage_ms: r.Timings,
                                  },
                                  null,
                                  2,
                                )}
                              </pre>
                            </details>
                            <button
                              className="button subtle"
                              onClick={() =>
                                action(
                                  () =>
                                    navigator.clipboard.writeText(
                                      JSON.stringify({
                                        backup_id: r.ID,
                                        ...r.Diagnostic,
                                      }),
                                    ),
                                  "Diagnostic copied.",
                                )
                              }
                            >
                              Copy diagnostic
                            </button>{" "}
                            <button
                              className="button subtle"
                              disabled={busy || !!active}
                              onClick={backupNow}
                            >
                              Run again with current settings
                            </button>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
              <Pager
                compact={compact}
                page={p}
                count={Math.ceil(runs.length / perPage)}
                change={(n) => {
                  expand(null);
                  setPage(n);
                }}
              />
            </>
          )}
          <details>
            <summary>Import a custom library</summary>
            <p>
              Decrypt the ZIP with your private age key. Restore into an empty
              library.
            </p>
            <input
              aria-label="Decrypted library ZIP"
              ref={upload}
              type="file"
              accept=".zip"
              onChange={(e) => {
                setFile(e.target.files[0]);
                setManifest(null);
              }}
            />
            {file && (
              <button
                className="button subtle"
                disabled={busy}
                onClick={() =>
                  action(() => restore(false), "Archive contents checked.")
                }
              >
                Preview contents
              </button>
            )}
            {manifest && (
              <div>
                <p>
                  Includes bookmark metadata and annotations
                  {Object.entries(options)
                    .filter(([k]) => manifest[k])
                    .map(([, v]) => ", " + v)}
                  .
                </p>
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() =>
                    action(() => restore(true), "Library restored.")
                  }
                >
                  Confirm restore
                </button>
              </div>
            )}
          </details>
        </>
      )}
    </div>
  );
}
export function showBackups(node, active, api, toast) {
  if (node)
    renderRegion(node, active ? <BackupPanel api={api} toast={toast} /> : null);
}
