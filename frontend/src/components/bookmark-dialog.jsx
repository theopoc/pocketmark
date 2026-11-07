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
          <label htmlFor="bookmark-url">
            {"URL "}
            <span className="required">{"*"}</span>
          </label>
          <Input
            id="bookmark-url"
            type="url"
            placeholder="https://example.com/article"
            required
          />
          {"\n      "}
          <label htmlFor="bookmark-title">{"Title"}</label>
          <Input
            id="bookmark-title"
            placeholder="Page title"
            maxLength="1000"
          />
          {"\n      "}
          <div className="form-columns bookmark-organization">
            <div>
              <label htmlFor="bookmark-collection">{"Collection"}</label>
              <select id="bookmark-collection"></select>
            </div>
            <div>
              <label htmlFor="bookmark-tags">{"Tags"}</label>
              <Input
                id="bookmark-tags"
                placeholder="Choose or create tags"
                autoComplete="off"
                spellCheck="false"
              />
              <p id="bookmark-tags-hint" className="field-hint">
                {
                  "Choose a tag or type a new one, then press Enter. Use commas to add several."
                }
              </p>
            </div>
          </div>
          {"\n      "}
          <details id="bookmark-details" className="editor-details">
            <summary>{"Description & personal notes"}</summary>
            {"\n      "}
            <label htmlFor="bookmark-description">{"Description"}</label>
            <Textarea
              id="bookmark-description"
              rows="2"
              placeholder="What makes this worth saving?"
            ></Textarea>
            {"\n      "}
            <label htmlFor="bookmark-notes">{"Personal notes"}</label>
            <Textarea
              id="bookmark-notes"
              rows="3"
              placeholder="Your thoughts, in your words…"
            ></Textarea>
            {"\n      "}
          </details>
          {"\n      "}
          <div className="checkbox-row">
            <label>
              <Input id="bookmark-favorite" type="checkbox" />
              {" Favorite"}
            </label>
            <label>
              <Input id="bookmark-read" type="checkbox" />
              {" Already read"}
            </label>
          </div>
          {"\n      "}
          <div id="bookmark-capture-option" className="bookmark-capture-option">
            <label>
              <Input
                id="bookmark-save-html"
                type="checkbox"
                aria-describedby="bookmark-html-hint"
              />
              <span>{"Save an HTML copy"}</span>
            </label>
            <p id="bookmark-html-hint" className="field-hint">
              {
                "Keep an offline copy with images and styles when available. Interactive content is not saved."
              }
            </p>
          </div>
          {"\n      "}
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
              className="text-button"
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
