import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { renderRegion } from "../../lib/render";
import { Icon } from "../../components/icon";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { createLifecycle } from "../../lib/lifecycle";
import { bindDialogBackdrop } from "../../lib/dialog-backdrop";
import { backupZoneGroups, savedZoneLabel } from "./backup-zones";
import { Picker } from "../../components/ui/picker";
import "./backups.css";

const base = "/api/backups";
const BackupErrors = createContext("");
const contents = {
  Text: "Extracted text",
  Archives: "Archived pages and resources",
  Files: "Attachments and thumbnails",
};
const stages = {
  prepare: "Prepare snapshot",
  encrypt: "Encrypt archive",
  upload: "Upload to storage",
  verify: "Verify remote copy",
  retention: "Apply retention",
};
const statuses = {
  queued: "Queued",
  running: "In progress",
  retry: "Awaiting retry",
  failed: "Failed",
  succeeded: "Succeeded",
  cancelled: "Cancelled",
  warning: "Retention warning",
  skipped: "Skipped",
};
const configFields = [
  "Revision",
  "Enabled",
  "Cron",
  "Zone",
  "WindowMinutes",
  "RetentionDays",
  "Mode",
  "Text",
  "Archives",
  "Files",
  "Endpoint",
  "Region",
  "Bucket",
  "Prefix",
  "AllowHTTP",
  "AccessKey",
  "SecretKey",
  "TelegramToken",
  "TelegramChatID",
  "ClearTelegram",
];
const modeName = (mode) =>
  mode === "library" ? "Custom library" : "Full instance";
const sourceName = (run) => (run.Trigger === "manual" ? "Manual" : "Scheduled");
function timeValue(value) {
  if (!value || String(value).startsWith("0001-")) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
function date(value, zone) {
  const d = timeValue(value);
  if (!d) return "—";
  try {
    return d.toLocaleString(undefined, {
      timeZone: zone || undefined,
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return d.toISOString();
  }
}
function duration(run) {
  const start = timeValue(run.Started),
    end = timeValue(run.Finished);
  if (!start || !end) return "—";
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  return seconds < 60
    ? seconds + " s"
    : Math.floor(seconds / 60) + " m " + (seconds % 60) + " s";
}
function cronTitle(cron) {
  const daily = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(cron);
  return daily
    ? "Daily at " + daily[2].padStart(2, "0") + ":" + daily[1].padStart(2, "0")
    : cron;
}
const windowLabel = (minutes) =>
  minutes % 60 === 0 ? minutes / 60 + "h" : minutes + " min";
const size = (bytes) =>
  Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(
    bytes / 1048576,
  ) + " MiB";
const payload = (d) =>
  Object.fromEntries(
    configFields.filter((k) => d[k] !== undefined).map((k) => [k, d[k]]),
  );
function Action({ children, icon, primary = false, ...props }) {
  return (
    <Button type="button" variant={primary ? "default" : "outline"} {...props}>
      {icon && <Icon name={icon} />} {children}
    </Button>
  );
}
function Badge({ status }) {
  const icon =
    {
      succeeded: "check-circle",
      failed: "warning",
      warning: "warning",
      running: "refresh",
      cancelled: "pause",
    }[status] || "clock";
  return (
    <span className={"bk-badge bk-" + status}>
      <Icon name={icon} />
      {statuses[status] || status}
    </span>
  );
}
function Modal({ title, busy, close, children }) {
  const ref = useRef(null),
    error = useContext(BackupErrors);
  useLayoutEffect(() => {
    const node = ref.current,
      opener = document.activeElement,
      lifecycle = createLifecycle();
    bindDialogBackdrop(node, lifecycle);
    node.showModal();
    return () => {
      lifecycle.dispose();
      if (node.open) node.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal bk-dialog"
      aria-labelledby="bk-dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) close();
      }}
    >
      <header className="bk-modal-head">
        <h2 id="bk-dialog-title">{title}</h2>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Close dialog"
          disabled={busy}
          onClick={close}
        >
          <Icon name="close" />
        </Button>
      </header>
      {error && (
        <p className="bk-modal-error form-error" role="alert">
          {error}
        </p>
      )}
      {children}
    </dialog>
  );
}
function History({ runs, zone, inspect }) {
  const [page, setPage] = useState(0),
    [filter, setFilter] = useState("All runs");
  const filtered = runs.filter(
    (r) =>
      filter === "All runs" ||
      (filter === "Failed" ? r.Status === "failed" : sourceName(r) === filter),
  );
  const count = Math.max(1, Math.ceil(filtered.length / 4)),
    at = Math.min(page, count - 1);
  return (
    <section aria-labelledby="bk-history">
      <header className="bk-section-head">
        <div>
          <h2 id="bk-history">Backup history</h2>
          <p>Most recent remote runs</p>
        </div>
        <Picker
          label="Filter backup history"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setPage(0);
          }}
        >
          {["All runs", "Scheduled", "Manual", "Failed"].map((f) => (
            <option key={f}>{f}</option>
          ))}
        </Picker>
      </header>
      <div className="bk-history-box">
        <table className="bk-table" aria-labelledby="bk-history">
          <thead>
            <tr>
              {["Backup ID", "Source", "Duration", "Result", "Started"].map(
                (title) => (
                  <th scope="col" key={title}>
                    {title}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {filtered.slice(at * 4, at * 4 + 4).map((r) => (
              <tr key={r.ID}>
                <td>
                  <button
                    className="bk-id"
                    title={r.ID}
                    aria-label={"Details for " + r.ID}
                    aria-haspopup="dialog"
                    onClick={() => inspect(r.ID)}
                  >
                    {r.ID}
                  </button>
                  <small>{modeName(r.Config.Mode)}</small>
                </td>
                <td>{sourceName(r)}</td>
                <td>{duration(r)}</td>
                <td>
                  <Badge status={r.Status} />
                </td>
                <td>
                  {timeValue(r.Started) ? (
                    <time dateTime={r.Started}>{date(r.Started, zone)}</time>
                  ) : (
                    <span aria-label="Not started">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!filtered.length && (
          <p className="bk-empty">
            {runs.length ? "No matching backups." : "No remote backups yet."}
          </p>
        )}
        <nav className="bk-pages" aria-label="Backup history pages">
          <span>
            {filtered.length
              ? at * 4 +
                1 +
                "–" +
                Math.min((at + 1) * 4, filtered.length) +
                " of " +
                filtered.length
              : "0 runs"}
          </span>
          <div>
            <button
              aria-label="Previous history page"
              disabled={at === 0}
              onClick={() => setPage(at - 1)}
            >
              ‹
            </button>
            <span>
              {at + 1} / {count}
            </span>
            <button
              aria-label="Next history page"
              disabled={at + 1 >= count}
              onClick={() => setPage(at + 1)}
            >
              ›
            </button>
          </div>
        </nav>
      </div>
    </section>
  );
}
const notificationNames = {
  not_required: "Not required",
  disabled: "Disabled",
  pending: "Pending",
  sent: "Delivered",
  failed: "Delivery failed",
  unknown: "Delivery unconfirmed",
};
function StageList({ run }) {
  const entries = Object.entries(stages);
  const current = entries.findIndex(([key]) => key === run.Stage);
  if (!timeValue(run.Started)) return null;
  return (
    <ol className="bk-stages" aria-label="Backup stages">
      {entries.map(([key, label], i) => {
        let state = run.Finished ? "Not reached" : "Pending";
        if (i < current || run.Status === "succeeded") state = "Complete";
        else if (i === current) state = statuses[run.Status] || run.Status;
        return (
          <li key={key}>
            <Icon
              name={
                state === "Complete"
                  ? "check-circle"
                  : state === "Failed"
                    ? "warning"
                    : "clock"
              }
            />
            <span>{label}</span>
            <small>{state}</small>
          </li>
        );
      })}
    </ol>
  );
}
function RunDetails({
  run: r,
  zone,
  busy,
  cancel,
  backupNow,
  configured,
  perform,
}) {
  const verified = timeValue(r.VerifiedAt);
  const facts = [
    ["Format", modeName(r.Config.Mode)],
    ["Requested", date(r.Requested, zone)],
    ["Started", date(r.Started, zone)],
    [
      "Window ends",
      timeValue(r.Deadline)
        ? date(r.Deadline, zone)
        : "Set when the run starts",
    ],
    ...(r.Finished ? [["Finished", date(r.Finished, zone)]] : []),
    [
      "Destination",
      [r.Config.Bucket, r.ObjectKey || r.Config.Prefix]
        .filter(Boolean)
        .join("/"),
    ],
    ["Attempt", r.Attempt],
    ...(r.Status === "skipped"
      ? [
          [
            "Reason",
            r.Diagnostic?.error_code === "overlap"
              ? "Another backup was active"
              : r.Diagnostic?.error_code,
          ],
        ]
      : []),
    ...(r.Status === "retry" ? [["Next retry", date(r.Due, zone)]] : []),
    ...(r.Total > 0 ? [["Archive size", size(r.Total)]] : []),
    [
      "Remote copy",
      r.Removed
        ? "Removed by retention"
        : verified
          ? "SHA-256 verified · " + date(r.VerifiedAt, zone)
          : r.Finished
            ? "Not verified"
            : "Verification pending",
    ],
    [
      "Telegram",
      notificationNames[r.Notification] || r.Notification || "No notification",
    ],
  ];
  return (
    <div className="bk-body">
      <div className="bk-run-heading">
        <span>{sourceName(r)} backup</span>
        <Badge status={r.Status} />
      </div>
      <h3 className="bk-full-id">{r.ID}</h3>
      {r.Status === "failed" && (
        <div className="bk-problem">
          <strong>
            {r.Stage === "retention" ? "Retention failed" : "Backup failed"}
          </strong>
          <p>
            {(r.Stage === "retention" && verified
              ? "The new remote copy was verified. "
              : "") +
              (r.Diagnostic?.error_code ||
                "Inspect the diagnostic log for this run.")}
          </p>
        </div>
      )}
      <dl className="bk-facts">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {r.Status === "running" && r.Stage === "upload" && r.Total > 0 && (
        <label>
          Upload progress <progress value={r.Bytes} max={r.Total} />
        </label>
      )}
      <StageList run={r} />
      <details className="bk-diagnostics">
        <summary>Diagnostic log</summary>
        <pre>
          {JSON.stringify(
            { backup_id: r.ID, diagnostic: r.Diagnostic, stage_ms: r.Timings },
            null,
            2,
          )}
        </pre>
        <Action
          disabled={busy}
          onClick={() =>
            perform(
              () =>
                navigator.clipboard.writeText(
                  JSON.stringify(
                    {
                      backup_id: r.ID,
                      diagnostic: r.Diagnostic,
                      stage_ms: r.Timings,
                    },
                    null,
                    2,
                  ),
                ),
              "Diagnostic copied.",
            )
          }
        >
          Copy diagnostic
        </Action>
      </details>
      <div className="bk-actions">
        {r.Finished ? (
          <Action disabled={busy || !configured} onClick={backupNow}>
            Run again with current settings
          </Action>
        ) : (
          <Action disabled={busy} onClick={() => cancel(r.ID)}>
            Cancel run
          </Action>
        )}
      </div>
    </div>
  );
}
function Field({ label, managed, help, children }) {
  return (
    <label className="bk-field">
      <span>
        {label}
        {managed && (
          <small className="bk-env">
            <Icon name="lock" />
            Environment
          </small>
        )}
      </span>
      {children}
      {help && <small>{help}</small>}
    </label>
  );
}
function CronPreview({ api, cron, zone }) {
  const [result, setResult] = useState(null);
  useEffect(() => {
    const request = new AbortController();
    setResult(null);
    if (!zone || !cron) return;
    const timer = setTimeout(async () => {
      try {
        const times = await api(base + "/preview", {
          method: "POST",
          signal: request.signal,
          body: JSON.stringify({ Cron: cron, Zone: zone }),
        });
        if (!request.signal.aborted) setResult({ times });
      } catch (e) {
        if (!request.signal.aborted) setResult({ error: e.message });
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      request.abort();
    };
  }, [api, cron, zone]);
  return (
    <div className="bk-upcoming">
      <Icon name="clock" />
      <div>
        <strong>Next three runs</strong>
        <p role="status">
          {result?.times?.map((t) => <span key={t}>{date(t, zone)}</span>) ||
            result?.error ||
            (zone ? "Checking schedule…" : "Choose a time zone.")}
        </p>
      </div>
    </div>
  );
}

function Configure({ config, api, busy, perform, post, close }) {
  const [draft, setDraft] = useState(() => ({
    ...config,
    AccessKey: "",
    SecretKey: "",
    TelegramToken: "",
  }));
  const [section, setSection] = useState("Schedule"),
    [alerts, setAlerts] = useState(
      Boolean(config.HasTelegramToken || config.TelegramChatID),
    ),
    [feedback, setFeedback] = useState("");
  const zones = useMemo(
    () => backupZoneGroups(document.documentElement.lang || "en"),
    [],
  );
  const managed = config.Managed || {};
  function change(key, value) {
    setDraft((d) => ({ ...d, [key]: value }));
    setFeedback("");
  }
  const body = () =>
    payload({
      ...draft,
      Enabled: config.Enabled,
      WindowMinutes: Number(draft.WindowMinutes),
      RetentionDays: Number(draft.RetentionDays),
      TelegramToken: alerts ? draft.TelegramToken : "",
      TelegramChatID: alerts ? draft.TelegramChatID : "",
      ClearTelegram:
        !alerts && !!(config.HasTelegramToken || config.TelegramChatID),
    });
  function input(
    key,
    label,
    {
      type = "text",
      help,
      placeholder,
      stored = false,
      disabled = false,
      ...attributes
    } = {},
  ) {
    return (
      <Field label={label} managed={managed[key]} help={help}>
        <Input
          type={type}
          value={draft[key] ?? ""}
          readOnly={!!managed[key]}
          disabled={disabled}
          autoComplete={type === "password" ? "new-password" : "off"}
          placeholder={
            stored
              ? managed[key]
                ? "Configured"
                : "Configured · enter to replace"
              : placeholder
          }
          onChange={(e) => change(key, e.target.value)}
          {...attributes}
        />
      </Field>
    );
  }
  function check(key, label) {
    return (
      <label className="bk-check" key={key}>
        <input
          type="checkbox"
          checked={!!draft[key]}
          disabled={!!managed[key]}
          onChange={(e) => change(key, e.target.checked)}
        />
        {label}
        {managed[key] && <small>Environment</small>}
      </label>
    );
  }
  async function probe(path, message) {
    setFeedback("");
    const result = await perform(() => post(path, body()));
    if (result) setFeedback(message);
  }
  async function save(e) {
    e.preventDefault();
    const saved = await perform(
      () => post("/settings", body(), "PUT"),
      "Backup settings saved.",
    );
    if (saved) close();
  }
  return (
    <Modal title="Configure remote backups" close={close} busy={busy}>
      <form onSubmit={save} aria-busy={busy}>
        <nav className="bk-form-nav" aria-label="Configuration sections">
          {["Schedule", "Storage", "Telegram"].map((n) => (
            <button
              type="button"
              key={n}
              aria-pressed={section === n}
              onClick={() => {
                setSection(n);
                setFeedback("");
              }}
            >
              {n}
            </button>
          ))}
        </nav>
        <fieldset className="bk-body bk-form" disabled={busy}>
          <legend className="sr-only">{section}</legend>
          {section === "Schedule" ? (
            <>
              <div className="bk-two">
                {input("Cron", "Cron expression", {
                  help: "Minute · hour · day · month · weekday",
                  required: true,
                  maxLength: 128,
                })}
                <Field label="Time zone" managed={managed.Zone}>
                  <Picker
                    label="Time zone"
                    required={draft.Enabled}
                    disabled={!!managed.Zone}
                    value={draft.Zone || ""}
                    onChange={(e) => change("Zone", e.target.value)}
                  >
                    <option value="" disabled>
                      Choose a country and city
                    </option>
                    {draft.Zone &&
                      !zones.some((group) =>
                        group.options.some((o) => o.value === draft.Zone),
                      ) && (
                        <option value={draft.Zone}>
                          {savedZoneLabel(draft.Zone)}
                        </option>
                      )}
                    {zones.map((group) => (
                      <optgroup
                        key={group.options[0].value}
                        label={group.label}
                      >
                        {group.options.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </Picker>
                </Field>
              </div>
              <CronPreview api={api} cron={draft.Cron} zone={draft.Zone} />
              <div className="bk-two">
                {input("WindowMinutes", "Execution window (minutes)", {
                  type: "number",
                  min: 1,
                  step: 1,
                  required: true,
                  help: "Includes retries and retention.",
                })}
                {input("RetentionDays", "Retention (days)", {
                  type: "number",
                  min: 1,
                  step: 1,
                  required: true,
                  help: "Keep all copies verified within this period.",
                })}
              </div>
              <Field label="Backup contents" managed={managed.Mode}>
                <Picker
                  label="Backup contents"
                  value={draft.Mode}
                  disabled={!!managed.Mode}
                  onChange={(e) => change("Mode", e.target.value)}
                >
                  <option value="full">Full instance</option>
                  <option value="library">Custom library</option>
                </Picker>
              </Field>
              {draft.Mode === "library" ? (
                <fieldset className="bk-content-options">
                  <legend>Include with bookmark metadata</legend>
                  {Object.entries(contents).map(([key, label]) =>
                    check(key, label),
                  )}
                  <small>
                    Restores the selected content into an empty library.
                  </small>
                </fieldset>
              ) : (
                <p className="bk-hint">
                  Restores the database, captures, attachments and account with
                  the original server secret.
                </p>
              )}
            </>
          ) : section === "Storage" ? (
            <>
              {input("Endpoint", "S3 API endpoint", {
                type: "url",
                placeholder: "https://s3.example.com",
              })}
              <div className="bk-two">
                {input("Bucket", "Bucket")}
                {input("Region", "Signing region")}
              </div>
              {input("Prefix", "Object prefix")}
              <div className="bk-two">
                {input("AccessKey", "Access key ID", {
                  type: "password",
                  stored: config.HasCredentials || managed.AccessKey,
                })}
                {input("SecretKey", "Secret access key", {
                  type: "password",
                  stored: config.HasCredentials || managed.SecretKey,
                })}
              </div>
              {check("AllowHTTP", "Allow HTTP for a private endpoint")}
              <Action
                icon="refresh"
                onClick={() =>
                  probe(
                    "/test",
                    "Connection verified. A test object was written, read and deleted.",
                  )
                }
              >
                Test connection
              </Action>
            </>
          ) : (
            <>
              <label className="bk-check">
                <input
                  type="checkbox"
                  checked={alerts}
                  disabled={!!(managed.TelegramToken || managed.TelegramChatID)}
                  onChange={(e) => {
                    setAlerts(e.target.checked);
                    setFeedback("");
                  }}
                />
                Send failure alerts
              </label>
              {input("TelegramToken", "Bot token", {
                type: "password",
                stored: config.HasTelegramToken || managed.TelegramToken,
                disabled: !alerts,
                required: alerts && !config.HasTelegramToken,
              })}
              {input("TelegramChatID", "Chat ID", {
                disabled: !alerts,
                required: alerts,
              })}
              <p className="bk-hint">
                Telegram sends one alert per failed run, including retention
                failures. Run details show the delivery status.
              </p>
              <Action
                icon="external"
                disabled={
                  !alerts ||
                  !draft.TelegramChatID ||
                  !(config.HasTelegramToken || draft.TelegramToken)
                }
                onClick={() =>
                  probe("/telegram/test", "Telegram test message sent.")
                }
              >
                Send test message
              </Action>
            </>
          )}
          {feedback && (
            <p className="bk-feedback" role="status">
              <Icon name="check-circle" />
              {feedback}
            </p>
          )}
        </fieldset>
        <footer className="bk-footer">
          <Action disabled={busy} onClick={close}>
            Cancel
          </Action>
          <Button type="submit" variant="default" disabled={busy}>
            Save settings
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
function Recovery({ busy, perform, request, close }) {
  const [file, setFile] = useState(null),
    [manifest, setManifest] = useState(null);
  const upload = useRef(null);
  async function restore(confirm) {
    await perform(
      async () => {
        const result = await request(
          "/library" + (confirm ? "?confirm=1" : ""),
          {
            method: "POST",
            body: file,
            headers: { "Content-Type": "application/zip" },
          },
        );
        if (confirm) {
          setManifest(null);
          setFile(null);
          if (upload.current) upload.current.value = "";
        } else setManifest(result);
      },
      confirm ? "Library restored." : "Archive contents checked.",
    );
  }
  return (
    <Modal title="Download & restore" busy={busy} close={close}>
      <div className="bk-body bk-recovery-body">
        <h3>Download a local copy</h3>
        <p>
          Download a full ZIP of your instance. Pocketmark records remote runs
          separately in backup history.
        </p>
        <a className="button subtle" href="/api/backup">
          <Icon name="download" />
          Download full backup
        </a>
        <hr />
        <h3>Restore a remote backup</h3>
        <ol>
          <li>Retrieve the verified object from your S3 or Garage bucket.</li>
          <li>
            Decrypt the object offline with the Pocketmark server secret used
            when the backup was created.
          </li>
          <li>
            For a full instance, stop Pocketmark and follow the ZIP’s RESTORE
            instructions using an empty PostgreSQL database and the original
            server secret.
          </li>
        </ol>
        <a
          href="https://github.com/theopoc/pocketmark/blob/main/docs/GUIDE.md#recover-a-remote-backup"
          target="_blank"
          rel="noreferrer"
        >
          Read the recovery guide <Icon name="external" />
        </a>
        <hr />
        <h3>Import a custom library</h3>
        <p>
          Select a decrypted custom library ZIP to restore into an empty
          library.
        </p>
        <Field label="Decrypted library ZIP">
          <input
            type="file"
            accept=".zip,application/zip"
            ref={upload}
            disabled={busy}
            onChange={(e) => {
              setFile(e.target.files[0] || null);
              setManifest(null);
            }}
          />
        </Field>
        {file && !manifest && (
          <Action disabled={busy} onClick={() => restore(false)}>
            Preview contents
          </Action>
        )}
        {manifest && (
          <>
            <p role="status">
              Includes bookmark metadata and annotations
              {Object.entries(contents)
                .filter(([k]) => manifest[k])
                .map(([, label]) => ", " + label.toLowerCase())}
              .
            </p>
            <Action primary disabled={busy} onClick={() => restore(true)}>
              Confirm restore
            </Action>
          </>
        )}
      </div>
      <footer className="bk-footer">
        <Action disabled={busy} onClick={close}>
          Close
        </Action>
      </footer>
    </Modal>
  );
}

function Heading({ disabled, onClick }) {
  return (
    <header className="bk-head">
      <div>
        <h1 id="backup-title" tabIndex="-1">
          Backup &amp; restore
        </h1>
        <p>Manage remote backups and recover your library.</p>
      </div>
      <Action primary icon="upload" disabled={disabled} onClick={onClick}>
        Back up now
      </Action>
    </header>
  );
}
function BackupPanel({ api, toast }) {
  const [data, setData] = useState(null),
    [error, setError] = useState(""),
    [mutationError, setMutationError] = useState(""),
    [dialog, setDialog] = useState(null),
    [busy, setBusy] = useState(false);
  const lifetime = useRef(null),
    revision = useRef(0),
    locked = useRef(false);
  const request = useCallback(
    (path, options) =>
      api(base + path, { ...options, signal: lifetime.current.signal }),
    [api],
  );
  const refresh = useCallback(async () => {
    const signal = lifetime.current.signal,
      id = ++revision.current;
    try {
      const state = await request("");
      if (!signal.aborted && id === revision.current) {
        setData(state);
        setError("");
      }
    } catch (e) {
      if (!signal.aborted && id === revision.current) setError(e.message);
    }
  }, [request]);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    let timer;
    async function poll() {
      if (!document.hidden) await refresh();
      if (!controller.signal.aborted) timer = setTimeout(poll, 5000);
    }
    poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [refresh]);
  async function perform(operation, message) {
    if (locked.current) return false;
    const signal = lifetime.current.signal;
    locked.current = true;
    setBusy(true);
    setMutationError("");
    try {
      await operation();
      if (signal.aborted) return false;
      if (message) toast(message);
      await refresh();
      return !signal.aborted;
    } catch (e) {
      if (!signal.aborted) setMutationError(e.message);
      return false;
    } finally {
      locked.current = false;
      if (!signal.aborted) setBusy(false);
    }
  }
  const post = (path, body, method = "POST") =>
    request(path, { method, body: body ? JSON.stringify(body) : undefined });
  function open(view) {
    setMutationError("");
    setDialog(view);
  }
  if (!data)
    return (
      <BackupErrors.Provider value="">
        <div className="bk">
          <Heading disabled />
          <p role={error ? "alert" : "status"}>
            {error || "Loading backup history…"}
          </p>
          {error && <Action onClick={refresh}>Retry</Action>}
        </div>
      </BackupErrors.Provider>
    );
  const c = data.settings,
    runs = data.runs || [],
    configured = Boolean(
      c.HasCredentials && c.Endpoint && c.Bucket && !c.SetupError,
    );
  const last = data.lastSuccess
    ? Number(data.lastSuccess) * 1000
    : runs.find((r) => r.Status === "succeeded")?.Finished;
  const active = runs.find(
    (r) => r.Status === "running" || r.Status === "retry",
  );
  const queued = runs.find(
    (r) => r.Status === "queued" && r.Trigger === "manual",
  );
  const live = active || queued;
  const selected = runs.find((r) => r.ID === dialog?.id);
  const backupNow = () =>
    perform(
      () => post("/run"),
      queued ? "Manual backup already queued." : "Manual backup requested.",
    );
  const toggle = () =>
    perform(
      () => post("/settings", payload({ ...c, Enabled: !c.Enabled }), "PUT"),
      c.Enabled ? "Schedule paused." : "Schedule enabled.",
    );
  const inspect = (id) => open({ id });
  const close = () => open(null);
  return (
    <BackupErrors.Provider value={mutationError}>
      <div className="bk">
        <Heading disabled={busy || !configured} onClick={backupNow} />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {mutationError && !dialog && (
          <p className="form-error" role="alert">
            {mutationError}
          </p>
        )}
        <section className="bk-schedule" aria-label="Backup schedule">
          <div className="bk-schedule-main">
            <div className="bk-schedule-top">
              <span>
                <Icon name="clock" />
                Backup schedule
              </span>
              <div>
                {c.Managed?.Enabled && (
                  <small className="bk-env">
                    <Icon name="lock" />
                    Environment
                  </small>
                )}
                <button
                  className="bk-switch"
                  type="button"
                  role="switch"
                  aria-label="Scheduled backups"
                  aria-checked={c.Enabled}
                  disabled={
                    busy ||
                    c.Managed?.Enabled ||
                    (!c.Enabled && (!configured || !c.Zone))
                  }
                  onClick={toggle}
                >
                  <span className="bk-track">
                    <i />
                  </span>
                  {c.Enabled ? "Enabled" : "Paused"}
                </button>
              </div>
            </div>
            <h2>
              {c.SetupError
                ? "Needs configuration"
                : c.Enabled
                  ? cronTitle(c.Cron)
                  : "Schedule paused"}
            </h2>
            {c.SetupError && (
              <p role="status" className="bk-setup-error">
                The schedule is suspended until configuration is complete.{" "}
                {c.SetupError}
              </p>
            )}
            <p>
              {c.Zone || "Choose a time zone"} · {windowLabel(c.WindowMinutes)}{" "}
              window · {modeName(c.Mode)}
            </p>
            <div className="bk-hero-bottom">
              <Action
                icon="settings"
                aria-haspopup="dialog"
                onClick={() => open("configure")}
              >
                Configure
              </Action>
              <small>
                Next run{" "}
                <strong>
                  {c.SetupError
                    ? "Suspended"
                    : c.Enabled
                      ? date(c.Next, c.Zone)
                      : "Paused"}
                </strong>
              </small>
            </div>
          </div>
          <div className="desk-backup-art" aria-hidden="true" />
        </section>
        <div className="bk-stats">
          {[
            [
              "check-circle",
              "Last successful run",
              last ? date(last, c.Zone) : "None yet",
            ],
            ["folder", "Destination", c.Bucket || "Not configured"],
            [
              "library",
              "Retention",
              c.RetentionDays + " " + (c.RetentionDays === 1 ? "day" : "days"),
            ],
          ].map(([icon, label, value]) => (
            <div key={label}>
              <span>
                <Icon name={icon} />
                {label}
              </span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
        {live && (
          <div className="bk-live">
            <Icon name={active ? "refresh" : "clock"} />
            <div>
              <strong>
                {sourceName(live)} backup · {statuses[live.Status]}
              </strong>
              <small>
                {active
                  ? [
                      stages[active.Stage] || active.Stage,
                      timeValue(active.Deadline)
                        ? "Window ends " + date(active.Deadline, c.Zone)
                        : "",
                      queued ? "1 manual backup queued" : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")
                  : "Waiting to start"}
              </small>
            </div>
            <Action aria-haspopup="dialog" onClick={() => inspect(live.ID)}>
              Details
            </Action>
          </div>
        )}
        <History runs={runs} zone={c.Zone} inspect={inspect} />
        <button
          className="bk-recovery"
          type="button"
          aria-haspopup="dialog"
          onClick={() => open("recovery")}
        >
          <span className="bk-square-icon">
            <Icon name="download" />
          </span>
          <span>
            <strong>Download &amp; restore</strong>
            <small>Local copy and recovery instructions</small>
          </span>
          <Icon name="chevron-right" />
        </button>
        {dialog === "configure" && (
          <Configure {...{ api, busy, perform, post, close }} config={c} />
        )}
        {dialog === "recovery" && (
          <Recovery {...{ busy, perform, request, close }} />
        )}
        {selected && (
          <Modal title="Backup details" busy={busy} close={close}>
            <RunDetails
              run={selected}
              zone={c.Zone}
              {...{ busy, backupNow, configured, perform }}
              cancel={(id) =>
                perform(
                  () => post("/" + encodeURIComponent(id) + "/cancel"),
                  "Cancellation requested.",
                )
              }
            />
          </Modal>
        )}
      </div>
    </BackupErrors.Provider>
  );
}
export function showBackups(node, visible, api, toast) {
  if (node)
    renderRegion(
      node,
      visible ? <BackupPanel api={api} toast={toast} /> : null,
    );
}
