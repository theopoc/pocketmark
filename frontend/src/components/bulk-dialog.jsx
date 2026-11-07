import { Button } from "./ui/button";
import { Input } from "./ui/input";

export function BulkDialog() {
  return (
    <dialog
      id="bulk-dialog"
      className="modal compact-modal bulk-dialog"
      aria-labelledby="bulk-title"
      aria-describedby="bulk-scope"
    >
      <form id="bulk-form">
        {"\n  "}
        <div className="dialog-heading">
          <Button
            id="bulk-back"
            type="button"
            className="icon-button"
            aria-label="Back to selected bookmark actions"
            hidden
          >
            <span data-icon="arrow-left" aria-hidden="true"></span>
          </Button>
          <h2 id="bulk-title">{"Selected bookmarks"}</h2>
          <Button
            id="bulk-close"
            type="button"
            className="icon-button close-dialog"
            aria-label="Close"
          >
            <span data-icon="close" aria-hidden="true"></span>
          </Button>
        </div>
        {"\n  "}
        <p id="bulk-scope" className="small muted"></p>
        {"\n  "}
        <div id="bulk-menu" className="bulk-menu" hidden>
          {"\n    "}
          <Button type="button" data-bulk-action="move">
            <span data-icon="folder-input" aria-hidden="true"></span>
            {"Move to collection"}
            <span
              className="bulk-chevron"
              data-icon="chevron-right"
              aria-hidden="true"
            ></span>
          </Button>
          {"\n    "}
          <Button type="button" data-bulk-action="tags">
            <span data-icon="tag" aria-hidden="true"></span>
            {"Replace tags"}
            <span
              className="bulk-chevron"
              data-icon="chevron-right"
              aria-hidden="true"
            ></span>
          </Button>
          {"\n    "}
          <Button type="button" data-bulk-action="favorite">
            <span data-icon="star" aria-hidden="true"></span>
            {"Favorites"}
            <span
              className="bulk-chevron"
              data-icon="chevron-right"
              aria-hidden="true"
            ></span>
          </Button>
          {"\n    "}
          <Button type="button" data-bulk-action="read">
            <span id="bulk-menu-read-icon" aria-hidden="true"></span>
            <span id="bulk-menu-read-label">{"Read"}</span>
            <span
              className="bulk-chevron"
              data-icon="chevron-right"
              aria-hidden="true"
            ></span>
          </Button>
          {"\n    "}
          <Button type="button" data-bulk-action="capture">
            <span data-icon="refresh" aria-hidden="true"></span>
            {"Refresh captures"}
          </Button>
          {"\n    "}
          <Button id="bulk-select-page" type="button">
            <span data-icon="list" aria-hidden="true"></span>
            <span id="bulk-select-page-label">{"Select all"}</span>
          </Button>
          {"\n    "}
          <Button
            type="button"
            data-bulk-action="delete"
            className="bulk-menu-delete"
          >
            <span data-icon="trash" aria-hidden="true"></span>
            <span id="bulk-menu-delete-label">{"Delete bookmarks"}</span>
          </Button>
          {"\n  "}
        </div>
        {"\n  "}
        <div id="bulk-move-fields" hidden>
          {"\n    "}
          <label htmlFor="bulk-collection-search" className="sr-only">
            {"Find a collection"}
          </label>
          <Input
            id="bulk-collection-search"
            type="search"
            placeholder="Find a collection…"
            autoComplete="off"
          />
          {"\n    "}
          <select
            id="bulk-collection"
            hidden
            aria-label="Destination collection"
            tabIndex="-1"
          ></select>
          {"\n    "}
          <div
            id="bulk-collections"
            className="bulk-collections"
            role="group"
            aria-label="Destination collection"
          ></div>
          <p id="bulk-collections-empty" className="small muted" hidden>
            {"No matching collections."}
          </p>
          {"\n  "}
        </div>
        {"\n  "}
        <div id="bulk-tags-fields" hidden>
          <label htmlFor="bulk-tags">{"Tags"}</label>
          <Input id="bulk-tags" />
          <p className="small muted">
            {
              "These tags will replace the existing tags on every selected bookmark."
            }
          </p>
        </div>
        {"\n  "}
        <div id="bulk-status-choices" className="bulk-menu" hidden>
          {"\n    "}
          <Button id="bulk-status-true" type="button">
            <span id="bulk-status-true-icon" aria-hidden="true"></span>
            <span id="bulk-status-true-label"></span>
          </Button>
          {"\n    "}
          <Button id="bulk-status-false" type="button">
            <span id="bulk-status-false-icon" aria-hidden="true"></span>
            <span id="bulk-status-false-label"></span>
          </Button>
          {"\n  "}
        </div>
        {"\n  "}
        <p id="bulk-description" hidden></p>
        {"\n  "}
        <p id="bulk-error" className="form-error" role="alert"></p>
        {"\n  "}
        <div id="bulk-footer" className="dialog-actions">
          <Button
            id="bulk-cancel"
            type="button"
            className="button subtle close-dialog"
          >
            {"Cancel"}
          </Button>
          <Button id="bulk-apply" className="button primary" type="submit">
            {"Apply"}
          </Button>
        </div>
        {"\n"}
      </form>
    </dialog>
  );
}
