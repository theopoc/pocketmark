"use strict";
const $ = (id) => document.getElementById(id);
const { formats, origin, validate } = Pocketmark;
// Chrome sizes action popups from their contents. Viewport-relative caps during
// that first measurement otherwise collapse the popup to Chrome's minimum size.
// Establish its preferred size first, then clamp to actual native resize events.
if (chrome.extension?.getViews({ type: "popup" }).includes(window)) {
  document.body.classList.add("native-popup");
  window.addEventListener("resize", () => {
    document.body.style.maxInlineSize = `${window.innerWidth}px`;
    document.body.style.maxBlockSize = `${window.innerHeight}px`;
  });
}
let activeTab, connected = false, connecting = false, loaded = false, ready = false, settingsOpen = false, task = null, tags = [], collections = [], poll, tagTimer, tagQuery = 0, taskSignature, collectionSession = 0;
function status(message, error = false, success = false) {
  const changed = $("status").textContent !== message;
  $("status").setAttribute("role", error ? "alert" : "status");
  $("status").setAttribute("aria-live", error ? "assertive" : "polite");
  $("status").textContent = message; $("status").className = error ? "notice error" : success ? "notice success" : "notice";
  if ((error || success) && changed) $("status").scrollIntoView?.({ block: "nearest" });
}
async function send(type, values = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...values });
  if (!response?.ok) throw new Error(response?.error || "The extension could not respond. Reopen the popup.");
  return response.value;
}
function controls() {
  const running = task?.status === "running", paused = task?.status === "paused";
  const editing = connected && loaded && !settingsOpen && !running && !paused;
  $("editor").disabled = !editing || connecting;
  $("save-form").hidden = !editing;
  $("settings").hidden = !settingsOpen;
  $("save-footer").hidden = !editing;
  $("connect-footer").hidden = !settingsOpen;
  $("task-actions").hidden = settingsOpen || !paused;
  $("background-note").hidden = settingsOpen || !running;
  $("footer").hidden = !(editing || settingsOpen || running || paused);
  $("task").hidden = settingsOpen || !task || (task.status === "done" && task.fields.url !== activeTab?.url);
  $("unsupported").hidden = settingsOpen || !ready || !connected || loaded || running || paused;
  $("connection-toggle").hidden = !connected;
  $("connection-toggle").textContent = settingsOpen ? "Back to bookmark" : "Connection";
  $("connection-toggle").setAttribute("aria-expanded", String(settingsOpen));
  $("connect").disabled = connecting || task?.status === "running";
  $("connect").textContent = connecting ? "Connecting…" : "Connect";
  captureHint();
}
function showSettings(open) {
  settingsOpen = open;
  controls();
}
function captureHint() {
  const count = Object.keys(formats).filter((mode) => $("capture-" + mode).checked).length;
  $("capture-count").textContent = count ? `${count} selected` : "Optional";
  $("save-hint").textContent = count ? `Bookmark + ${count} capture${count === 1 ? "" : "s"}` : "Bookmark only";
}
function renderTags() {
  $("selected-tags").replaceChildren();
  for (const tag of tags) {
    const item = document.createElement("li"), label = document.createElement("span"), button = document.createElement("button");
    label.className = "tag-name"; label.textContent = tag;
    button.type = "button"; button.setAttribute("aria-label", `Remove tag ${tag}`);
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg"), line = document.createElementNS("http://www.w3.org/2000/svg", "path");
    icon.setAttribute("viewBox", "0 0 24 24"); icon.setAttribute("aria-hidden", "true"); line.setAttribute("d", "m7 7 10 10M17 7 7 17"); icon.append(line); button.append(icon);
    button.addEventListener("click", () => { tags = tags.filter((value) => value !== tag); renderTags(); $("tag-input").focus(); });
    item.append(label, button); $("selected-tags").append(item);
  }
}
function addTags() {
  tags = [...new Set([...tags, ...$("tag-input").value.split(",").map((tag) => tag.trim()).filter(Boolean)])];
  $("tag-input").value = ""; renderTags();
}
function options(select, label, value) { const option = document.createElement("option"); option.textContent = label; option.value = value; select.append(option); }
function collectionPath(collection) {
  const names = [collection.name], seen = new Set([collection.id]);
  let parent = collections.find((value) => value.id === collection.parentId);
  while (parent && !seen.has(parent.id)) { names.unshift(parent.name); seen.add(parent.id); parent = collections.find((value) => value.id === parent.parentId); }
  return names.join(" / ");
}
function renderCollections(selected = "") {
  $("collection").replaceChildren(); $("collection-parent").replaceChildren();
  options($("collection"), "Inbox", ""); options($("collection-parent"), "Library root", "");
  for (const collection of [...collections].sort((a, b) => collectionPath(a).localeCompare(collectionPath(b)))) {
    options($("collection"), collectionPath(collection), collection.id); options($("collection-parent"), collectionPath(collection), collection.id);
  }
  $("collection").value = String(selected || "");
}
function tagOptions(values) {
  $("tag-options").replaceChildren();
  for (const tag of values) if (!tags.includes(tag.name)) options($("tag-options"), tag.name, tag.name);
}
async function load() {
  loaded = false; controls();
  if (!activeTab?.url || !/^https?:\/\//i.test(activeTab.url)) { status("Open a regular http(s) page to save it.", true); return; }
  const data = await send("load", { tabId: activeTab.id });
  collections = data.collections;
  renderCollections(data.link?.collectionId);
  tagOptions(data.tags);
  $("title").value = data.link?.title || activeTab.title || activeTab.url;
  tags = data.link?.tags || []; renderTags();
  $("save").textContent = data.link ? "Save changes" : "Save bookmark";
  status(task && (task.status !== "done" || task.fields.url === activeTab?.url) ? "" : data.link ? "Already saved. Edit its title, collection or tags." : "Ready to save this page.");
  if (data.link && task?.status === "done" && task.server === data.server && task.fields.url === activeTab.url) status("Saved to Pocketmark.", false, true);
  loaded = true; controls();
}
function renderTask(job) {
  const signature = JSON.stringify(job);
  // Background polling must not recreate focused controls, re-announce the
  // same status or reopen a disclosure the user deliberately collapsed.
  if (signature === taskSignature) { controls(); return; }
  taskSignature = signature;
  const changedState = task?.status !== job?.status || task?.id !== job?.id;
  task = job;
  if (job) {
    $("task").setAttribute("data-state", job.status);
    if (changedState) $("task").open = job.status !== "done";
    $("task-heading").textContent = job.status === "done" ? (job.fields.url === activeTab?.url ? "Saved to Pocketmark" : "Previous save") : job.status === "paused" ? "Save needs attention" : "Saving to Pocketmark";
    const saved = job.items.filter((item) => item.status === "saved").length;
    $("task-count").textContent = job.items.length ? `${saved}/${job.items.length}` : "";
    $("task-count").setAttribute("aria-label", `${saved} of ${job.items.length} captures saved`);
    $("task-icon").setAttribute("d", job.status === "done" ? "m5 12 4 4L19 6" : job.status === "paused" ? "M12 4v9m0 5v1" : "M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-2l2 2M4 17l2 2a7 7 0 0 0 12-2");
    $("task-title").textContent = job.fields.title || job.fields.url;
    $("task-message").textContent = job.message;
    $("task-message").className = job.status === "paused" ? "error" : "";
    $("task-items").replaceChildren();
    for (const item of job.items) {
      const li = document.createElement("li");
      const label = { pending: "Waiting", capturing: "Capturing", ready: "Captured locally", uploading: "Uploading", saved: "Saved", failed: "Failed" }[item.status];
      const name = document.createElement("span"), state = document.createElement("span");
      name.textContent = formats[item.mode][0]; state.textContent = label; state.className = item.status === "saved" ? "item-state item-saved" : "item-state";
      li.append(name, state);
      if (item.error) { const error = document.createElement("span"); error.className = "item-error"; error.textContent = item.error; li.append(error); }
      $("task-items").append(li);
    }
    $("retry").hidden = job.status !== "paused";
    $("discard").hidden = job.status !== "paused";
    if (job.linkId && job.fields.url === activeTab?.url) $("save").textContent = "Save changes";
    if (changedState && ready) {
      if (job.status === "done" && job.fields.url === activeTab?.url) status("Saved to Pocketmark.", false, true);
      else if (job.status === "paused") status(job.message, true);
      else status("");
      if (job.status === "done") window.close();
    }
  }
  controls();
}
async function refresh() { renderTask(await send("state")); }
async function finishConnection(candidate) {
  await send("connect", { connection: candidate });
  connected = true; showSettings(false);
  await load();
}
$("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault(); if (connecting) return;
  connecting = true; connected = false; controls();
  try {
    const candidate = { server: origin($("server").value.trim()), token: $("token").value.trim() };
    if (!candidate.token) throw new Error("Enter a dedicated API key from Pocketmark → API keys.");
    status("Approve server access, then reopen this popup if it closes.");
    // Both operations start within the user gesture. Permission prompts can
    // destroy popups, so store the draft before Chrome presents its dialog.
    const persisted = chrome.storage.local.set({ pendingConnection: candidate });
    const permission = chrome.permissions.request({ origins: [candidate.server + "/*"] });
    const [, granted] = await Promise.all([persisted, permission]);
    if (!granted) { await chrome.storage.local.set({ pendingConnection: null }); throw new Error("Server access was not granted. Click Connect to retry."); }
    await finishConnection(candidate);
  } catch (error) { showSettings(true); status(error.message, true); }
  finally { connecting = false; controls(); }
});
$("connection-toggle").addEventListener("click", () => {
  showSettings(!settingsOpen);
  status("");
  if (settingsOpen) $("server").focus();
});
for (const mode of Object.keys(formats)) $("capture-" + mode).addEventListener("change", captureHint);
$("add-tag").addEventListener("click", () => { addTags(); $("tag-input").focus(); });
$("tag-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === ",") { event.preventDefault(); addTags(); }
  if (event.key === "Backspace" && !$("tag-input").value && tags.length) $("selected-tags").lastElementChild?.querySelector("button")?.focus();
});
$("tag-input").addEventListener("input", () => {
  clearTimeout(tagTimer); const sequence = ++tagQuery;
  tagTimer = setTimeout(async () => {
    try { const data = await send("tags", { query: $("tag-input").value }); if (sequence === tagQuery) tagOptions(data.tags); }
    catch { /* Manual creation remains available when suggestions fail. */ }
  }, 200);
});
function collectionEditor(open) {
  collectionSession++;
  $("collection-create").hidden = !open; $("new-collection").setAttribute("aria-expanded", String(open));
  if (open) { $("create-collection").disabled = false; $("collection-name").readOnly = false; $("collection-parent").disabled = false; $("collection-parent").value = $("collection").value; $("collection-name").focus(); }
}
$("new-collection").addEventListener("click", () => collectionEditor($("collection-create").hidden));
$("cancel-collection").addEventListener("click", () => { collectionEditor(false); $("new-collection").focus(); });
$("collection-name").addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); $("create-collection").click(); }
  if (event.key === "Escape") { event.preventDefault(); collectionEditor(false); $("new-collection").focus(); }
});
$("create-collection").addEventListener("click", async () => {
  const session = collectionSession;
  $("create-collection").disabled = true;
  $("collection-name").readOnly = true; $("collection-parent").disabled = true;
  try {
    const collection = await send("collection", { name: $("collection-name").value, parentId: Number($("collection-parent").value) || null });
    collections.push(collection);
    if (session === collectionSession) {
      renderCollections(collection.id); collectionEditor(false); $("collection-name").value = "";
      $("collection").focus(); status("Collection created and selected.");
    } else {
      const parent = $("collection-parent").value;
      renderCollections($("collection").value); $("collection-parent").value = parent;
      status($("collection-create").hidden ? "Collection created." : "Collection created. Your current draft is unchanged.");
    }
  } catch (error) { status(error.message, true); }
  finally { if (session === collectionSession) { $("create-collection").disabled = false; $("collection-name").readOnly = false; $("collection-parent").disabled = false; } }
});
$("save-form").addEventListener("submit", async (event) => {
  event.preventDefault(); $("save").disabled = true;
  try {
    addTags();
    const fields = { url: activeTab.url, title: $("title").value.trim(), collectionId: Number($("collection").value) || null, tags };
    validate(fields);
    const modes = Object.keys(formats).filter((mode) => $("capture-" + mode).checked);
    renderTask(await send("save", { tabId: activeTab.id, fields, modes }));
    for (const mode of Object.keys(formats)) $("capture-" + mode).checked = false;
    status("");
  } catch (error) { status(error.message, true); }
  finally { $("save").disabled = false; controls(); }
});
$("retry").addEventListener("click", async () => {
  $("retry").disabled = true;
  try { renderTask(await send("retry", { tabId: activeTab?.id })); }
  catch (error) { status(error.message, true); }
  finally { $("retry").disabled = false; }
});
$("discard").addEventListener("click", async () => {
  try { await send("discard"); renderTask(null); status("Pending local files discarded. Saved bookmarks and captures are unchanged."); }
  catch (error) { status(error.message, true); }
});
async function initialize() {
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    $("page-title").textContent = activeTab?.url && /^https?:\/\//i.test(activeTab.url) ? new URL(activeTab.url).hostname : "Your current page";
    $("page-title").title = activeTab?.url || "";
    await refresh();
    const stored = await chrome.storage.local.get(["server", "token", "pendingConnection"]), candidate = stored.pendingConnection || stored;
    $("server").value = candidate.server || ""; $("token").value = candidate.token || "";
    if (stored.pendingConnection) {
      if (await chrome.permissions.contains({ origins: [origin(candidate.server) + "/*"] })) await finishConnection(candidate);
      else { await chrome.storage.local.set({ pendingConnection: null }); throw new Error("Server access was not granted. Click Connect to retry."); }
    } else if (stored.server && stored.token) { connected = true; await load(); }
    else { showSettings(true); status(""); }
  } catch (error) { showSettings(true); status(error.message, true); }
  finally {
    ready = true;
    controls();
    poll = setInterval(() => { refresh().catch((error) => status(error.message, true)); }, 1000);
  }
}
window.addEventListener("pagehide", () => { clearInterval(poll); clearTimeout(tagTimer); });
void initialize();
