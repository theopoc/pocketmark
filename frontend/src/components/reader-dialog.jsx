import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

export function ReaderDialog() {
  return (
    <dialog
      id="reader-dialog"
      className="modal reader-modal"
      aria-labelledby="reader-title"
    >
      {"\n    "}
      <div className="dialog-heading reader-sticky-heading">
        <div className="reader-heading-row">
          {"\n      "}
          <span className="reader-heading-label">
            <span data-icon="bookmark" aria-hidden="true"></span>
            {"Bookmark"}
          </span>
          {"\n      "}
          <div className="reader-actions">
            {"\n        "}
            <a
              id="reader-original"
              className="button primary"
              target="_blank"
              rel="noopener noreferrer"
              hidden
            >
              {"Open original "}
              <span data-icon="external" aria-hidden="true"></span>
            </a>
            {"\n        "}
            <Button
              id="reader-notebook-toggle"
              type="button"
              className="button subtle"
              aria-expanded="false"
              aria-controls="reader-notebook"
              disabled
            >
              {"Notes"}
            </Button>
            {"\n        "}
            <Button
              type="button"
              className="icon-button close-dialog"
              aria-label="Close reader"
            >
              <span data-icon="close" aria-hidden="true"></span>
            </Button>
            {"\n      "}
          </div>
          {"\n    "}
        </div>
      </div>
      {"\n    "}
      <p id="reader-error" className="form-error" role="alert"></p>
      {"\n    "}
      <div className="reader-workspace">
        {"\n      "}
        <section
          id="reader-text-panel"
          className="reader-text-panel"
          aria-label="Bookmark and saved formats"
          tabIndex="0"
        >
          {"\n        "}
          <header className="reader-article-header">
            <h2 id="reader-title"></h2>
            <div className="reader-meta">
              <p id="reader-domain" className="reader-domain"></p>
              <p id="reader-status" className="muted small" role="status"></p>
            </div>
          </header>
          {"\n        "}
          <section
            id="reader-formats"
            className="reader-formats"
            aria-labelledby="reader-formats-title"
            hidden
          >
            {"\n          "}
            <div className="saved-formats-heading">
              <h3 id="reader-formats-title">{"Saved formats"}</h3>
              <Button
                id="reader-files-toggle"
                className="button subtle"
                type="button"
                aria-expanded="false"
                aria-controls="reader-files"
              >
                {"Manage files"}
              </Button>
            </div>
            {"\n          "}
            <p className="small muted">
              {
                "Choose a saved copy. The latest opens first; earlier copies stay available in the file selector."
              }
            </p>
            <p
              id="reader-formats-summary"
              className="small muted"
              role="status"
            ></p>
            {"\n          "}
            <div className="saved-format-list">
              {"\n            "}
              <Button
                id="reader-format-html"
                className="saved-format"
                type="button"
                disabled
              >
                <span data-icon="html" aria-hidden="true"></span>
                <span className="saved-format-name">
                  {"HTML"}
                  <span className="saved-format-description">
                    {"Saved page"}
                  </span>
                </span>
                <span
                  id="reader-format-html-status"
                  className="saved-format-status"
                >
                  {"Checking…"}
                </span>
                <span
                  className="saved-format-open"
                  aria-hidden="true"
                  data-icon="arrow-right"
                ></span>
              </Button>
              {"\n            "}
              <Button
                id="reader-format-image"
                className="saved-format"
                type="button"
                disabled
              >
                <span data-icon="image" aria-hidden="true"></span>
                <span className="saved-format-name">
                  {"Screenshot"}
                  <span className="saved-format-description">
                    {"Page captures and saved images"}
                  </span>
                </span>
                <span
                  id="reader-format-image-status"
                  className="saved-format-status"
                >
                  {"Checking…"}
                </span>
                <span
                  className="saved-format-open"
                  aria-hidden="true"
                  data-icon="arrow-right"
                ></span>
              </Button>
              {"\n            "}
              <Button
                id="reader-format-pdf"
                className="saved-format"
                type="button"
                disabled
              >
                <span data-icon="pdf" aria-hidden="true"></span>
                <span className="saved-format-name">
                  {"PDF"}
                  <span className="saved-format-description">
                    {"Saved document"}
                  </span>
                </span>
                <span
                  id="reader-format-pdf-status"
                  className="saved-format-status"
                >
                  {"Checking…"}
                </span>
                <span
                  className="saved-format-open"
                  aria-hidden="true"
                  data-icon="arrow-right"
                ></span>
              </Button>
              {"\n          "}
            </div>
            {"\n          "}
            <p
              id="reader-formats-error"
              className="form-error"
              role="alert"
              hidden
            ></p>
            <Button
              id="reader-formats-retry"
              type="button"
              className="text-button"
              hidden
            >
              {"Retry saved formats"}
            </Button>
            {"\n          "}
            <p className="small muted">
              {
                "Save HTML when adding or editing a bookmark. Capture screenshots and PDFs with the browser extension, or attach a file under Saved formats → Manage files."
              }
            </p>
            {"\n        "}
          </section>
          {"\n  "}
          <section
            id="reader-files"
            className="reader-assets"
            aria-labelledby="saved-files-title"
            hidden
          >
            {"\n    "}
            <div className="section-heading">
              <h3 id="saved-files-title">{"Attached files"}</h3>
              <Button
                id="reader-files-close"
                className="text-button"
                type="button"
              >
                {"Back to formats"}
              </Button>
              <Button
                id="asset-upload-button"
                type="button"
                className="button subtle"
              >
                {"Attach a saved file"}
              </Button>
            </div>
            {"\n    "}
            <p className="small muted file-types-hint">
              {
                "Attach PDF, image or HTML / SingleFile files · Up to 20 MiB each."
              }
            </p>
            {"\n    "}
            <p id="assets-error" className="form-error" role="alert" hidden></p>
            <Button
              id="assets-retry"
              type="button"
              className="text-button"
              hidden
            >
              {"Retry saved files"}
            </Button>
            {"\n    "}
            <Input
              id="asset-file"
              type="file"
              accept="application/pdf,image/png,image/jpeg,image/gif,image/webp,text/html,.html,.htm"
              hidden
            />
            <div id="asset-list"></div>
            {"\n  "}
          </section>
          {"\n        "}
          <div id="reader-reading-bar" className="reader-reading-bar">
            <details id="reader-options" className="reader-options">
              <summary>{"Reading options"}</summary>
              <div className="reader-options-content">
                <div className="reader-tools">
                  <Button
                    id="reader-highlight"
                    type="button"
                    className="text-button"
                    data-highlight-selection
                  >
                    {"Highlight selection"}
                  </Button>
                  <Button
                    id="reader-text-mode"
                    className="button subtle"
                    aria-pressed="false"
                  >
                    {"Text & highlights"}
                  </Button>
                  <Button
                    id="reader-layout-mode"
                    className="button subtle"
                    aria-pressed="false"
                    aria-describedby="reader-mode-hint"
                    disabled
                  >
                    {"Formatted page"}
                  </Button>
                  <label className="inline-check">
                    {"Text size "}
                    <select id="reader-size" aria-label="Reader text size">
                      <option value="17">{"Normal"}</option>
                      <option value="20">{"Large"}</option>
                      <option value="24">{"Extra large"}</option>
                    </select>
                  </label>
                </div>
                <p
                  id="reader-mode-hint"
                  className="small muted"
                  role="status"
                ></p>
                <div className="reader-actions">
                  <a id="reader-archive" className="button subtle" hidden>
                    {"Download snapshot"}
                  </a>
                  <Button id="reader-capture" className="button subtle">
                    {"Refresh capture"}
                  </Button>
                  <Button id="reader-edit" className="button subtle">
                    {"Edit bookmark"}
                  </Button>
                </div>
              </div>
            </details>
          </div>
          {"\n        "}
          <Button
            id="reader-retry-open"
            type="button"
            className="button subtle"
            hidden
          >
            {"Try opening again"}
          </Button>
          <Button
            id="reader-retry-capture"
            type="button"
            className="button subtle"
            hidden
          >
            {"Retry capture"}
          </Button>
          <Button
            id="reader-recheck"
            type="button"
            className="text-button"
            hidden
          >
            {"Check capture status"}
          </Button>
          {"\n  "}
          <div
            id="reader-content"
            className="reader-content"
            tabIndex="0"
          ></div>
          <iframe
            id="reader-layout"
            className="reader-layout"
            title="Saved page reader"
            sandbox=""
            hidden
          ></iframe>
          {"\n\n      "}
        </section>
        {"\n      "}
        <aside
          id="reader-notebook"
          className="reader-notebook"
          aria-label="Notes and saved files"
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
                className="text-button"
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
