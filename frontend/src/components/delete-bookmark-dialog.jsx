import { Button } from "./ui/button";

export function DeleteBookmarkDialog() {
  return (
    <dialog
      id="delete-bookmark-dialog"
      className="modal compact-modal"
      role="alertdialog"
      aria-labelledby="delete-bookmark-title"
      aria-describedby="delete-bookmark-description"
    >
      {"\n    "}
      <form id="delete-bookmark-form">
        {"\n      "}
        <div className="dialog-heading">
          <h2 id="delete-bookmark-title">{"Delete bookmark?"}</h2>
        </div>
        {"\n      "}
        <p id="delete-bookmark-description">
          {"Delete "}
          <strong id="delete-bookmark-name"></strong>
          {" and its saved content? This cannot be undone."}
        </p>
        {"\n      "}
        <p id="delete-bookmark-error" className="form-error" role="alert"></p>
        {"\n      "}
        <div className="dialog-actions">
          <Button
            id="delete-bookmark-cancel"
            type="button"
            className="button subtle close-dialog"
            autoFocus
          >
            {"Cancel"}
          </Button>
          <Button
            id="delete-bookmark-confirm"
            type="submit"
            className="button danger"
          >
            {"Delete bookmark"}
          </Button>
        </div>
        {"\n    "}
      </form>
      {"\n  "}
    </dialog>
  );
}
