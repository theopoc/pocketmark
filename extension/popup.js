"use strict";
const $ = (id) => document.getElementById(id);
const { formats, origin, validate } = Pocketmark;
let activeTab, connected = false, connecting = false, loaded = false, task = null, tags = [], collections = [], poll, tagTimer, tagQuery = 0;
function status(message, error = false) { $("status").textContent = message; $("status").className = error ? "error" : ""; }
async function send(type, values = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...values });
  if (!response?.ok) throw new Error(response?.error || "The extension could not respond. Reopen the popup.");
  return response.value;
}
function controls() {
  $("editor").disabled = !connected || !loaded || connecting || task?.status === "running" || task?.status === "paused";
  $("connect").disabled = connecting || task?.status === "running";
}
function renderTags() {
  $("selected-tags").replaceChildren();
  for (const tag of tags) {
    const item = document.createElement("li"), button = document.createElement("button");
    button.type = "button"; button.textContent = `${tag} ×`; button.setAttribute("aria-label", `Remove tag ${tag}`);
    button.addEventListener("click", () => { tags = tags.filter((value) => value !== tag); renderTags(); });
    item.append(button); $("selected-tags").append(item);
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
  status(data.link ? "Already saved. Edit its title, collection or tags." : "Ready to save this page.");
  loaded = true; controls();
}
function renderTask(job) {
  task = job;
  $("task").hidden = !job;
  if (job) {
    $("task-title").textContent = job.fields.title || job.fields.url;
    $("task-message").textContent = job.message;
    $("task-message").className = job.status === "paused" ? "error" : "";
    $("task-items").replaceChildren();
    for (const item of job.items) {
      const li = document.createElement("li");
      const label = { pending: "Waiting", capturing: "Capturing", ready: "Captured locally", uploading: "Uploading", saved: "Saved", failed: "Failed" }[item.status];
      li.textContent = `${formats[item.mode][0]}: ${label}${item.error ? ` — ${item.error}` : ""}`;
      if (item.status === "failed") li.className = "error";
      $("task-items").append(li);
    }
    $("retry").hidden = job.status !== "paused";
    $("discard").hidden = job.status !== "paused";
    if (job.linkId && job.fields.url === activeTab?.url) $("save").textContent = "Save changes";
  }
  controls();
}
async function refresh() { renderTask(await send("state")); }
async function finishConnection(candidate) {
  await send("connect", { connection: candidate });
  connected = true; $("settings").open = false;
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
  } catch (error) { $("settings").open = true; status(error.message, true); }
  finally { connecting = false; controls(); }
});
$("add-tag").addEventListener("click", addTags);
$("tag-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === ",") { event.preventDefault(); addTags(); }
});
$("tag-input").addEventListener("input", () => {
  clearTimeout(tagTimer); const sequence = ++tagQuery;
  tagTimer = setTimeout(async () => {
    try { const data = await send("tags", { query: $("tag-input").value }); if (sequence === tagQuery) tagOptions(data.tags); }
    catch { /* Manual creation remains available when suggestions fail. */ }
  }, 200);
});
function collectionEditor(open) {
  $("collection-create").hidden = !open; $("new-collection").setAttribute("aria-expanded", String(open));
  if (open) { $("collection-parent").value = $("collection").value; $("collection-name").focus(); }
}
$("new-collection").addEventListener("click", () => collectionEditor($("collection-create").hidden));
$("cancel-collection").addEventListener("click", () => collectionEditor(false));
$("collection-name").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); $("create-collection").click(); } });
$("create-collection").addEventListener("click", async () => {
  $("create-collection").disabled = true;
  try {
    const collection = await send("collection", { name: $("collection-name").value, parentId: Number($("collection-parent").value) || null });
    collections.push(collection); renderCollections(collection.id); collectionEditor(false); $("collection-name").value = "";
    status("Collection created and selected.");
  } catch (error) { status(error.message, true); }
  finally { $("create-collection").disabled = false; }
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
    status("Task started. You can close this popup.");
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
    $("page-title").textContent = activeTab?.title || activeTab?.url || "Your current page";
    await refresh();
    const stored = await chrome.storage.local.get(["server", "token", "pendingConnection"]), candidate = stored.pendingConnection || stored;
    $("server").value = candidate.server || ""; $("token").value = candidate.token || "";
    if (stored.pendingConnection) {
      if (await chrome.permissions.contains({ origins: [origin(candidate.server) + "/*"] })) await finishConnection(candidate);
      else { await chrome.storage.local.set({ pendingConnection: null }); throw new Error("Server access was not granted. Click Connect to retry."); }
    } else if (stored.server && stored.token) { connected = true; await load(); }
    else { $("settings").open = true; status("Connect your Pocketmark server to get started."); }
  } catch (error) { $("settings").open = true; status(error.message, true); }
  finally {
    controls();
    poll = setInterval(() => { refresh().catch((error) => status(error.message, true)); }, 1000);
  }
}
window.addEventListener("pagehide", () => { clearInterval(poll); clearTimeout(tagTimer); });
void initialize();
