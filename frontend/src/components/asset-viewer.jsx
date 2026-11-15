import { Button } from "./ui/button";

export function AssetViewer() {
  return (
    <dialog
      id="asset-viewer"
      className="modal asset-viewer"
      aria-labelledby="asset-viewer-title"
    >
      {"\n    "}
      <div className="dialog-heading">
        <h2 id="asset-viewer-title">{"Saved copy"}</h2>
        <div className="asset-heading-actions">
          <Button
            id="asset-viewer-notes"
            type="button"
            className="button subtle"
          >
            Notes
          </Button>
          <Button
            id="asset-viewer-copies"
            type="button"
            className="button subtle"
          >
            Copies
          </Button>
          <Button
            id="asset-viewer-close"
            type="button"
            className="icon-button"
            aria-label="Close preview"
          >
            <span data-icon="close" aria-hidden="true"></span>
          </Button>
        </div>
      </div>
      {"\n    "}
      <div className="asset-viewer-toolbar">
        <label htmlFor="asset-viewer-select">{"Version"}</label>
        <select id="asset-viewer-select"></select>
        <a id="asset-viewer-download" className="button subtle" download>
          {"Download original"}
        </a>
      </div>
      {"\n    "}
      <p id="asset-viewer-hint" className="small muted"></p>
      <p id="asset-viewer-status" className="small" role="status"></p>
      <Button
        id="asset-viewer-retry"
        type="button"
        className="text-button"
        hidden
      >
        {"Retry preview"}
      </Button>
      {"\n    "}
      <div id="asset-viewer-content" className="asset-viewer-content"></div>
      {"\n  "}
    </dialog>
  );
}
