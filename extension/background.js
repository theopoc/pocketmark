"use strict";
importScripts("common.js", "job-store.js", "capture.js");
const { formats, origin, request, json, validate } = Pocketmark;
const blobKeys = Object.keys(formats);
let busy = false;
const initialized = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });

async function connection(server) {
  const value = await chrome.storage.local.get(["server", "token"]);
  if (!value.server || !value.token) throw new Error("Connect to Pocketmark with a dedicated API key first.");
  value.server = origin(value.server);
  if (server && value.server !== server) throw new Error("Reconnect to the task's original server before retrying.");
  if (!await chrome.permissions.contains({ origins: [value.server + "/*"] })) throw new Error("Server access was revoked. Reconnect in Connection settings.");
  return value;
}

async function state() {
  const job = await jobStore.read("job");
  if (job?.status === "running" && !busy) {
    // A worker/browser restart never silently resumes network work or recaptures
    // a changed page. Persist the interruption for the next manual action.
    job.status = "paused";
    job.message = "Interrupted. Retry saved files; missing captures need the original page open.";
    for (const item of job.items) if (item.status === "capturing" || item.status === "uploading") item.status = "failed";
    await jobStore.write({ job });
  }
  return job || null;
}

async function saveBookmark(job, conn) {
  const lookup = async () => (await request(conn, `/api/links?url=${encodeURIComponent(job.fields.url)}`)).links.find((link) => link.url === job.fields.url);
  const update = (link) => request(conn, `/api/links/${link.id}`, json("PUT", {
    url: link.url, title: job.fields.title, collectionId: job.fields.collectionId, tags: job.fields.tags,
    description: link.description, notes: link.notes, favorite: link.favorite, read: link.read,
  }));
  let link = await lookup();
  if (link) return update(link);
  try { return await request(conn, "/api/links", json("POST", job.fields)); }
  catch (error) {
    // The website or another browser may have created this URL in the meantime,
    // or the create response may have been lost. Reconcile before retrying.
    link = await lookup();
    if (link) return update(link);
    throw error;
  }
}

async function sourceTab(job) {
  const tab = await chrome.tabs.get(job.tabId);
  if (tab.url !== job.fields.url) throw new Error("Open the original page and retry the missing captures.");
  return tab;
}

async function run(job) {
  let target;
  try {
    const conn = await connection(job.server);
    // An attached debugger keeps MV3 workers alive on Chrome 118+. Retain it
    // through uploads as well, then always detach. No permanent keepalive loop.
    const missing = [];
    for (const item of job.items) if (item.status !== "saved" && !await jobStore.read(item.mode)) missing.push(item);
    if (missing.length) {
      try {
        const tab = await sourceTab(job);
        target = { tabId: tab.id };
        await chrome.debugger.attach(target, "1.3");
        for (const item of missing) {
          try {
            item.status = "capturing"; item.error = "";
            job.message = `Capturing ${formats[item.mode][0].toLowerCase()}…`;
            await jobStore.write({ job });
            const blob = await captureFormat(item.mode, tab);
            item.size = blob.size; item.status = "ready";
            await jobStore.write({ job, [item.mode]: blob });
          } catch (error) {
            item.status = "failed"; item.error = error.message;
            await jobStore.write({ job });
          }
        }
      } catch (error) {
        for (const item of missing) if (item.status !== "ready") { item.status = "failed"; item.error = error.message; }
        await jobStore.write({ job });
      }
    }
    job.message = "Saving bookmark…";
    await jobStore.write({ job });
    // Save even if every capture failed. Once committed, retries only resend
    // captures and never overwrite subsequent library edits.
    if (!job.linkId) {
      const link = await saveBookmark(job, conn);
      job.linkId = link.id;
      await jobStore.write({ job });
    }
    for (const item of job.items) {
      if (item.status === "saved") continue;
      const blob = await jobStore.read(item.mode);
      if (!blob) continue;
      try {
        item.status = "uploading"; item.error = "";
        job.message = `Uploading ${formats[item.mode][0].toLowerCase()}…`;
        await jobStore.write({ job });
        // Stable, per-job filenames let manual retries reconcile a successful
        // upload whose response was lost without creating another attachment.
        const assets = await request(conn, `/api/links/${job.linkId}/assets`);
        const existing = assets.find((asset) => asset.name === item.name && asset.size === blob.size);
        if (!existing) await request(conn, `/api/links/${job.linkId}/assets?name=${encodeURIComponent(item.name)}`, { method: "POST", headers: { "Content-Type": blob.type }, body: blob });
        item.status = "saved";
        await jobStore.write({ job }, [item.mode]);
      } catch (error) {
        item.status = "failed"; item.error = error.message;
        await jobStore.write({ job });
      }
    }
    job.status = job.items.every((item) => item.status === "saved") ? "done" : "paused";
    job.message = job.status === "done" ? "Saved to Pocketmark." : "Bookmark saved. Some captures need attention; retry or discard them.";
  } catch (error) {
    job.status = "paused";
    job.message = `${job.linkId ? "Bookmark saved. " : "Bookmark not confirmed. "}${error.message} Retry manually.`;
  } finally {
    if (target) { try { await chrome.debugger.detach(target); } catch {} }
    try {
      await jobStore.write({ job }, job.status === "done" ? blobKeys : []);
      await chrome.action.setBadgeText({ text: job.status === "done" ? "" : "!" });
    } finally { busy = false; }
  }
}

async function dispatch(message) {
  await initialized;
  if (message.type === "state") return state();
  if (message.type === "tags") return request(await connection(), `/api/tags/browse?q=${encodeURIComponent(String(message.query || "").slice(0, 512))}`);
  if (message.type === "load") {
    const conn = await connection(), tab = await chrome.tabs.get(message.tabId);
    const [collections, tags, result] = await Promise.all([
      request(conn, "/api/collections"), request(conn, "/api/tags"),
      request(conn, `/api/links?url=${encodeURIComponent(tab.url)}`),
    ]);
    return { collections, tags, link: result.links.find((link) => link.url === tab.url) || null, server: conn.server };
  }
  // All mutations acquire this lock before the first asynchronous read. Multiple
  // popups cannot race to overwrite the one durable job or its captured files.
  if (busy) throw new Error("A task is running. Wait for it to finish.");
  busy = true;
  let launched = false;
  try {
    const job = await jobStore.read("job");
    if (message.type === "connect") {
      const candidate = { server: origin(message.connection.server), token: message.connection.token };
      if (job && job.status !== "done" && job.server !== candidate.server) throw new Error("Retry or discard the current task before changing servers.");
      if (typeof candidate.token !== "string" || !candidate.token.trim()) throw new Error("Enter a dedicated API key.");
      if (!await chrome.permissions.contains({ origins: [candidate.server + "/*"] })) throw new Error("Server access was not granted. Click Connect to retry.");
      const session = await request(candidate, "/api/session");
      if (session?.authenticated !== true) throw new Error("The server did not confirm an authenticated connection.");
      await chrome.storage.local.set({ ...candidate, pendingConnection: null });
      return { connected: true };
    }
    if (message.type === "collection") {
      const name = String(message.name || "").trim();
      if (!name || new TextEncoder().encode(name).length > 120) throw new Error("Collection name must be 1–120 bytes.");
      return request(await connection(), "/api/collections", json("POST", { name, parentId: message.parentId || null }));
    }
    if (message.type === "discard") {
      await jobStore.write({}, ["job", ...blobKeys]);
      await chrome.action.setBadgeText({ text: "" });
      return null;
    }
    if (message.type === "retry") {
      if (!job || job.status === "done") throw new Error("There is no task to retry.");
      await connection(job.server);
      // Reopening the same URL in a new tab can recover failed acquisition;
      // already captured blobs are always reused, even without the source tab.
      if (Number.isInteger(message.tabId)) {
        const tab = await chrome.tabs.get(message.tabId);
        if (tab.url === job.fields.url) job.tabId = tab.id;
      }
      job.status = "running"; job.message = "Retrying…";
      await jobStore.write({ job });
      launched = true;
      void run(job).catch(console.error);
      return job;
    }
    if (message.type !== "save") throw new Error("Unknown extension command.");
    if (job && job.status !== "done") throw new Error("Retry or discard the previous task before saving another page.");
    validate(message.fields);
    const conn = await connection(), tab = await chrome.tabs.get(message.tabId);
    if (tab.url !== message.fields.url) throw new Error("The source page changed. Reopen the extension.");
    if (!Array.isArray(message.modes) || message.modes.length > 4 || message.modes.some((mode) => !Object.hasOwn(formats, mode))) throw new Error("Select valid capture formats.");
    const id = crypto.randomUUID();
    const next = { id, server: conn.server, tabId: tab.id, fields: message.fields, status: "running", message: "Starting…", items: [...new Set(message.modes)].map((mode) => ({ mode, status: "pending", name: `${mode}-${id}.${formats[mode][1]}` })) };
    await jobStore.write({ job: next }, blobKeys);
    launched = true;
    void run(next).catch(console.error);
    return next;
  } finally { if (!launched) busy = false; }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup.html")) return false;
  dispatch(message).then((value) => sendResponse({ ok: true, value }), (error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
