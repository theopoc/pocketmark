import { Button } from "./ui/button";

export function ExportDialog() {
  return (
    <dialog
      id="export-dialog"
      className="modal compact-modal"
      aria-labelledby="export-title"
    >
      <div className="dialog-heading">
        <h2 id="export-title">{"Export bookmarks"}</h2>
        <Button
          type="button"
          className="icon-button close-dialog"
          aria-label="Close"
        >
          <span data-icon="close" aria-hidden="true"></span>
        </Button>
      </div>
      <p className="muted">
        {
          "Choose a portable format. Saved files and captures are stored in your data directory and are not included in these metadata exports."
        }
      </p>
      <p className="small muted">
        {"To keep captures, files and account settings, "}
        <a href="/api/backup">{"download a full backup"}</a>
        {" instead. Restore instructions are included."}
      </p>
      <div className="reader-actions">
        <a className="button primary" href="/api/export">
          {"Pocketmark JSON"}
        </a>
        <a className="button subtle" href="/api/export/html">
          {"Browser bookmarks HTML"}
        </a>
      </div>
    </dialog>
  );
}
