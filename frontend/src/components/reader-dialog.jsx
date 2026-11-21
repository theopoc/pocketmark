import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { Icon } from "./icon";
import { readerTextSizes } from "../features/reader-text-size";
import "../features/reader.css";
import "../features/reader-article.css";
import "../features/reader-state.css";

function SavedFormat({ format, name, icon }) {
  const id = `reader-format-${format}`;
  return (
    <span className="reader-format-tool" id={`${id}-tool`}>
      <Button
        id={id}
        type="button"
        className="saved-format"
        aria-label={name}
        disabled
      >
        <Icon name={icon} />
      </Button>
      <span id={`${id}-status`} role="tooltip" className="reader-format-tip">
        Checking…
      </span>
    </span>
  );
}

export function ReaderDialog() {
  return (
    <dialog
      id="reader-dialog"
      className="modal reader-modal"
      data-layout="panel"
      aria-labelledby="reader-title"
    >
      <header className="dialog-heading reader-sticky-heading">
        <div className="reader-toolbar">
          <nav
            id="reader-page-breadcrumb"
            className="breadcrumb"
            aria-label="Breadcrumb"
            hidden
          />
          <div id="reader-formats" role="group" aria-label="Saved formats">
            <SavedFormat format="html" name="HTML" icon="file-code" />
            <SavedFormat format="image" name="Screenshot" icon="image" />
            <SavedFormat format="pdf" name="PDF" icon="pdf" />
          </div>
          <a
            id="reader-original"
            className="button subtle"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open original"
            title="Open original"
            hidden
          >
            <span>Open original</span>
            <Icon name="external" />
          </a>
          <div className="reader-size-control">
            <Button
              id="reader-size-trigger"
              type="button"
              variant="outline"
              popoverTarget="reader-size-panel"
              aria-controls="reader-size-panel"
              aria-expanded="false"
              aria-label="Text size"
              title="Text size"
              disabled
            >
              Aa
            </Button>
            <div id="reader-size-panel" className="app-popover" popover="auto">
              <div className="reader-size-labels" aria-hidden="true">
                <span>A</span>
                <span id="reader-size-value"></span>
                <span>A</span>
              </div>
              <div className="reader-size-scale">
                <div className="reader-size-ticks" aria-hidden="true">
                  {readerTextSizes.map((size) => (
                    <span key={size} />
                  ))}
                </div>
                <input
                  id="reader-size"
                  aria-label="Text size"
                  type="range"
                  min="0"
                  max={readerTextSizes.length - 1}
                  step="1"
                  defaultValue={readerTextSizes.indexOf(17)}
                  autoFocus
                />
              </div>
            </div>
          </div>
          <Button
            id="reader-notebook-toggle"
            type="button"
            variant="outline"
            aria-expanded="false"
            aria-controls="reader-notebook"
            disabled
          >
            <Icon name="book" />
            Notes
          </Button>
          <Button
            id="reader-page-toggle"
            type="button"
            size="icon"
            aria-label="Expand to full page"
            title="Expand to full page"
          >
            <Icon name="fit-page" className="icon reader-fit-page" />
            <Icon name="side-panel" className="icon reader-side-panel" />
          </Button>
          <Button
            type="button"
            size="icon"
            className="close-dialog"
            aria-label="Close reader"
            title="Close reader"
          >
            <Icon name="close" />
          </Button>
        </div>
        <p id="reader-formats-summary" className="sr-only" role="status"></p>
        <p
          id="reader-formats-error"
          className="form-error"
          role="alert"
          hidden
        ></p>
        <Button id="reader-formats-retry" type="button" variant="ghost" hidden>
          Retry saved formats
        </Button>
      </header>
      <p id="reader-error" className="form-error" role="alert"></p>
      <div className="reader-workspace">
        <section
          id="reader-text-panel"
          className="reader-text-panel"
          aria-label="Bookmark article"
          tabIndex="0"
        >
          <header className="reader-article-header">
            <h2 id="reader-title"></h2>
            <div className="reader-publication">
              <span id="reader-source"></span>
              <span className="reader-duration">
                <Icon name="clock" />
                <span id="reader-read-time"></span>
              </span>
            </div>
          </header>
          <div id="reader-state" hidden>
            <span className="reader-state-symbol" aria-hidden="true">
              <Icon name="warning" className="icon state-failed" />
              <Icon name="clock" className="icon state-pending" />
              <Icon name="book" className="icon state-empty" />
            </span>
            <div
              className="reader-state-message"
              role="status"
              aria-atomic="true"
            >
              <strong id="reader-status"></strong>
              <p id="reader-status-detail"></p>
            </div>
            <Button
              id="reader-retry-open"
              type="button"
              variant="outline"
              hidden
            >
              Try opening again
            </Button>
            <Button
              id="reader-retry-capture"
              type="button"
              variant="outline"
              hidden
            >
              <Icon name="refresh" />
              Retry capture
            </Button>
            <Button id="reader-recheck" type="button" variant="outline" hidden>
              Check status
            </Button>
          </div>
          <Button id="reader-article-mode" type="button" variant="ghost" hidden>
            Return to article
          </Button>
          <div
            id="reader-content"
            className="reader-content"
            tabIndex="0"
          ></div>
          <article
            id="reader-rich-article"
            aria-labelledby="reader-title"
            tabIndex={-1}
            hidden
          ></article>
          <Button
            id="reader-highlight"
            type="button"
            variant="outline"
            data-highlight-selection
            hidden
          >
            Highlight selection
          </Button>
        </section>
        <aside
          id="reader-notebook"
          className="reader-notebook"
          aria-label="Notes and highlights"
          hidden
        >
          {"\n        "}
          <div className="reader-notebook-heading">
            <h3>{"Notebook"}</h3>
            <Button
              id="reader-notebook-close"
              type="button"
              className="text-button"
            >
              {"Back to bookmark"}
            </Button>
          </div>
          {"\n        "}
          <nav
            id="reader-section-nav"
            className="reader-section-nav"
            aria-label="Notebook sections"
            role="tablist"
          >
            {"\n          "}
            <Button
              type="button"
              className="reader-tab"
              id="reader-tab-notes"
              role="tab"
              aria-controls="reader-notes-form"
              aria-selected="true"
              tabIndex="0"
              data-reader-section="reader-notes-form"
            >
              {"Notes"}
            </Button>
            {"\n          "}
            <Button
              type="button"
              className="reader-tab"
              id="reader-tab-highlights"
              role="tab"
              aria-controls="annotations-section"
              aria-selected="false"
              tabIndex="-1"
              data-reader-section="annotations-section"
            >
              {"Highlights"}
            </Button>
            {"\n        "}
          </nav>
          {"\n        "}
          <form
            id="reader-notes-form"
            className="reader-notes"
            role="tabpanel"
            aria-labelledby="reader-tab-notes"
            tabIndex="0"
            hidden
          >
            <label htmlFor="reader-notes">{"Document note"}</label>
            <Textarea
              id="reader-notes"
              rows="4"
              placeholder="Something to remember…"
            ></Textarea>
            <div id="reader-notes-draft" className="draft-notice" hidden>
              <span>
                {
                  "Notes draft kept in this tab. Save them before closing the tab."
                }
              </span>
              <Button
                id="discard-reader-notes"
                type="button"
                className="text-button destructive-action"
              >
                {"Discard notes draft"}
              </Button>
            </div>
            <Button type="submit" className="button primary">
              {"Save notes"}
            </Button>
          </form>
          <section
            id="annotations-section"
            role="tabpanel"
            aria-labelledby="reader-tab-highlights"
            tabIndex="0"
            hidden
          >
            {"\n    "}
            <div className="section-heading">
              <h3 id="highlights-title">{"Highlights"}</h3>
              <Button
                id="annotate-selection"
                type="button"
                className="text-button"
                data-highlight-selection
              >
                {"Highlight selected text"}
              </Button>
            </div>
            {"\n    "}
            <p
              id="annotations-error"
              className="form-error"
              role="alert"
              hidden
            ></p>
            <Button
              id="annotations-retry"
              type="button"
              className="text-button"
              hidden
            >
              {"Retry highlights"}
            </Button>
            <Button id="reader-text-mode" type="button" variant="ghost" hidden>
              Read text for highlighting
            </Button>
            <div id="annotation-list"></div>
            {"\n  "}
          </section>
          {"\n\n      "}
        </aside>
        {"\n    "}
      </div>
      {"\n  "}
    </dialog>
  );
}
