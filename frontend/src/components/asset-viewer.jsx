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
        <h2 id="asset-viewer-title">{"Saved capture"}</h2>
        <Button
          id="asset-viewer-close"
          type="button"
          className="icon-button"
          aria-label="Close preview"
        >
          <span data-icon="close" aria-hidden="true"></span>
        </Button>
      </div>
      {"\n    "}
      <div className="asset-viewer-toolbar">
        <label htmlFor="asset-viewer-select">{"Saved file"}</label>
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
