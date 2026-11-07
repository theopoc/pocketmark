import { Button } from "./ui/button";

export function ImportDialog() {
  return (
    <dialog
      id="import-dialog"
      className="modal compact-modal"
      aria-labelledby="import-title"
    >
      {"\n    "}
      <div className="dialog-heading">
        <h2 id="import-title">{"Import bookmarks"}</h2>
        <Button
          type="button"
          className="icon-button close-dialog"
          aria-label="Close import"
        >
          <span data-icon="close" aria-hidden="true"></span>
        </Button>
      </div>
      {"\n    "}
      <p>
        {
          "Choose a Pocketmark JSON export or a browser bookmarks HTML file, up to 8 MiB."
        }
      </p>
      <p className="small muted">
        {
          "Import adds bookmark metadata to your library. Saved captures and attached files are not included. A full backup must be restored using its RESTORE instructions."
        }
      </p>
      {"\n    "}
      <div className="dialog-actions">
        <Button type="button" className="button subtle close-dialog">
          {"Cancel"}
        </Button>
        <Button id="import-choose" type="button" className="button primary">
          {"Choose file to import"}
        </Button>
      </div>
      {"\n  "}
    </dialog>
  );
}
