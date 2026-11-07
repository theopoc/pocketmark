import { Button } from "./ui/button";

export function ConfirmActionDialog() {
  return (
    <dialog
      id="confirm-action-dialog"
      className="modal compact-modal"
      role="alertdialog"
      aria-labelledby="confirm-action-title"
      aria-describedby="confirm-action-description"
    >
      {"\n    "}
      <form method="dialog">
        {"\n      "}
        <div className="dialog-heading">
          <h2 id="confirm-action-title"></h2>
        </div>
        {"\n      "}
        <p id="confirm-action-description"></p>
        {"\n      "}
        <div className="dialog-actions">
          <Button
            id="confirm-action-cancel"
            value="cancel"
            className="button subtle"
            autoFocus
          >
            {"Cancel"}
          </Button>
          <Button
            id="confirm-action-submit"
            value="confirm"
            className="button danger"
          ></Button>
        </div>
        {"\n    "}
      </form>
      {"\n  "}
    </dialog>
  );
}
