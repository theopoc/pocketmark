import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

export function BookmarkDialog() {
  return (
    <dialog
      id="bookmark-dialog"
      className="modal"
      aria-labelledby="bookmark-dialog-title"
    >
      {"\n    "}
      <form id="bookmark-form">
        {"\n      "}
        <div className="dialog-heading">
          <div>
            <h2 id="bookmark-dialog-title">{"Add bookmark"}</h2>
          </div>
          <Button
            type="button"
            className="icon-button close-dialog"
            aria-label="Close"
          >
            <span data-icon="close" aria-hidden="true"></span>
          </Button>
        </div>
        {"\n      "}
        <div className="bookmark-form-body">
          {"\n      "}
          <div id="bookmark-link-field">
            <label htmlFor="bookmark-url">URL</label>
            <Input
              id="bookmark-url"
              type="url"
              placeholder="https://example.com/article"
              required
            />
          </div>
          <label htmlFor="bookmark-collection">Collection</label>
          <select id="bookmark-collection"></select>
          <details id="bookmark-options" className="editor-details">
            <summary>Bookmark details</summary>
            <label htmlFor="bookmark-title">Title</label>
            <Input
              id="bookmark-title"
              placeholder="Page title"
              maxLength="1000"
            />
            <label htmlFor="bookmark-tags">Tags</label>
            <Input
              id="bookmark-tags"
              placeholder="Choose or create tags"
              autoComplete="off"
              spellCheck="false"
            />
            <p id="bookmark-tags-hint" className="field-hint">
              Press Enter to add a tag.
            </p>
            <details id="bookmark-details" className="editor-details">
              <summary>Description &amp; personal notes</summary>
              <label htmlFor="bookmark-description">Description</label>
              <Textarea id="bookmark-description" rows="2" />
              <label htmlFor="bookmark-notes">Personal notes</label>
              <Textarea id="bookmark-notes" rows="3" />
            </details>
            <div className="checkbox-row">
              <label>
                <Input id="bookmark-favorite" type="checkbox" /> Favorite
              </label>
              <label>
                <Input id="bookmark-read" type="checkbox" /> Already read
              </label>
            </div>
          </details>
          <div id="bookmark-capture-option" className="bookmark-capture-option">
            <label>
              <Input
                id="bookmark-save-html"
                type="checkbox"
                aria-describedby="bookmark-html-hint"
              />
              Save an offline copy
            </label>
            <p id="bookmark-html-hint" className="field-hint">
              Keep the HTML, images and styles when available.
            </p>
          </div>
          <p
            id="bookmark-save-status"
            className="small muted"
            role="status"
            hidden
          ></p>
          {"\n      "}
          <div id="bookmark-draft" className="draft-notice" hidden>
            <span>
              {"Draft kept in this tab. Save it before closing the tab."}
            </span>
            <Button
              id="discard-bookmark-draft"
              type="button"
              className="text-button destructive-action"
            >
              {"Discard draft"}
            </Button>
          </div>
          {"\n      "}
          <p id="bookmark-error" className="form-error" role="alert"></p>
          {"\n      "}
        </div>
        {"\n      "}
        <div className="dialog-actions">
          <Button
            type="button"
            id="upload-file-button"
            className="text-button"
            title="Save a PDF, image or HTML file instead"
          >
            <span data-icon="upload" aria-hidden="true"></span>Upload a file
          </Button>
          <Button type="button" className="button subtle close-dialog">
            {"Cancel"}
          </Button>
          <Button type="submit" className="button primary" id="save-bookmark">
            {"Save"}
          </Button>
        </div>
        {"\n    "}
      </form>
      {"\n  "}
    </dialog>
  );
}
