import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Picker } from "../../components/ui/picker";
import { renderRegion } from "../../lib/render";
import "./ai-tagging.css";

const base = "/api/ai-tagging";
const statuses = {
  running: "Scanning",
  paused: "Scan paused",
  completed: "Scan complete",
};
const reasons = {
  quota: "Your ChatGPT plan has reached its usage limit.",
  reconnect:
    "Disconnect the saved ChatGPT plan, then reconnect to continue tagging.",
  error: "Tagging stopped after a provider error.",
};
const bookmarks = (n) => n + (n === 1 ? " bookmark" : " bookmarks");

function SettingRow({ title, description, children }) {
  return (
    <div className="account-setting-row">
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      <div className="account-row-actions">{children}</div>
    </div>
  );
}

function AITagging({ api }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [login, setLogin] = useState("");
  const [callback, setCallback] = useState("");
  const [models, setModels] = useState(null);
  const session = useRef(null);
  const signInLink = useRef(null);
  const version = useRef(0);
  useEffect(() => {
    if (login) signInLink.current?.focus();
  }, [login]);
  const refresh = useCallback(
    async (signal) => {
      const request = ++version.current;
      const state = await api(base, { signal });
      if (!signal.aborted && request === version.current) setData(state);
      return state;
    },
    [api],
  );

  useEffect(() => {
    const controller = new AbortController();
    session.current = controller;
    refresh(controller.signal).catch((err) => {
      if (!controller.signal.aborted) setError(err.message);
    });
    return () => controller.abort();
  }, [refresh]);

  const scan = data?.scan;
  const reason = data?.blocked || scan?.reason;
  const activeScan = ["running", "paused"].includes(scan?.status);
  const pendingNew = (data?.remaining || 0) - (scan?.remaining || 0);
  useEffect(() => {
    if (!data?.enabled || busy || error) return;
    if (!activeScan && !data.remaining) return;
    const { signal } = session.current;
    const request = version.current;
    const timer = setTimeout(() => {
      if (!signal.aborted && request === version.current)
        refresh(signal).catch((err) => {
          if (!signal.aborted) setError(err.message);
        });
    }, 5000);
    return () => clearTimeout(timer);
  }, [data, busy, error, activeScan, refresh]);

  async function action(name, body = {}) {
    if (busy) return;
    const { signal } = session.current;
    version.current++;
    setBusy(name);
    setError("");
    setNotice("");
    try {
      const post = (path, payload) =>
        api(base + "/" + path, {
          method: "POST",
          body: JSON.stringify(payload),
          signal,
        });
      if (name === "refresh") {
        await refresh(signal);
        return;
      }
      const result = await post(name, body);
      if (signal.aborted) return;
      if (name === "connect") {
        const url = new URL(result.url);
        if (
          url.origin !== "https://auth.openai.com" ||
          url.username ||
          url.password
        )
          throw new Error("ChatGPT returned an unexpected sign-in address.");
        setLogin(url.href);
        return;
      }
      if (name === "finish" || name === "disconnect") {
        setLogin("");
        setCallback("");
        setModels(null);
      }
      if (name === "test")
        setNotice("Connection tested with a fictional bookmark.");
      if (name === "models") {
        setModels(result.models);
        return;
      }
      if (name === "model") setNotice("Model saved.");
      await refresh(signal);
      if (name === "finish" && !signal.aborted) {
        const catalog = await post("models", {});
        if (!signal.aborted) setModels(catalog.models);
      }
    } catch (err) {
      if (signal.aborted) return;
      let message =
        err.status === 502
          ? "The ChatGPT request failed. Check the connection and try again."
          : err.message;
      if (name === "disconnect") {
        try {
          const current = await refresh(signal);
          if (!current.connected && !current.connectionIssue) {
            setLogin("");
            setCallback("");
            setModels(null);
            message =
              "Disconnected from Pocketmark. Check connected apps in ChatGPT to revoke any remaining access.";
          }
        } catch {
          // Keep the error and let the owner refresh the connection status.
        }
      }
      if (!signal.aborted) setError(message);
    } finally {
      if (!signal.aborted) setBusy("");
    }
  }

  const disabled = Boolean(busy);
  const ready = data?.connected && data.model;
  const canResume = data?.enabled && (reason === "quota" || reason === "error");
  const retryTime = scan?.resumeAt && new Date(scan.resumeAt);
  const savedModel =
    models?.find((m) => m.id === data?.model)?.name || data?.model;
  return (
    <div className="ai-settings">
      <p role="alert" className="form-error">
        {error}
      </p>
      {!data && !error && <p role="status">Loading tagging settings…</p>}
      {error && (
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={() => action("refresh")}
        >
          Refresh status
        </Button>
      )}
      {data && (
        <>
          <SettingRow
            title="ChatGPT plan"
            description={
              data.connectionIssue
                ? "The saved connection could not be read. Disconnect it, then connect ChatGPT again."
                : data.connected
                  ? "Connected to ChatGPT."
                  : "Connect your account to use its plan allowance."
            }
          >
            {!data.connected && !data.connectionIssue && !login && (
              <>
                <Button
                  type="button"
                  variant="default"
                  disabled={disabled}
                  onClick={() => action("connect")}
                >
                  {data.registered || reason === "reconnect"
                    ? "Reconnect ChatGPT"
                    : "Connect ChatGPT"}
                </Button>
                {data.registered && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={disabled}
                    onClick={() => action("connect", { newAccount: true })}
                  >
                    Use another ChatGPT account
                  </Button>
                )}
              </>
            )}
            {(data.connected || data.connectionIssue) && (
              <Button
                type="button"
                variant="outline"
                disabled={disabled}
                onClick={() => action("disconnect")}
              >
                Disconnect
              </Button>
            )}
          </SettingRow>
          {login && (
            <form
              className="ai-connect"
              onSubmit={(event) => {
                event.preventDefault();
                const value = callback.trim();
                setCallback("");
                action("finish", { callback: value });
              }}
            >
              <Button asChild variant="outline">
                <a
                  ref={signInLink}
                  href={login}
                  target="_blank"
                  rel="noreferrer"
                >
                  Continue with ChatGPT{" "}
                  <span className="sr-only">(opens a new tab)</span>
                </a>
              </Button>
              <p id="ai-return-hint">
                Approve access, then copy the full return address from your
                browser’s address bar. The local return page may not load.
              </p>
              <label htmlFor="ai-return">Return address</label>
              <Input
                id="ai-return"
                aria-describedby="ai-return-hint"
                type="password"
                autoComplete="off"
                spellCheck={false}
                maxLength={8192}
                required
                value={callback}
                onChange={(event) => setCallback(event.target.value)}
              />
              <div className="account-row-actions">
                <Button
                  type="submit"
                  variant="default"
                  disabled={disabled || !callback.trim()}
                >
                  Finish connection
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => {
                    setLogin("");
                    setCallback("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          )}
          {data.connected && (
            <>
              <SettingRow
                title="Model"
                description={
                  savedModel || "Select a model available on your ChatGPT plan."
                }
              >
                {models?.length > 0 && (
                  <Picker
                    label="Tagging model"
                    value={data.model || ""}
                    disabled={disabled}
                    onChange={(event) =>
                      action("model", { model: event.target.value })
                    }
                  >
                    <option value="" disabled>
                      Select a model
                    </option>
                    {models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name}
                      </option>
                    ))}
                    {data.model &&
                      !models.some((model) => model.id === data.model) && (
                        <option value={data.model} disabled>
                          {data.model} (unavailable)
                        </option>
                      )}
                  </Picker>
                )}
                {!models?.length && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={disabled}
                    onClick={() => action("models")}
                  >
                    {models
                      ? "Refresh models"
                      : data.model
                        ? "Change model"
                        : "Choose model"}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  disabled={disabled || !data.model}
                  onClick={() => action("test")}
                >
                  {busy === "test" ? "Testing…" : "Test connection"}
                </Button>
              </SettingRow>
              {models?.length === 0 && (
                <p role="status">No models are available for this account.</p>
              )}
            </>
          )}
          <SettingRow
            title="Automatic tagging"
            description="For new untagged links, Pocketmark sends existing tag names, the domain, title, description and a short excerpt from the public page when available."
          >
            <Button
              type="button"
              variant={data.enabled ? "outline" : "default"}
              disabled={disabled || (!ready && !data.enabled)}
              onClick={() => action(data.enabled ? "pause" : "enable")}
            >
              {data.enabled
                ? "Pause automatic tagging"
                : "Enable automatic tagging"}
            </Button>
          </SettingRow>
          <SettingRow
            title="Untagged bookmarks"
            description="Scan existing links, including imports and browser sync. A new scan also checks bookmarks whose tags you removed."
          >
            <Button
              type="button"
              variant="outline"
              disabled={
                disabled ||
                !ready ||
                !data.enabled ||
                !data.hasTags ||
                !data.eligible ||
                activeScan ||
                Boolean(reason)
              }
              onClick={() => action("scan")}
            >
              Classify {bookmarks(data.eligible)}
            </Button>
          </SettingRow>
          {!data.hasTags && (
            <p className="ai-message">
              Add a tag to a bookmark to give the classifier a vocabulary.
            </p>
          )}
          {(statuses[scan?.status] || reason || data.remaining > 0) && (
            <section
              className="ai-progress"
              aria-labelledby="ai-progress-title"
            >
              <h2 id="ai-progress-title">
                {statuses[scan?.status] || "Tagging activity"}
              </h2>
              <p role="status">
                {statuses[scan?.status]
                  ? `${scan.processed} processed · ${scan.remaining} remaining`
                  : `${bookmarks(data.remaining)} pending`}
              </p>
              {statuses[scan?.status] && pendingNew > 0 && (
                <p>{bookmarks(pendingNew)} pending outside this scan.</p>
              )}
              {reason && (
                <p>
                  {reasons[reason] || "Tagging is paused."}{" "}
                  {reason === "quota" && (
                    <>
                      <a
                        href="https://chatgpt.com/settings/usage"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Manage plan usage
                        <span className="sr-only"> (opens a new tab)</span>
                      </a>
                      .{" "}
                    </>
                  )}
                  {retryTime && !Number.isNaN(retryTime.getTime()) && (
                    <>
                      Scheduled to resume{" "}
                      <time dateTime={retryTime.toISOString()}>
                        {retryTime.toLocaleString()}
                      </time>
                      .
                    </>
                  )}
                </p>
              )}
              {canResume && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={disabled || !ready}
                  onClick={() => action("resume")}
                >
                  Resume tagging
                </Button>
              )}
            </section>
          )}
          <p role="status" className="ai-message">
            {notice}
          </p>
        </>
      )}
    </div>
  );
}

export function showAITagging(node, visible, api) {
  if (node) renderRegion(node, visible ? <AITagging api={api} /> : null);
}
