"use strict";

((root) => {
  const workspace = typeof module !== "undefined" && module.exports ? require("./workspace.js") : root.PocketmarkWorkspace;

  // The reader owns its DOM events and session state. Callers only open/close it;
  // the browser adapter and application callbacks keep its implementation testable.
  function create({ api: request, drafts, toast, onEdit, onChange, onSessionExpired }, browser = root) {
    const document = browser.document, window = browser;
    const $ = (id) => document.getElementById(id);
    const { editableBookmark: editable, bookmarkDraftKey: draftKey, safeURL, domain } = workspace;
    const state = { reading: null, readerRequest: 0, annotations: [], annotationDraft: null, readerSelection: null };
    let annotationSession = 0;
    let readerAssets = [];
    let readerLayoutURL = "";
    let layoutRequest = 0;
    let viewerRequest = 0;
    let retryReaderID = null;
    let activeSection = "reader-notes-form";
    let readingView = false;
    let assetsState = "loading";
    const formats = [
      { key: "html", name: "HTML", matches: asset => asset.mediaType === "text/html" },
      { key: "image", name: "Screenshot", matches: asset => ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(asset.mediaType) },
      { key: "pdf", name: "PDF", matches: asset => asset.mediaType === "application/pdf" },
    ];
    const highlightAnchors = new Map();
    const sectionButtons = [...document.querySelectorAll("[data-reader-section]")];
    function selectSection(section) {
      activeSection = section;
      for (const button of sectionButtons) {
        const selected = button.dataset.readerSection === section;
        button.setAttribute("aria-selected", String(selected));
        button.tabIndex = selected ? 0 : -1;
        const panel = $(button.dataset.readerSection);
        panel.hidden = !selected;
      }

    }

    function showNotebook(open) {
      $("reader-notebook").hidden = !open;
      $("reader-dialog").setAttribute("data-notebook-open", String(open));
      $("reader-notebook-toggle").setAttribute("aria-expanded", String(open));
    }
    $("reader-notebook-toggle").addEventListener("click", () => showNotebook($("reader-notebook").hidden));
    $("reader-notebook-close").addEventListener("click", () => {
      showNotebook(false);
      $("reader-notebook-toggle").focus({ preventScroll: true });
    });

    function emptyReaderText() {
      return safeURL(state.reading?.url)
        ? "No article text was saved. Open the original page to read it."
        : "No article text was saved. Open a saved file under Notes → Files.";
    }

    function closeViewer() {
      viewerRequest++;
      $("asset-viewer-content").replaceChildren();
      if ($("asset-viewer").open) $("asset-viewer").close();
    }

    function el(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }
    function isCurrent(token) { return token === state.readerRequest && $("reader-dialog").open; }
    function invalidate() {
      closeViewer();
      state.readerRequest++; layoutRequest++; annotationSession++;
      state.reading = null; state.annotationDraft = null; state.readerSelection = null;
      retryReaderID = null;
      state.annotations = []; readerAssets = []; readerLayoutURL = "";
      $("reader-layout").removeAttribute("src");
    }
    function close() {
      invalidate();
      if ($("annotation-dialog").open) $("annotation-dialog").close();
      if ($("reader-dialog").open) $("reader-dialog").close();
    }
    function expireSession() { close(); onSessionExpired(); }
    async function api(path, options) {
      try { return await request(path, options); }
      catch (error) { if (error.status === 401) expireSession(); throw error; }
    }
    $("reader-dialog").addEventListener("close", () => { if (!$("reader-dialog").open) invalidate(); });
    $("annotation-dialog").addEventListener("close", () => {
      if (!$("annotation-dialog").open) { annotationSession++; state.annotationDraft = null; }
    });

    async function openReader(id, recheck = false) {
      closeViewer();
      retryReaderID = null;
      $("reader-retry-open").hidden = true;
      const scroll = recheck ? $("reader-text-panel").scrollTop : 0;
      const request = ++state.readerRequest;
      annotationSession++;
      state.annotationDraft = null;
      if ($("annotation-dialog").open) $("annotation-dialog").close();
      if (!recheck) { readingView = false; $("reader-options").open = false; activeSection = "reader-notes-form"; showNotebook(false); }
      $("reader-notebook-toggle").disabled = true;
      $("reader-text-panel").scrollTop = 0;
      $("reader-dialog").scrollTop = 0;
      $("reader-text-panel").hidden = false;
      $("reader-highlight").hidden = false;
      layoutRequest++;
      state.reading = null;
      readerAssets = []; readerLayoutURL = "";
      assetsState = "loading";
      $("reader-formats").hidden = true;
      $("reader-formats-error").hidden = true;
      $("reader-formats-retry").hidden = true;
      $("reader-formats-retry").disabled = false;
      state.readerSelection = null;
      $("reader-title").textContent = "Opening your bookmark…";
      $("reader-domain").textContent = "";
      $("reader-content").textContent = "";
      $("reader-content").hidden = true;
      for (const id of ["reader-section-nav", "reader-reading-bar", "annotations-section", "reader-files"]) $(id).hidden = true;
      $("reader-layout").hidden = true;
      $("reader-layout").removeAttribute("src");
      $("reader-layout-mode").setAttribute("aria-pressed", "false");
      $("reader-layout-mode").disabled = true;
      $("reader-size").disabled = false;
      document.querySelectorAll("[data-highlight-selection]").forEach((button) => { button.disabled = true; });
      $("reader-text-mode").setAttribute("aria-pressed", "true");
      $("annotation-list").replaceChildren();
      $("asset-list").replaceChildren();
      state.annotations = [];
      $("reader-status").textContent = "";
      $("reader-mode-hint").textContent = "Checking saved HTML…";
      $("reader-recheck").hidden = true;
      $("reader-retry-capture").hidden = true;
      $("reader-retry-capture").removeAttribute("aria-disabled");
      for (const section of ["annotations", "assets"]) { $(section + "-error").hidden = true; $(section + "-retry").hidden = true; $(section + "-retry").disabled = false; }
      $("reader-notes").value = "";
      $("asset-file").value = "";
      $("asset-file").disabled = false;
      $("asset-upload-button").removeAttribute("aria-disabled");
      $("asset-upload-button").textContent = "Attach a saved file";
      $("reader-notes-form").querySelector("button[type=submit]").disabled = false;
      $("reader-error").textContent = "";
      $("reader-original").hidden = true;
      $("reader-archive").hidden = true;
      $("reader-capture").disabled = true;
      $("reader-edit").disabled = true;
      $("reader-notes-form").hidden = true;
      if (!$("reader-dialog").open) $("reader-dialog").showModal();
      try {
        const link = await api(`/api/links/${id}`);
        if (!isCurrent(request)) return;
        state.reading = link;
        $("reader-content").hidden = !readingView;
        $("reader-formats").hidden = false;
        renderFormats();
        for (const id of ["reader-section-nav", "reader-reading-bar", "annotations-section", "reader-files"]) $(id).hidden = false;
        $("reader-title").textContent = link.title || link.url;
        $("reader-domain").textContent = link.type === "file" ? "Saved file" : safeURL(link.url) || domain(link.url);
        $("reader-capture").hidden = link.type === "file";
        const url = safeURL(link.url);
        $("reader-original").hidden = !url;
        if (url) $("reader-original").href = url;
        $("reader-archive").hidden = !link.archiveAvailable;
        $("reader-archive").href = `/api/links/${id}/archive`;
        $("reader-archive").setAttribute("download", "");
        $("reader-content").textContent = link.content || emptyReaderText();
        $("reader-status").textContent = { failed: `Page capture failed. ${workspace.captureFailure(link.error)} Saved files remain available.`, pending: "Capture queued. You can check its status here.", processing: "Capture in progress. You can check its status here." }[link.status] || "";
        $("reader-retry-capture").hidden = link.status !== "failed" || link.type === "file";
        $("reader-recheck").hidden = !["pending", "processing"].includes(link.status);
        const draft = drafts.get(draftKey(link));
        $("reader-notes").value = draft?.notes ?? link.notes ?? "";
        $("reader-notes-draft").hidden = !draft || draft.notes === (link.notes || "");
        $("reader-capture").disabled = false;
        $("reader-edit").disabled = false;
        selectSection(activeSection);
        $("reader-notebook-toggle").disabled = false;
        document.querySelectorAll("[data-highlight-selection]").forEach((button) => { button.disabled = !link.content; });
        const loaded = await Promise.allSettled([loadAnnotations(id, request), loadAssets(id, request)]);
        if (!isCurrent(request)) return;
        loaded.forEach((result, i) => { if (result.status === "rejected") readerSectionError(i ? "assets" : "annotations", result.reason); });
        if (recheck) $("reader-text-panel").scrollTop = scroll;
      } catch (error) {
        if (!isCurrent(request)) return;
        $("reader-title").textContent = "Could not open this bookmark";
        $("reader-error").textContent = error.message;
        $("reader-status").textContent = error.message;
        retryReaderID = id;
        $("reader-retry-open").hidden = false;
      }
    }

    $("reader-retry-open").addEventListener("click", () => {
      if (retryReaderID === null) return;
      const id = retryReaderID;
      $("reader-title").tabIndex = -1;
      $("reader-title").focus({ preventScroll: true });
      openReader(id);
    });

    function readerSectionError(section, error) {
      $(section + "-error").textContent = `Could not load ${section === "assets" ? "saved files" : "highlights"}. ${error.message}`;
      $(section + "-error").hidden = false; $(section + "-retry").hidden = false;
      if (section === "assets") {
        assetsState = "error";
        renderFormats();
        $("reader-formats-error").textContent = "Could not check saved formats. Retry to see which copies are available.";
        $("reader-formats-error").hidden = false;
        $("reader-formats-retry").hidden = false;
        $("reader-mode-hint").textContent = "Could not check saved HTML. Retry saved files below; text view remains available.";
      }
    }
    for (const section of ["annotations", "assets"]) $(section + "-retry").addEventListener("click", async () => {
      if (!state.reading) return;
      const id = state.reading.id, request = state.readerRequest;
      $(section + "-retry").disabled = true;
      if (section === "assets") $("reader-formats-retry").disabled = true;
      try { await (section === "assets" ? loadAssets(id, request) : loadAnnotations(id, request)); if (isCurrent(request)) { $(section + "-error").hidden = true; $(section + "-retry").hidden = true; } }
      catch (error) { if (isCurrent(request)) readerSectionError(section, error); }
      finally { if (isCurrent(request)) { $(section + "-retry").disabled = false; if (section === "assets") $("reader-formats-retry").disabled = false; } }
    });
    $("reader-formats-retry").addEventListener("click", () => $("assets-retry").click());
    $("reader-recheck").addEventListener("click", () => {
      if (!state.reading) return;
      $("reader-title").tabIndex = -1;
      $("reader-title").focus({ preventScroll: true });
      openReader(state.reading.id, true);
    });
    sectionButtons.forEach((button, index) => {
      button.addEventListener("click", () => {
        selectSection(button.dataset.readerSection);
        showNotebook(true);
      });
      button.addEventListener("keydown", (event) => {
        let next;
        if (event.key === "ArrowRight") next = (index + 1) % sectionButtons.length;
        else if (event.key === "ArrowLeft") next = (index + sectionButtons.length - 1) % sectionButtons.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = sectionButtons.length - 1;
        else return;
        event.preventDefault();
        sectionButtons[next].click();
        sectionButtons[next].focus({ preventScroll: true });
      });
    });
    $("reader-notes").addEventListener("input", () => {
      if (!state.reading) return;
      const draft = drafts.get(draftKey(state.reading)) || editable(state.reading);
      draft.notes = $("reader-notes").value;
      drafts.put(draftKey(state.reading), draft, editable(state.reading));
      $("reader-notes-draft").hidden = draft.notes === (state.reading.notes || "");
    });
    $("discard-reader-notes").addEventListener("click", () => {
      if (!state.reading || !browser.confirm("Discard these unsaved notes?")) return;
      $("reader-notes").value = state.reading.notes || "";
      $("reader-notes").dispatchEvent(new browser.Event("input"));
    });


    $("reader-edit").addEventListener("click", () => {
      const link = state.reading;
      if (!link) return;
      close();
      onEdit(link);
    });
    async function capture() {
      if (!state.reading || $("reader-capture").disabled) return;
      const id = state.reading.id, request = state.readerRequest;
      $("reader-capture").disabled = true;
      $("reader-retry-capture").setAttribute("aria-disabled", "true");
      $("reader-error").textContent = "";
      try {
        await api(`/api/links/${id}/capture`, { method: "POST" });
        if (isCurrent(request)) {
          const retryFocused = document.activeElement === $("reader-retry-capture");
          $("reader-status").textContent = "Capture queued. Check its status here without closing the reader.";
          $("reader-retry-capture").hidden = true;
          $("reader-recheck").hidden = false;
          if (retryFocused) $("reader-recheck").focus({ preventScroll: true });
          toast("Capture queued.");
        }
        await onChange();
      } catch (error) { if (isCurrent(request)) { $("reader-error").textContent = error.message; if (!$("reader-retry-capture").hidden) $("reader-status").textContent = `Could not retry capture. ${error.message}`; } } finally { if (isCurrent(request)) { $("reader-capture").disabled = false; $("reader-retry-capture").removeAttribute("aria-disabled"); } }
    }
    $("reader-capture").addEventListener("click", capture);
    $("reader-retry-capture").addEventListener("click", capture);
    $("reader-notes-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!state.reading) return;
      const button = event.submitter;
      const link = state.reading, request = state.readerRequest, key = draftKey(link);
      button.disabled = true;
      $("reader-error").textContent = "";
      try {
        const notes = $("reader-notes").value;
        await api(`/api/links/${link.id}`, { method: "PUT", body: JSON.stringify({ ...editable(link), notes }) });
        link.notes = notes;
        const remaining = drafts.get(key) || (isCurrent(request) ? editable(link) : null);
        if (remaining && isCurrent(request)) remaining.notes = $("reader-notes").value;
        if (remaining) drafts.put(key, remaining, editable(link));
        if (isCurrent(request)) $("reader-notes-draft").hidden = $("reader-notes").value === notes;
        toast("Notes saved.");
        await onChange();
      } catch (error) { if (isCurrent(request)) $("reader-error").textContent = error.message; else toast(error.message, true); }
      finally { if (isCurrent(request)) button.disabled = false; }
    });


    function renderReaderText() {
      const content = state.reading?.content || "";
      const root = $("reader-content");
      const active = document.activeElement;
      const focusedMark = active?.dataset?.annotationId && root.contains(active)
        ? { id: active.dataset.annotationId, start: active.dataset.segmentStart } : null;
      let restoredMark = null;
      root.replaceChildren();
      highlightAnchors.clear();
      if (!content) {
        root.textContent = emptyReaderText();
        if (focusedMark) { root.tabIndex = -1; root.focus({ preventScroll: true }); }
        return;
      }
      const points = Array.from(content);
      const notes = state.annotations.filter((item) => !item.stale && item.start >= 0 && item.end <= points.length && item.start < item.end && points.slice(item.start, item.end).join("") === item.quote);
      // Split overlapping highlights into bounded segments without trusting any captured markup.
      const boundaries = [...new Set([0, points.length, ...notes.flatMap((item) => [item.start, item.end])])].sort((a, b) => a - b);
      const fragment = document.createDocumentFragment();
      for (let i = 1; i < boundaries.length; i++) {
        const start = boundaries[i - 1], end = boundaries[i];
        const text = points.slice(start, end).join("");
        const note = notes.find((item) => item.start <= start && item.end >= end);
        if (!note) { fragment.append(document.createTextNode(text)); continue; }
        const mark = el("mark", `highlight-${["yellow", "green", "blue", "pink"].includes(note.color) ? note.color : "yellow"}`, text);
        mark.dataset.annotationId = String(note.id);
        mark.dataset.segmentStart = String(start);
        if (!highlightAnchors.has(note.id)) highlightAnchors.set(note.id, mark);
        if (focusedMark?.id === mark.dataset.annotationId && focusedMark.start === mark.dataset.segmentStart) restoredMark = mark;
        mark.title = note.note || "Saved highlight";
        mark.setAttribute("role", "button");
        mark.setAttribute("tabindex", "0");
        mark.setAttribute("aria-label", `Edit highlight: ${text}`);
        mark.addEventListener("click", () => editAnnotation(note));
        mark.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); editAnnotation(note); }
        });
        fragment.append(mark);
      }
      root.append(fragment);
      if (focusedMark) {
        if (restoredMark) restoredMark.focus({ preventScroll: true });
        else { root.tabIndex = -1; root.focus({ preventScroll: true }); }
      }
    }

    async function loadAnnotations(id, request = state.readerRequest) {
      if (!isCurrent(request) || state.reading?.id !== id) return;
      const annotations = await api(`/api/links/${id}/annotations`);
      if (!isCurrent(request) || state.reading?.id !== id) return;
      state.annotations = annotations || [];
      renderReaderText();
      const list = $("annotation-list"), active = document.activeElement;
      const focusedEdit = list.contains(active) ? active?.dataset?.annotationEdit : null;
      let restoredEdit = null;
      $("annotation-list").replaceChildren();
      for (const annotation of state.annotations) {
        const row = el("article", "annotation-item");
        row.append(el("blockquote", `highlight-${annotation.color}`, annotation.quote));
        if (annotation.note) row.append(el("p", "annotation-note", annotation.note));
        if (annotation.stale) row.append(el("p", "small muted", "The captured text has changed. This highlight belongs to an earlier capture."));
        const edit = el("button", "text-button", "Edit note");
        edit.dataset.annotationEdit = String(annotation.id);
        if (focusedEdit === edit.dataset.annotationEdit) restoredEdit = edit;
        const passage = Array.from(annotation.quote).slice(0, 100).join("");
        edit.setAttribute("aria-label", `Edit annotation: ${passage}`);
        edit.addEventListener("click", () => editAnnotation(annotation));
        const remove = el("button", "text-button", "Delete");
        remove.setAttribute("aria-label", `Delete annotation: ${passage}`);
        remove.addEventListener("click", async () => {
          if (!browser.confirm("Delete this annotation?")) return;
          remove.disabled = true;
          try {
            await api(`/api/links/${id}/annotations/${annotation.id}`, { method: "DELETE" });
            if (isCurrent(request)) toast("Annotation deleted.");
            await refreshAnnotationsAfterChange(id, request);
          } catch (error) { if (isCurrent(request)) { toast(error.message, true); remove.disabled = false; } }
        });
        const actions = el("div", "reader-actions");
        actions.append(edit, remove);
        const anchor = highlightAnchors.get(annotation.id);
        if (anchor) {
          const show = el("button", "text-button", "Show in text");
          show.addEventListener("click", () => {
            showNotebook(false);
            $("reader-text-mode").click();
            const currentAnchor = highlightAnchors.get(annotation.id);
            currentAnchor?.focus({ preventScroll: true });
            currentAnchor?.scrollIntoView({ block: "center", behavior: "auto" });
          });
          actions.append(show);
        }
        row.append(actions);
        $("annotation-list").append(row);
      }
      if (!state.annotations.length) $("annotation-list").append(el("p", "reader-section-empty muted", "No highlights yet. Select a passage in the text reader, then choose Highlight. Highlights stay with the captured version."));
      if (focusedEdit) {
        if (restoredEdit) restoredEdit.focus({ preventScroll: true });
        else { $("annotations-section").tabIndex = -1; $("annotations-section").focus({ preventScroll: true }); }
      }
    }

    async function refreshAnnotationsAfterChange(id, request) {
      try {
        await loadAnnotations(id, request);
        if (isCurrent(request)) { $("annotations-error").hidden = true; $("annotations-retry").hidden = true; }
      } catch (error) {
        if (!isCurrent(request)) return;
        state.annotations = [];
        renderReaderText();
        $("annotation-list").replaceChildren();
        readerSectionError("annotations", error);
      }
    }

    function editAnnotation(annotation) {
      annotationSession++;
      $("annotation-form").querySelector("button[type=submit]").disabled = false;
      state.annotationDraft = annotation;
      $("annotation-quote").textContent = annotation.quote;
      $("annotation-note").value = annotation.note || "";
      $("annotation-color").value = annotation.color || "yellow";
      const draft = drafts.get(annotationKey());
      if (draft) { $("annotation-note").value = draft.note; $("annotation-color").value = draft.color; }
      $("annotation-draft-notice").hidden = !draft;
      $("annotation-error").textContent = "";
      $("annotation-dialog").showModal();
    }
    function annotationKey() { const item = state.annotationDraft; return `annotation:${state.reading?.id}:${item?.id || `${item?.start}:${item?.end}`}`; }
    $("annotation-form").addEventListener("input", () => {
      if (!state.annotationDraft) return;
      drafts.put(annotationKey(), { note: $("annotation-note").value, color: $("annotation-color").value }, { note: state.annotationDraft.note || "", color: state.annotationDraft.color || "yellow" });
    });
    $("annotation-color").addEventListener("change", () => $("annotation-form").dispatchEvent(new browser.Event("input")));
    function rememberReaderSelection() {
      const selection = window.getSelection(), root = $("reader-content");
      if (!state.reading?.content || !selection?.rangeCount || selection.isCollapsed) return null;
      const range = selection.getRangeAt(0);
      if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
      const prefix = range.cloneRange(); prefix.selectNodeContents(root); prefix.setEnd(range.startContainer, range.startOffset);
      const start = Array.from(prefix.toString()).length, quote = range.toString();
      if (!quote.trim()) return null;
      state.readerSelection = { linkId: state.reading.id, quote, start, end: start + Array.from(quote).length };
      return state.readerSelection;
    }
    document.addEventListener("selectionchange", rememberReaderSelection);
    $("reader-content").addEventListener("pointerdown", () => { state.readerSelection = null; });
    document.querySelectorAll("[data-highlight-selection]").forEach((button) => {
      button.addEventListener("pointerdown", (event) => { rememberReaderSelection(); event.preventDefault(); });
      button.addEventListener("click", () => {
        const passage = rememberReaderSelection() || state.readerSelection;
        if (!passage || passage.linkId !== state.reading?.id) { toast("Select a passage in the text reader first.", true); return; }
        editAnnotation({ quote: passage.quote, start: passage.start, end: passage.end, color: "yellow", note: "" });
      });
    });
    $("annotation-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!state.reading || !state.annotationDraft) return;
      const session = annotationSession, linkID = state.reading.id, request = state.readerRequest;
      const key = annotationKey(), draft = state.annotationDraft;
      const submitted = { note: $("annotation-note").value, color: $("annotation-color").value };
      event.submitter.disabled = true;
      $("annotation-error").textContent = "";
      try {
        const saved = await api(`/api/links/${linkID}/annotations${draft.id ? `/${draft.id}` : ""}`, { method: draft.id ? "PUT" : "POST", body: JSON.stringify({ quote: draft.quote, start: draft.start, end: draft.end, ...submitted }) });
        const latest = session === annotationSession && isCurrent(request) ? { note: $("annotation-note").value, color: $("annotation-color").value } : drafts.get(key) || submitted;
        drafts.delete(key);
        const savedKey = `annotation:${linkID}:${saved.id}`;
        drafts.put(savedKey, latest, submitted);
        if (session === annotationSession && isCurrent(request)) {
          state.annotationDraft = { ...draft, ...submitted, id: saved.id };
          if (!drafts.get(savedKey)) $("annotation-dialog").close();
        }
        if (isCurrent(request)) toast("Annotation saved.");
        await refreshAnnotationsAfterChange(linkID, request);
      } catch (error) { if (session === annotationSession && isCurrent(request)) $("annotation-error").textContent = error.message; }
      finally { if (session === annotationSession && isCurrent(request)) event.submitter.disabled = false; }
    });
    $("reader-size").addEventListener("change", () => { $("reader-content").style.fontSize = `${$("reader-size").value}px`; });
    function readerMode(layout) {
      readingView = true;
      state.readerSelection = null;
      $("reader-layout").hidden = !layout; $("reader-content").hidden = layout;
      if (!layout) $("reader-layout").removeAttribute("src");
      $("reader-layout-mode").setAttribute("aria-pressed", String(layout)); $("reader-text-mode").setAttribute("aria-pressed", String(!layout));
      $("reader-size").disabled = layout;
      document.querySelectorAll("[data-highlight-selection]").forEach((button) => { button.disabled = layout || !state.reading?.content; });
    }
    function readerAvailability() {
      if (!state.reading) return;
      const snapshot = workspace.readerSnapshot(state.reading, readerAssets);
      readerLayoutURL = snapshot.url;
      $("reader-layout-mode").disabled = !snapshot.url;
      $("reader-mode-hint").textContent = snapshot.message;
      if (!snapshot.url && readingView) readerMode(false);
    }
    $("reader-layout-mode").addEventListener("click", async () => {
      if (!readerLayoutURL) return;
      const request = ++layoutRequest, readingRequest = state.readerRequest, url = readerLayoutURL;
      $("reader-layout-mode").disabled = true;
      $("reader-mode-hint").textContent = "Opening formatted view…";
      try {
        const response = await browser.fetch(url, { method: "HEAD", credentials: "same-origin" });
        if (request !== layoutRequest || !isCurrent(readingRequest) || url !== readerLayoutURL) return;
        if (response.status === 401) { expireSession(); return; }
        if (!response.ok) throw new Error("Formatted view is unavailable. Read the text or retry after saving an HTML capture.");
        $("reader-layout").src = url; readerMode(true);
        $("reader-mode-hint").textContent = "Formatted page · Text size and highlighting are available in Text & highlights.";
      } catch (error) {
        if (request !== layoutRequest || !isCurrent(readingRequest) || url !== readerLayoutURL) return;
        readerMode(false); $("reader-mode-hint").textContent = error.message;
      } finally { if (request === layoutRequest && isCurrent(readingRequest) && url === readerLayoutURL) $("reader-layout-mode").disabled = !readerLayoutURL; }
    });
    $("reader-text-mode").addEventListener("click", () => { layoutRequest++; readerMode(false); readerAvailability(); });
    const previewable = (asset) => ["text/html", "application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"].includes(asset.mediaType);
    function previewAssets() {
      const assets = readerAssets.filter(previewable).sort((a, b) => b.id - a.id);
      // The structural endpoint prefers HTML attachments, so only use it for
      // the basic archive when no HTML attachment exists. Its source download
      // remains available under Reading options even when attachments exist.
      if (assetsState === "ready" && state.reading?.archiveAvailable && !assets.some(asset => asset.mediaType === "text/html")) assets.push({ id: 0, name: "Basic HTML capture", mediaType: "text/html", basicArchive: true });
      return assets;
    }
    function renderFormats() {
      for (const format of formats) {
        const copies = previewAssets().filter(format.matches);
        const button = $("reader-format-" + format.key);
        button.disabled = !copies.length;
        button.setAttribute("data-saved", String(!!copies.length));
        const status = copies.length ? (copies.length > 1 ? `Saved · ${copies.length} copies` : "Saved") : assetsState === "loading" ? "Checking…" : assetsState === "error" ? "Unknown" : "Not saved";
        $("reader-format-" + format.key + "-status").textContent = status;
        button.setAttribute("aria-label", copies.length ? `Open saved ${format.name}` : `${format.name}: ${status}`);
      }
    }
    for (const format of formats) $("reader-format-" + format.key).addEventListener("click", () => {
      const copies = previewAssets().filter(format.matches);
      if (copies.length) openAsset(copies[0], copies);
    });
    $("asset-viewer-close").addEventListener("click", closeViewer);
    $("asset-viewer").addEventListener("close", () => { if (!$("asset-viewer").open) closeViewer(); });
    $("asset-viewer-select").addEventListener("change", () => showAsset(Number($("asset-viewer-select").value)));
    $("asset-viewer-retry").addEventListener("click", () => showAsset(Number($("asset-viewer-select").value)));

    async function showAsset(assetID) {
      const asset = previewAssets().find((item) => item.id === assetID);
      if (!asset || !previewable(asset)) return;
      const request = ++viewerRequest, readingRequest = state.readerRequest;
      const current = () => request === viewerRequest && isCurrent(readingRequest) && $("asset-viewer").open;
      const url = asset.basicArchive ? `/api/links/${state.reading.id}/reader` : `/api/assets/${asset.id}/view`;
      $("asset-viewer-content").replaceChildren();
      $("asset-viewer-select").value = String(asset.id);
      $("asset-viewer-download").href = asset.basicArchive ? `/api/links/${state.reading.id}/archive` : `/api/assets/${asset.id}`;
      $("asset-viewer-status").textContent = "Opening saved file…";
      $("asset-viewer-retry").hidden = true;
      $("asset-viewer-hint").textContent = asset.basicArchive ? "Basic HTML capture shown as a simplified page. Download the original HTML to keep the saved source."
        : asset.mediaType === "text/html"
        ? "Saved appearance with embedded styles, images and fonts. Scripts, external resources and navigation are blocked; missing resources stay missing."
        : asset.mediaType === "application/pdf" ? "PDF preview uses your browser’s built-in viewer. If unavailable, download the file to open it." : "Scroll to explore the saved image.";
      const failed = (message) => { if (current()) { $("asset-viewer-status").textContent = message; $("asset-viewer-retry").hidden = false; } };
      try {
        const html = asset.mediaType === "text/html" && !asset.basicArchive;
        // Read the actual HTML response so preparation/busy/auth errors cannot
        // be mistaken for a successful iframe load. Rendering stays client-side.
        const response = await browser.fetch(url, { method: html ? "GET" : "HEAD", credentials: "same-origin" });
        if (!current()) return;
        if (response.status === 401) { expireSession(); return; }
        if (!response.ok) throw new Error(response.status === 404 ? "This saved file is no longer available." : "Could not open this preview. Retry or download the original file.");
        const bytes = html ? await response.arrayBuffer() : null;
        if (!current()) return;
        const image = asset.mediaType.startsWith("image/");
        const content = el(image ? "img" : "iframe", image ? "asset-viewer-image" : "asset-viewer-frame");
        if (image) content.alt = asset.name;
        else {
          content.title = asset.name;
          if (asset.basicArchive) content.setAttribute("sandbox", "");
          // HTML is placed in the trusted shell's nested opaque sandbox. The
          // shell's blob-only frame policy also prevents self-navigation to HTTP.
        }
        content.addEventListener("load", () => {
          if (!current()) return;
          if (html) content.contentWindow.postMessage({ type: "pocketmark-preview", bytes }, browser.location.origin);
          else $("asset-viewer-status").textContent = asset.name;
        });
        content.addEventListener("error", () => failed("Preview could not be displayed. Retry or download the original file."));
        content.src = html ? "/asset-preview.html" : url;
        $("asset-viewer-content").replaceChildren(content);
        // Retry stays available when a browser cannot render a native format.
        $("asset-viewer-retry").hidden = false;
      } catch (error) { failed(error.message); }
    }
    browser.addEventListener("message", (event) => {
      const frame = $("asset-viewer-content").children[0];
      if (event.origin !== browser.location.origin || event.source !== frame?.contentWindow || event.data?.type !== "pocketmark-preview-ready" || !$("asset-viewer").open) return;
      const asset = previewAssets().find((item) => String(item.id) === $("asset-viewer-select").value);
      if (asset) $("asset-viewer-status").textContent = asset.name;
    });
    function openAsset(asset, copies = previewAssets()) {
      $("asset-viewer-select").replaceChildren(...copies.map((item) => {
        const option = el("option", "", item.name); option.value = String(item.id); return option;
      }));
      if (!$("asset-viewer").open) $("asset-viewer").showModal();
      showAsset(asset.id);
    }

    async function refreshAssetsAfterChange(id, request) {
      try {
        await loadAssets(id, request);
        if (isCurrent(request)) { $("assets-error").hidden = true; $("assets-retry").hidden = true; }
      } catch (error) {
        if (!isCurrent(request)) return;
        readerAssets = [];
        $("asset-list").replaceChildren();
        readerAvailability();
        readerSectionError("assets", error);
      }
    }

    async function loadAssets(id, request = state.readerRequest) {
      if (!isCurrent(request) || state.reading?.id !== id) return;
      const assets = await api(`/api/links/${id}/assets`);
      if (!isCurrent(request) || state.reading?.id !== id) return;
      readerAssets = assets || [];
      assetsState = "ready";
      renderFormats();
      $("reader-formats-error").hidden = true;
      $("reader-formats-retry").hidden = true;
      readerAvailability();
      $("asset-list").replaceChildren();
      for (const asset of assets || []) {
        const row = el("div", "asset-item");
        const download = el("a", "", asset.name); download.href = `/api/assets/${asset.id}`; download.setAttribute("download", "");
        row.append(download, el("span", "small muted", `${(asset.size / 1024).toFixed(1)} KiB`));
        if (previewable(asset)) {
          const view = el("button", "text-button", "View");
          view.setAttribute("aria-label", `View ${asset.name}`);
          view.addEventListener("click", () => openAsset(asset));
          row.append(view);
        }
        if (asset.mediaType === "text/html" && asset.size <= 2 * 1024 * 1024) {
          const read = el("button", "text-button", "Read");
          read.setAttribute("aria-label", `Read ${asset.name}`);
          read.addEventListener("click", () => { showNotebook(false); $("reader-text-panel").focus({ preventScroll: true }); $("reader-text-panel").scrollTop = 0; readerLayoutURL = `/api/links/${id}/reader?asset=${asset.id}`; $("reader-layout-mode").disabled = false; $("reader-layout-mode").click(); });

          row.append(read);
        }
        const remove = el("button", "text-button", "Delete");
        remove.setAttribute("aria-label", `Delete ${asset.name}`);
        remove.addEventListener("click", async () => {
          if (!browser.confirm(`Delete saved file “${asset.name}”?`)) return;
          remove.disabled = true;
          try {
            await api(`/api/assets/${asset.id}`, { method: "DELETE" });
            if (isCurrent(request)) toast("File deleted.");
            await refreshAssetsAfterChange(id, request);
          } catch (error) { if (isCurrent(request)) { toast(error.message, true); remove.disabled = false; } }
        });
        row.append(remove); $("asset-list").append(row);
      }
      if (!assets?.length) $("asset-list").append(el("p", "reader-section-empty muted", state.reading.type === "file" ? "No saved files yet. Attach a file to keep it with this bookmark." : "No saved files yet. Attach a file or choose an HTML copy when adding or editing this bookmark."));
    }

    $("asset-upload-button").addEventListener("click", () => { if (!$("asset-file").disabled) $("asset-file").click(); });
    $("asset-file").addEventListener("change", async () => {
      const file = $("asset-file").files[0];
      if (!file || !state.reading) return;
      const id = state.reading.id, request = state.readerRequest;
      $("asset-file").disabled = true;
      $("asset-upload-button").setAttribute("aria-disabled", "true");
      $("asset-upload-button").textContent = "Uploading file…";
      try {
        if (file.size > 20 * 1024 * 1024) throw new Error("Choose a file smaller than 20 MiB.");
        await api(`/api/links/${id}/assets?name=${encodeURIComponent(file.name)}`, { method: "POST", headers: { "Content-Type": file.type || (/\.html?$/i.test(file.name) ? "text/html" : "application/octet-stream") }, body: file });
        if (isCurrent(request)) toast("File saved.");
        await refreshAssetsAfterChange(id, request);
      } catch (error) { if (isCurrent(request)) toast(error.message, true); } finally { if (isCurrent(request)) { $("asset-file").value = ""; $("asset-file").disabled = false; $("asset-upload-button").removeAttribute("aria-disabled"); $("asset-upload-button").textContent = "Attach a saved file"; } }
    });
    return { open: openReader, close };
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { create };
  else root.PocketmarkReader = { create };
})(globalThis);
