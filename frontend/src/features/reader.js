import PocketmarkSelect from "../../../internal/webui/static/select.js";
import { createLifecycle } from "../lib/lifecycle.js";
import { createReaderPage } from "./reader-page.js";
import { loadReaderArticle } from "./reader-article.js";

import workspace from "./workspace.js";

// The reader owns its DOM events and session state. Callers only open/close it;
// the browser adapter and application callbacks keep its implementation testable.
function create(
  {
    api: request,
    drafts,
    toast,
    confirmAction,
    breadcrumbs,
    onChange,
    onSessionExpired,
  },
  browser = globalThis,
) {
  const lifecycle = createLifecycle(browser);
  const document = browser.document,
    window = browser;
  const $ = (id) => document.getElementById(id);
  const {
    editableBookmark: editable,
    bookmarkDraftKey: draftKey,
    safeURL,
    domain,
  } = workspace;
  const state = {
    reading: null,
    readerRequest: 0,
    annotations: [],
    annotationDraft: null,
    readerSelection: null,
  };
  let annotationSession = 0;
  let readerAssets = [];
  let articleRequest;
  let highlighting = false;
  let capturePending = false;
  let viewerRequest = 0;
  let retryReaderID = null;
  let activeSection = "reader-notes-form";

  let assetsState = "loading";
  const formats = [
    {
      key: "html",
      name: "HTML",
      matches: (asset) => asset.mediaType === "text/html",
    },
    {
      key: "image",
      name: "Screenshot",
      matches: (asset) =>
        ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
          asset.mediaType,
        ),
    },
    {
      key: "pdf",
      name: "PDF",
      matches: (asset) => asset.mediaType === "application/pdf",
    },
  ];
  const highlightAnchors = new Map();
  const sectionButtons = [
    ...document.querySelectorAll("[data-reader-section]"),
  ];
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
  lifecycle.listen($("reader-notebook-toggle"), "click", () =>
    showNotebook($("reader-notebook").hidden),
  );
  lifecycle.listen($("reader-notebook-close"), "click", () => {
    showNotebook(false);
    $("reader-notebook-toggle").focus({ preventScroll: true });
  });

  function setReaderState(kind, title = "", detail = "") {
    const panel = $("reader-state");
    panel.dataset.kind = kind;
    panel.hidden = !title;
    $("reader-status").textContent = title;
    $("reader-status-detail").textContent = detail;
  }

  function finishArticleState() {
    const link = state.reading;
    if (
      !link ||
      link.content ||
      ["failed", "pending", "processing"].includes(link.status)
    )
      return;
    if (assetsState === "error" || $("reader-rich-article").hasChildNodes())
      setReaderState("");
    else setReaderState("empty", "Article text unavailable");
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
  function isCurrent(token) {
    return token === state.readerRequest && $("reader-dialog").open;
  }
  function invalidate() {
    closeViewer();
    state.readerRequest++;
    articleRequest?.abort();
    annotationSession++;
    state.reading = null;
    state.annotationDraft = null;
    state.readerSelection = null;
    retryReaderID = null;
    state.annotations = [];
    readerAssets = [];
    $("reader-rich-article").replaceChildren();
    $("reader-rich-article").hidden = true;
  }
  function close() {
    invalidate();
    if ($("annotation-dialog").open) $("annotation-dialog").close();
    if ($("reader-dialog").open) $("reader-dialog").close();
  }
  function expireSession() {
    close();
    onSessionExpired();
  }
  async function api(path, options) {
    try {
      return await request(path, options);
    } catch (error) {
      if (error.status === 401) expireSession();
      throw error;
    }
  }
  const readerDialog = $("reader-dialog");
  const page = createReaderPage({ document, lifecycle, breadcrumbs, close });
  lifecycle.listen(readerDialog, "close", () => {
    if (!readerDialog.open) invalidate();
  });
  lifecycle.listen($("annotation-dialog"), "close", () => {
    if (!$("annotation-dialog").open) {
      annotationSession++;
      state.annotationDraft = null;
    }
  });

  async function openReader(id, recheck = false) {
    closeViewer();
    retryReaderID = null;
    $("reader-retry-open").hidden = true;
    const scroll = recheck ? $("reader-text-panel").scrollTop : 0;
    $("reader-text-panel").scrollTop = 0;
    const request = ++state.readerRequest;
    annotationSession++;
    state.annotationDraft = null;
    if ($("annotation-dialog").open) $("annotation-dialog").close();
    if (!recheck) {
      highlighting = false;
      activeSection = "reader-notes-form";
      showNotebook(false);
      page.reset();
    }
    articleRequest?.abort();
    capturePending = false;
    state.reading = null;
    state.readerSelection = null;
    state.annotations = [];
    readerAssets = [];
    assetsState = "loading";
    $("reader-notebook-toggle").disabled = true;
    readerDialog.scrollTop = 0;
    $("reader-title").textContent = "Opening your bookmark…";
    page.setTitle($("reader-title").textContent);
    for (const field of ["reader-source", "reader-read-time", "reader-content"])
      $(field).textContent = "";
    setReaderState("");
    for (const field of [
      "reader-content",
      "reader-rich-article",
      "reader-highlight",
      "reader-article-mode",
      "reader-text-mode",
      "reader-section-nav",
      "annotations-section",
      "reader-formats-error",
      "reader-formats-retry",
      "reader-recheck",
      "reader-retry-capture",
      "annotations-error",
      "annotations-retry",
    ])
      $(field).hidden = true;
    $("reader-rich-article").replaceChildren();
    $("annotation-list").replaceChildren();
    $("reader-retry-capture").removeAttribute("aria-disabled");
    $("reader-formats-retry").disabled = false;
    $("annotations-retry").disabled = false;
    $("reader-size").disabled = true;
    renderFormats();
    $("reader-notes").value = "";
    $("reader-notes-form").querySelector("button[type=submit]").disabled =
      false;
    $("reader-error").textContent = "";
    $("reader-original").hidden = true;
    $("reader-notes-form").hidden = true;
    if (!$("reader-dialog").open) $("reader-dialog").showModal();
    try {
      const link = await api(`/api/links/${id}`);
      if (!isCurrent(request)) return;
      state.reading = link;
      $("reader-section-nav").hidden = false;
      $("reader-title").textContent =
        link.title || safeURL(link.url) || "Saved file";
      page.setTitle($("reader-title").textContent);
      const url = safeURL(link.url);
      const source = url ? domain(url) : "Saved file";
      $("reader-source").textContent = source;
      showReadTime(link.content);
      $("reader-original").hidden = !url;
      if (url) $("reader-original").href = url;
      else $("reader-original").removeAttribute("href");
      $("reader-content").textContent = link.content || "";
      $("reader-content").hidden = !link.content;
      $("reader-size").disabled = false;
      updateSize();
      if (link.status === "failed")
        setReaderState(
          "failed",
          "Capture failed",
          link.error ? workspace.captureFailure(link.error) : "",
        );
      else if (link.status === "pending")
        setReaderState("pending", "Capture queued");
      else if (link.status === "processing")
        setReaderState("pending", "Capture in progress");
      else if (!link.content) setReaderState("loading", "Opening article…");
      $("reader-retry-capture").hidden =
        link.status !== "failed" || link.type === "file";
      $("reader-recheck").hidden = !["pending", "processing"].includes(
        link.status,
      );
      const draft = drafts.get(draftKey(link));
      $("reader-notes").value = draft?.notes ?? link.notes ?? "";
      $("reader-notes-draft").hidden =
        !draft || draft.notes === (link.notes || "");
      selectSection(activeSection);
      $("reader-notebook-toggle").disabled = false;
      document
        .querySelectorAll("[data-highlight-selection]")
        .forEach((button) => {
          button.disabled = !link.content;
        });
      const loaded = await Promise.allSettled([
        loadAnnotations(id, request),
        loadAssets(id, request),
      ]);
      if (!isCurrent(request)) return;
      loaded.forEach((result, i) => {
        if (result.status === "rejected")
          readerSectionError(i ? "assets" : "annotations", result.reason);
      });
      if (recheck) $("reader-text-panel").scrollTop = scroll;
    } catch (error) {
      if (!isCurrent(request)) return;
      $("reader-title").textContent = "Could not open this bookmark";
      page.setTitle($("reader-title").textContent);
      setReaderState("failed", error.message || "Bookmark unavailable");
      retryReaderID = id;
      $("reader-retry-open").hidden = false;
    }
  }

  lifecycle.listen($("reader-retry-open"), "click", () => {
    if (retryReaderID === null) return;
    const id = retryReaderID;
    $("reader-title").tabIndex = -1;
    $("reader-title").focus({ preventScroll: true });
    openReader(id);
  });

  function readerSectionError(section, error) {
    if (section === "assets") {
      assetsState = "error";
      finishArticleState();
      renderFormats();
      $("reader-formats-error").textContent = "Could not check saved formats.";
      $("reader-formats-error").hidden = false;
      $("reader-formats-retry").hidden = false;
    } else {
      $("annotations-error").textContent =
        `Could not load highlights. ${error.message}`;
      $("annotations-error").hidden = false;
      $("annotations-retry").hidden = false;
    }
  }
  for (const [section, prefix, load] of [
    ["assets", "reader-formats", loadAssets],
    ["annotations", "annotations", loadAnnotations],
  ]) {
    const retry = $(prefix + "-retry");
    lifecycle.listen(retry, "click", async () => {
      if (!state.reading || retry.disabled) return;
      const request = state.readerRequest;
      retry.disabled = true;
      try {
        await load(state.reading.id, request);
        if (isCurrent(request)) {
          $(prefix + "-error").hidden = true;
          retry.hidden = true;
        }
      } catch (error) {
        if (isCurrent(request)) readerSectionError(section, error);
      } finally {
        if (isCurrent(request)) retry.disabled = false;
      }
    });
  }
  lifecycle.listen($("reader-recheck"), "click", () => {
    if (!state.reading) return;
    $("reader-title").tabIndex = -1;
    $("reader-title").focus({ preventScroll: true });
    openReader(state.reading.id, true);
  });
  sectionButtons.forEach((button, index) => {
    lifecycle.listen(button, "click", () => {
      selectSection(button.dataset.readerSection);
      showNotebook(true);
    });
    lifecycle.listen(button, "keydown", (event) => {
      let next;
      if (event.key === "ArrowRight")
        next = (index + 1) % sectionButtons.length;
      else if (event.key === "ArrowLeft")
        next = (index + sectionButtons.length - 1) % sectionButtons.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = sectionButtons.length - 1;
      else return;
      event.preventDefault();
      sectionButtons[next].click();
      sectionButtons[next].focus({ preventScroll: true });
    });
  });
  lifecycle.listen($("reader-notes"), "input", () => {
    if (!state.reading) return;
    const draft =
      drafts.get(draftKey(state.reading)) || editable(state.reading);
    draft.notes = $("reader-notes").value;
    drafts.put(draftKey(state.reading), draft, editable(state.reading));
    $("reader-notes-draft").hidden =
      draft.notes === (state.reading.notes || "");
  });
  lifecycle.listen($("discard-reader-notes"), "click", async () => {
    const request = state.readerRequest;
    if (
      !state.reading ||
      !(await confirmAction(
        "Discard notes?",
        "Discard these unsaved notes?",
        "Discard notes",
      )) ||
      !isCurrent(request)
    )
      return;
    $("reader-notes").value = state.reading.notes || "";
    $("reader-notes").dispatchEvent(new browser.Event("input"));
  });

  async function capture() {
    if (!state.reading || capturePending || state.reading.type === "file")
      return;
    const id = state.reading.id,
      request = state.readerRequest;
    capturePending = true;
    $("reader-retry-capture").setAttribute("aria-disabled", "true");
    $("reader-error").textContent = "";
    try {
      await api(`/api/links/${id}/capture`, { method: "POST" });
      if (isCurrent(request)) {
        const retryFocused =
          document.activeElement === $("reader-retry-capture");
        setReaderState("pending", "Capture queued");
        $("reader-retry-capture").hidden = true;
        $("reader-recheck").hidden = false;
        if (retryFocused) $("reader-recheck").focus({ preventScroll: true });
      }
      await onChange();
    } catch (error) {
      if (isCurrent(request)) {
        if (!$("reader-retry-capture").hidden)
          setReaderState("failed", "Could not retry capture", error.message);
        else $("reader-error").textContent = error.message;
      }
    } finally {
      if (isCurrent(request)) {
        capturePending = false;
        $("reader-retry-capture").removeAttribute("aria-disabled");
      }
    }
  }
  lifecycle.listen($("reader-retry-capture"), "click", capture);
  lifecycle.listen($("reader-notes-form"), "submit", async (event) => {
    event.preventDefault();
    if (!state.reading) return;
    const button = event.submitter;
    const link = state.reading,
      request = state.readerRequest,
      key = draftKey(link);
    button.disabled = true;
    $("reader-error").textContent = "";
    try {
      const notes = $("reader-notes").value;
      await api(`/api/links/${link.id}`, {
        method: "PUT",
        body: JSON.stringify({ ...editable(link), notes }),
      });
      link.notes = notes;
      const remaining =
        drafts.get(key) || (isCurrent(request) ? editable(link) : null);
      if (remaining && isCurrent(request))
        remaining.notes = $("reader-notes").value;
      if (remaining) drafts.put(key, remaining, editable(link));
      if (isCurrent(request))
        $("reader-notes-draft").hidden = $("reader-notes").value === notes;
      toast("Notes saved.");
      await onChange();
    } catch (error) {
      if (isCurrent(request)) $("reader-error").textContent = error.message;
      else toast(error.message, true);
    } finally {
      if (isCurrent(request)) button.disabled = false;
    }
  });

  function renderReaderText() {
    const content = state.reading?.content || "";
    const root = $("reader-content");
    const active = document.activeElement;
    const focusedMark =
      active?.dataset?.annotationId && root.contains(active)
        ? {
            id: active.dataset.annotationId,
            start: active.dataset.segmentStart,
          }
        : null;
    let restoredMark = null;
    root.replaceChildren();
    highlightAnchors.clear();
    if (!content) {
      if (focusedMark) {
        root.tabIndex = -1;
        root.focus({ preventScroll: true });
      }
      return;
    }
    const points = Array.from(content);
    const notes = state.annotations.filter(
      (item) =>
        !item.stale &&
        item.start >= 0 &&
        item.end <= points.length &&
        item.start < item.end &&
        points.slice(item.start, item.end).join("") === item.quote,
    );
    // Split overlapping highlights into bounded segments without trusting any captured markup.
    const boundaries = [
      ...new Set([
        0,
        points.length,
        ...notes.flatMap((item) => [item.start, item.end]),
      ]),
    ].sort((a, b) => a - b);
    const fragment = document.createDocumentFragment();
    for (let i = 1; i < boundaries.length; i++) {
      const start = boundaries[i - 1],
        end = boundaries[i];
      const text = points.slice(start, end).join("");
      const note = notes.find((item) => item.start <= start && item.end >= end);
      if (!note) {
        fragment.append(document.createTextNode(text));
        continue;
      }
      const mark = el(
        "mark",
        `highlight-${["yellow", "green", "blue", "pink"].includes(note.color) ? note.color : "yellow"}`,
        text,
      );
      mark.dataset.annotationId = String(note.id);
      mark.dataset.segmentStart = String(start);
      if (!highlightAnchors.has(note.id)) highlightAnchors.set(note.id, mark);
      if (
        focusedMark?.id === mark.dataset.annotationId &&
        focusedMark.start === mark.dataset.segmentStart
      )
        restoredMark = mark;
      mark.title = note.note || "Saved highlight";
      mark.setAttribute("role", "button");
      mark.setAttribute("tabindex", "0");
      mark.setAttribute("aria-label", `Edit highlight: ${text}`);
      lifecycle.listen(mark, "click", () => editAnnotation(note));
      lifecycle.listen(mark, "keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          editAnnotation(note);
        }
      });
      fragment.append(mark);
    }
    root.append(fragment);
    if (focusedMark) {
      if (restoredMark) restoredMark.focus({ preventScroll: true });
      else {
        root.tabIndex = -1;
        root.focus({ preventScroll: true });
      }
    }
  }

  async function loadAnnotations(id, request = state.readerRequest) {
    if (!isCurrent(request) || state.reading?.id !== id) return;
    const annotations = await api(`/api/links/${id}/annotations`);
    if (!isCurrent(request) || state.reading?.id !== id) return;
    state.annotations = annotations || [];
    renderReaderText();
    const list = $("annotation-list"),
      active = document.activeElement;
    const focusedEdit = list.contains(active)
      ? active?.dataset?.annotationEdit
      : null;
    let restoredEdit = null;
    $("annotation-list").replaceChildren();
    for (const annotation of state.annotations) {
      const row = el("article", "annotation-item");
      row.append(
        el("blockquote", `highlight-${annotation.color}`, annotation.quote),
      );
      if (annotation.note)
        row.append(el("p", "annotation-note", annotation.note));
      if (annotation.stale)
        row.append(
          el(
            "p",
            "small muted",
            "The captured text has changed. This highlight belongs to an earlier capture.",
          ),
        );
      const edit = el("button", "text-button", "Edit note");
      edit.dataset.annotationEdit = String(annotation.id);
      if (focusedEdit === edit.dataset.annotationEdit) restoredEdit = edit;
      const passage = Array.from(annotation.quote).slice(0, 100).join("");
      edit.setAttribute("aria-label", `Edit annotation: ${passage}`);
      lifecycle.listen(edit, "click", () => editAnnotation(annotation));
      const remove = el("button", "text-button destructive-action", "Delete");
      remove.setAttribute("aria-label", `Delete annotation: ${passage}`);
      lifecycle.listen(remove, "click", async () => {
        if (
          !(await confirmAction(
            "Delete annotation?",
            "Delete this annotation?",
            "Delete annotation",
          )) ||
          !isCurrent(request)
        )
          return;
        remove.disabled = true;
        try {
          await api(`/api/links/${id}/annotations/${annotation.id}`, {
            method: "DELETE",
          });
          if (isCurrent(request)) toast("Annotation deleted.");
          await refreshAnnotationsAfterChange(id, request);
        } catch (error) {
          if (isCurrent(request)) {
            toast(error.message, true);
            remove.disabled = false;
          }
        }
      });
      const actions = el("div", "reader-actions");
      actions.append(edit, remove);
      const anchor = highlightAnchors.get(annotation.id);
      if (anchor) {
        const show = el("button", "text-button", "Show in text");
        lifecycle.listen(show, "click", () => {
          showNotebook(false);
          setHighlighting(true);
          const currentAnchor = highlightAnchors.get(annotation.id);
          currentAnchor?.focus({ preventScroll: true });
          currentAnchor?.scrollIntoView({ block: "center", behavior: "auto" });
        });
        actions.append(show);
      }
      row.append(actions);
      $("annotation-list").append(row);
    }
    if (!state.annotations.length)
      $("annotation-list").append(
        el("p", "reader-section-empty muted", "No highlights yet."),
      );
    if (focusedEdit) {
      if (restoredEdit) restoredEdit.focus({ preventScroll: true });
      else {
        $("annotations-section").tabIndex = -1;
        $("annotations-section").focus({ preventScroll: true });
      }
    }
  }

  async function refreshAnnotationsAfterChange(id, request) {
    try {
      await loadAnnotations(id, request);
      if (isCurrent(request)) {
        $("annotations-error").hidden = true;
        $("annotations-retry").hidden = true;
      }
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
    if (draft) {
      $("annotation-note").value = draft.note;
      $("annotation-color").value = draft.color;
    }
    PocketmarkSelect.sync($("annotation-color"));
    $("annotation-draft-notice").hidden = !draft;
    $("annotation-error").textContent = "";
    $("annotation-dialog").showModal();
  }
  function annotationKey() {
    const item = state.annotationDraft;
    return `annotation:${state.reading?.id}:${item?.id || `${item?.start}:${item?.end}`}`;
  }
  lifecycle.listen($("annotation-form"), "input", () => {
    if (!state.annotationDraft) return;
    drafts.put(
      annotationKey(),
      { note: $("annotation-note").value, color: $("annotation-color").value },
      {
        note: state.annotationDraft.note || "",
        color: state.annotationDraft.color || "yellow",
      },
    );
  });
  lifecycle.listen($("annotation-color"), "change", () =>
    $("annotation-form").dispatchEvent(new browser.Event("input")),
  );
  function clearReaderSelection() {
    state.readerSelection = null;
    $("reader-highlight").hidden = true;
  }
  function rememberReaderSelection() {
    const selection = window.getSelection(),
      root = $("reader-content");
    if (
      !state.reading?.content ||
      !selection?.rangeCount ||
      selection.isCollapsed
    )
      return null;
    const range = selection.getRangeAt(0);
    const article = $("reader-rich-article");
    if (
      ![range.startContainer, range.endContainer].some(
        (node) => root.contains(node) || article.contains(node),
      )
    )
      return null;
    clearReaderSelection();
    const quote = range.toString();
    if (!quote.trim()) return null;
    let start;
    if (
      root.contains(range.startContainer) &&
      root.contains(range.endContainer)
    ) {
      const prefix = range.cloneRange();
      prefix.selectNodeContents(root);
      prefix.setEnd(range.startContainer, range.startOffset);
      start = Array.from(prefix.toString()).length;
    } else {
      if (
        !article.contains(range.startContainer) ||
        !article.contains(range.endContainer)
      )
        return null;
      // Rich copies and extracted text may differ. Only an unambiguous exact
      // match can be stored at an offset in the canonical Unicode text.
      const content = state.reading.content;
      const index = content.indexOf(quote);
      if (index < 0 || index !== content.lastIndexOf(quote)) return null;
      start = Array.from(content.slice(0, index)).length;
    }
    $("reader-highlight").hidden = false;
    state.readerSelection = {
      linkId: state.reading.id,
      quote,
      start,
      end: start + Array.from(quote).length,
    };
    return state.readerSelection;
  }
  lifecycle.listen(document, "selectionchange", rememberReaderSelection);
  for (const target of [$("reader-content"), $("reader-rich-article")]) {
    lifecycle.listen(target, "pointerdown", clearReaderSelection);
  }
  document.querySelectorAll("[data-highlight-selection]").forEach((button) => {
    lifecycle.listen(button, "pointerdown", (event) => {
      rememberReaderSelection();
      event.preventDefault();
    });
    lifecycle.listen(button, "click", () => {
      const passage = rememberReaderSelection() || state.readerSelection;
      if (!passage || passage.linkId !== state.reading?.id) {
        toast(
          $("reader-rich-article").hidden
            ? "Select a passage in the article first."
            : "Choose Read text for highlighting, then select a passage.",
          true,
        );
        return;
      }
      editAnnotation({
        quote: passage.quote,
        start: passage.start,
        end: passage.end,
        color: "yellow",
        note: "",
      });
    });
  });
  lifecycle.listen($("annotation-form"), "submit", async (event) => {
    event.preventDefault();
    if (!state.reading || !state.annotationDraft) return;
    const session = annotationSession,
      linkID = state.reading.id,
      request = state.readerRequest;
    const key = annotationKey(),
      draft = state.annotationDraft;
    const submitted = {
      note: $("annotation-note").value,
      color: $("annotation-color").value,
    };
    event.submitter.disabled = true;
    $("annotation-error").textContent = "";
    try {
      const saved = await api(
        `/api/links/${linkID}/annotations${draft.id ? `/${draft.id}` : ""}`,
        {
          method: draft.id ? "PUT" : "POST",
          body: JSON.stringify({
            quote: draft.quote,
            start: draft.start,
            end: draft.end,
            ...submitted,
          }),
        },
      );
      const latest =
        session === annotationSession && isCurrent(request)
          ? {
              note: $("annotation-note").value,
              color: $("annotation-color").value,
            }
          : drafts.get(key) || submitted;
      drafts.delete(key);
      const savedKey = `annotation:${linkID}:${saved.id}`;
      drafts.put(savedKey, latest, submitted);
      if (session === annotationSession && isCurrent(request)) {
        state.annotationDraft = { ...draft, ...submitted, id: saved.id };
        if (!drafts.get(savedKey)) $("annotation-dialog").close();
      }
      if (isCurrent(request)) toast("Annotation saved.");
      await refreshAnnotationsAfterChange(linkID, request);
    } catch (error) {
      if (session === annotationSession && isCurrent(request))
        $("annotation-error").textContent = error.message;
    } finally {
      if (session === annotationSession && isCurrent(request))
        event.submitter.disabled = false;
    }
  });
  function showReadTime(text) {
    const words = text?.match(/\S+/gu)?.length || 0;
    $("reader-read-time").textContent = words
      ? `${Math.ceil(words / 220)} min read`
      : "";
  }
  function updateSize() {
    const select = $("reader-size");
    for (const root of [$("reader-content"), $("reader-rich-article")])
      root.style.fontSize = `${select.value}px`;
    const label = `Text size, ${select.selectedOptions[0].textContent}`;
    select.setAttribute("aria-label", label);
    PocketmarkSelect.sync(select);
  }
  lifecycle.listen($("reader-size"), "change", updateSize);
  function setHighlighting(active) {
    highlighting = active && Boolean(state.reading?.content);
    const rich = $("reader-rich-article");
    const hasArticle = rich.hasChildNodes();
    rich.hidden = !hasArticle || highlighting;
    $("reader-content").hidden = !rich.hidden || !state.reading?.content;
    $("reader-text-mode").hidden =
      !hasArticle || highlighting || !state.reading?.content;
    $("reader-article-mode").hidden = !hasArticle || !highlighting;
    clearReaderSelection();
  }
  lifecycle.listen($("reader-text-mode"), "click", () => {
    setHighlighting(true);
    showNotebook(false);
    $("reader-content").focus({ preventScroll: true });
  });
  lifecycle.listen($("reader-article-mode"), "click", () => {
    setHighlighting(false);
    $("reader-rich-article").focus({ preventScroll: true });
  });
  const previewable = (asset) =>
    [
      "text/html",
      "application/pdf",
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
    ].includes(asset.mediaType);
  function previewAssets() {
    const assets = readerAssets.filter(previewable).sort((a, b) => b.id - a.id);
    // The simplified viewer serves the latest HTML attachment ahead of the basic archive.
    if (
      assetsState === "ready" &&
      state.reading?.archiveAvailable &&
      !assets.some((asset) => asset.mediaType === "text/html")
    )
      assets.push({
        id: 0,
        name: "Basic HTML capture",
        mediaType: "text/html",
        basicArchive: true,
      });
    return assets;
  }
  function renderFormats() {
    const assets = previewAssets();
    for (const format of formats) {
      const copies = assets.filter(format.matches);
      const key = "reader-format-" + format.key;
      const button = $(key);
      const wrapper = $(key + "-tool");
      const available = copies.length > 0;
      button.disabled = !available;
      const status =
        assetsState === "loading"
          ? "Checking…"
          : assetsState === "error"
            ? "Unknown"
            : "Not saved";
      const label = available
        ? "Open saved " + format.name
        : `${format.name} · ${status}`;
      const hint =
        copies.length > 1 ? `${label} · ${copies.length} copies` : label;
      button.setAttribute("aria-label", hint);
      button.title = hint;
      $(key + "-status").textContent = hint;
      wrapper.tabIndex = available ? -1 : 0;
      if (available) {
        wrapper.removeAttribute("role");
        wrapper.removeAttribute("aria-label");
      } else {
        wrapper.setAttribute("role", "group");
        wrapper.setAttribute("aria-label", label);
      }
    }
    $("reader-formats-summary").textContent =
      assetsState === "loading"
        ? "Checking saved copies…"
        : assetsState === "ready" && !assets.length
          ? "No saved copies yet."
          : "";
  }
  for (const format of formats) {
    const button = $("reader-format-" + format.key);
    lifecycle.listen(button, "click", () => {
      const copies = previewAssets().filter(format.matches);
      if (!copies.length) return;
      button.focus({ preventScroll: true });
      openAsset(copies[0], copies);
    });
  }
  lifecycle.listen($("asset-viewer-close"), "click", closeViewer);
  lifecycle.listen($("asset-viewer"), "close", () => {
    if (!$("asset-viewer").open) closeViewer();
  });
  lifecycle.listen($("asset-viewer-select"), "change", () =>
    showAsset(Number($("asset-viewer-select").value)),
  );
  lifecycle.listen($("asset-viewer-retry"), "click", () =>
    showAsset(Number($("asset-viewer-select").value)),
  );

  async function showAsset(assetID) {
    const asset = previewAssets().find((item) => item.id === assetID);
    if (!asset || !previewable(asset)) return;
    const request = ++viewerRequest,
      readingRequest = state.readerRequest;
    const current = () =>
      request === viewerRequest &&
      isCurrent(readingRequest) &&
      $("asset-viewer").open;
    const url = asset.basicArchive
      ? `/api/links/${state.reading.id}/reader`
      : `/api/assets/${asset.id}/view`;
    $("asset-viewer-content").replaceChildren();
    $("asset-viewer-select").value = String(asset.id);
    PocketmarkSelect.sync($("asset-viewer-select"));
    $("asset-viewer-download").href = asset.basicArchive
      ? `/api/links/${state.reading.id}/archive`
      : `/api/assets/${asset.id}`;
    $("asset-viewer-status").textContent = "Opening saved file…";
    $("asset-viewer-retry").hidden = true;
    $("asset-viewer-retry").className = "text-button";
    const failed = (message) => {
      if (current()) {
        $("asset-viewer-status").textContent = message;
        $("asset-viewer-retry").className = "button primary";
        $("asset-viewer-retry").hidden = false;
      }
    };
    try {
      const html = asset.mediaType === "text/html" && !asset.basicArchive;
      // Read the actual HTML response so preparation/busy/auth errors cannot
      // be mistaken for a successful iframe load. Rendering stays client-side.
      const response = await browser.fetch(url, {
        method: html ? "GET" : "HEAD",
        credentials: "same-origin",
      });
      if (!current()) return;
      if (response.status === 401) {
        expireSession();
        return;
      }
      if (!response.ok)
        throw new Error(
          response.status === 404
            ? "This saved file is no longer available."
            : "Could not open this preview. Retry or download the original file.",
        );
      const bytes = html ? await response.arrayBuffer() : null;
      if (!current()) return;
      const image = asset.mediaType.startsWith("image/");
      const content = el(
        image ? "img" : "iframe",
        image ? "asset-viewer-image" : "asset-viewer-frame",
      );
      if (image) content.alt = asset.name;
      else {
        content.title = asset.name;
        if (asset.basicArchive) content.setAttribute("sandbox", "");
        // HTML is placed in the trusted shell's nested opaque sandbox. The
        // shell's blob-only frame policy also prevents self-navigation to HTTP.
      }
      lifecycle.listen(content, "load", () => {
        if (!current()) return;
        if (html)
          content.contentWindow.postMessage(
            { type: "pocketmark-preview", bytes },
            browser.location.origin,
          );
        else $("asset-viewer-status").textContent = asset.name;
      });
      lifecycle.listen(content, "error", () =>
        failed(
          "Preview could not be displayed. Retry or download the original file.",
        ),
      );
      content.src = html ? "/asset-preview.html" : url;
      $("asset-viewer-content").replaceChildren(content);
      // Retry stays available when a browser cannot render a native format.
      $("asset-viewer-retry").hidden = false;
    } catch (error) {
      failed(error.message);
    }
  }
  lifecycle.listen(browser, "message", (event) => {
    const frame = $("asset-viewer-content").children[0];
    if (
      event.origin !== browser.location.origin ||
      event.source !== frame?.contentWindow ||
      event.data?.type !== "pocketmark-preview-ready" ||
      !$("asset-viewer").open
    )
      return;
    const asset = previewAssets().find(
      (item) => String(item.id) === $("asset-viewer-select").value,
    );
    if (asset) $("asset-viewer-status").textContent = asset.name;
  });
  function openAsset(asset, copies) {
    $("asset-viewer-select").replaceChildren(
      ...copies.map((item) => {
        const option = el("option", "", item.name);
        option.value = String(item.id);
        return option;
      }),
    );
    if (!$("asset-viewer").open) $("asset-viewer").showModal();
    showAsset(asset.id);
  }

  async function loadAssets(id, request = state.readerRequest) {
    if (!isCurrent(request) || state.reading?.id !== id) return;
    const assets = await api(`/api/links/${id}/assets`);
    if (!isCurrent(request) || state.reading?.id !== id) return;
    readerAssets = assets || [];
    assetsState = "ready";
    renderFormats();

    displaySavedArticle(request);
  }

  async function displaySavedArticle(request) {
    articleRequest?.abort();
    const controller = new AbortController();
    articleRequest = controller;
    try {
      const fragment = await loadReaderArticle(state.reading, readerAssets, {
        browser,
        signal: controller.signal,
      });
      if (!fragment || controller.signal.aborted || !isCurrent(request)) return;
      const rich = $("reader-rich-article");
      rich.replaceChildren(fragment);
      if (!state.reading.content) showReadTime(rich.textContent);
      if (state.readerSelection) {
        // A copy can finish loading after the reader started selecting plain text.
        highlighting = true;
        $("reader-article-mode").hidden = false;
      } else {
        setHighlighting(highlighting);
      }
    } catch (error) {
      if (error.status === 401) expireSession();
      // Text and the independent, sandboxed file viewer stay available.
    } finally {
      if (!controller.signal.aborted && isCurrent(request))
        finishArticleState();
    }
  }
  return {
    open: openReader,
    close,
    dispose() {
      close();
      lifecycle.dispose();
    },
  };
}

export default { create };
