import { Button } from "./ui/button";
import { Input } from "./ui/input";

export function ReauthDialog() {
  return (
    <dialog
      id="reauth-dialog"
      className="modal compact-modal"
      aria-labelledby="reauth-title"
      aria-describedby="reauth-description"
    >
      <form id="reauth-form">
        <h2 id="reauth-title">{"Confirm your password"}</h2>
        <p id="reauth-description" className="muted">
          {
            "Protect your account before continuing. Confirmation lasts five minutes in this browser."
          }
        </p>
        <label htmlFor="reauth-password">{"Current password"}</label>
        <Input
          id="reauth-password"
          type="password"
          autoComplete="current-password"
          required
          maxLength="1024"
        />
        <p id="reauth-error" className="form-error" role="alert"></p>
        <div className="dialog-actions">
          <Button id="reauth-cancel" type="button" className="button subtle">
            {"Cancel"}
          </Button>
          <Button id="reauth-submit" type="submit" className="button primary">
            {"Confirm password"}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
