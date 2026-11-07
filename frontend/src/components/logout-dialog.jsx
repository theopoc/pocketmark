import { Button } from "./ui/button";

export function LogoutDialog() {
  return (
    <dialog
      id="logout-dialog"
      className="modal compact-modal"
      role="alertdialog"
      aria-labelledby="logout-title"
      aria-describedby="logout-description"
    >
      {"\n    "}
      <form id="logout-form">
        {"\n      "}
        <div className="dialog-heading">
          <h2 id="logout-title">{"Sign out of Pocketmark?"}</h2>
        </div>
        {"\n      "}
        <p id="logout-description" className="muted">
          {"You’ll need to sign in again to access your library."}
        </p>
        {"\n      "}
        <p id="logout-error" className="form-error" role="alert"></p>
        {"\n      "}
        <div className="dialog-actions">
          <Button
            id="logout-cancel"
            type="button"
            className="button subtle close-dialog"
            autoFocus
          >
            {"Cancel"}
          </Button>
          <Button id="logout-confirm" type="submit" className="button primary">
            {"Sign out"}
          </Button>
        </div>
        {"\n    "}
      </form>
      {"\n  "}
    </dialog>
  );
}
