import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { Icon } from "../../components/icon";
import "./account-security.css";

function AccountHeading({ id, title, children }) {
  return (
    <header className="account-section-heading">
      <h1 id={id} tabIndex={-1}>
        {title}
      </h1>
      <p>{children}</p>
    </header>
  );
}

function Row({ title, description, status, children }) {
  return (
    <div className="account-setting-row">
      <div>
        <div className="account-setting-label">
          <h2>{title}</h2>
          {status}
        </div>
        <p>{description}</p>
      </div>
      <div className="account-row-actions">{children}</div>
    </div>
  );
}

function PasswordAction({ disabled = false }) {
  return (
    <Button
      type="button"
      variant="outline"
      data-edit-password=""
      disabled={disabled}
    >
      Change password
    </Button>
  );
}

function DialogHead({ titleId, closeId }) {
  return (
    <header className="account-dialog-head">
      <h2 id={titleId} />
      <Button
        type="button"
        variant="outline"
        id={closeId}
        aria-label="Close dialog"
      >
        <Icon name="close" />
      </Button>
    </header>
  );
}

function PasswordField({ id, label, complete, hint, required = true }) {
  return (
    <div className="account-field">
      <label htmlFor={id}>{label}</label>
      <div className="account-secret-input">
        <Input
          id={id}
          type="password"
          required={required}
          autoComplete={complete}
          aria-describedby={hint}
        />
        <Button
          type="button"
          className="account-peek"
          aria-label={`Show ${label.toLowerCase()}`}
          aria-pressed="false"
          aria-controls={id}
          data-password-visibility=""
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
          >
            <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z" />
            <circle cx="12" cy="12" r="2.5" />
            <path className="account-eye-slash" d="m3 3 18 18" />
          </svg>
        </Button>
      </div>
    </div>
  );
}

function PasswordDialog() {
  return (
    <dialog
      id="account-dialog"
      className="modal account-dialog"
      aria-labelledby="account-dialog-title"
    >
      <DialogHead
        titleId="account-dialog-title"
        closeId="account-dialog-close"
      />
      <form id="account-form">
        <div className="account-dialog-body">
          <div id="account-name-field" className="account-field" hidden>
            <label htmlFor="account-username">Username</label>
            <Input id="account-username" autoComplete="username" />
          </div>
          <div id="account-current-field">
            <PasswordField
              id="account-current"
              label="Current password"
              complete="current-password"
            />
          </div>
          <PasswordField
            id="account-password"
            label="New password"
            complete="new-password"
            hint="account-checks account-length-error"
          />
          <div
            id="account-checks"
            className="account-checks"
            role="group"
            aria-label="Password requirements and suggestions"
          >
            <div className="account-meter" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
            <ul>
              {[
                "At least 12 bytes",
                "One uppercase letter (optional)",
                "One symbol (optional)",
              ].map((text) => (
                <li key={text}>
                  <span className="account-check-mark" aria-hidden="true" />
                  <span className="sr-only" data-check-state="" />
                  {text}
                </li>
              ))}
            </ul>
          </div>
          <p id="account-length-error" className="form-error" hidden>
            Use a password of 1,024 bytes or fewer.
          </p>
          <div id="account-confirm-field">
            <PasswordField
              id="account-confirm"
              label="Confirm new password"
              complete="new-password"
              hint="account-match-error"
            />
          </div>
          <p id="account-match-error" className="form-error" hidden>
            Enter the same new password in both fields.
          </p>
          <p className="small muted" id="account-impact">
            Changing your password signs out your other browsers.
          </p>
          <p id="account-form-error" className="form-error" role="alert" />
        </div>
        <div className="account-dialog-actions">
          <Button type="button" variant="ghost" id="account-cancel">
            Cancel
          </Button>
          <Button type="submit" variant="default" id="account-save" disabled>
            Change password
          </Button>
        </div>
      </form>
    </dialog>
  );
}

function AuthenticatorDialog() {
  return (
    <dialog
      id="mfa-manage-dialog"
      className="modal account-dialog"
      aria-labelledby="mfa-dialog-title"
    >
      <DialogHead titleId="mfa-dialog-title" closeId="mfa-dialog-close" />
      <div className="account-dialog-body">
        <form id="mfa-manage-form" hidden>
          <p className="small muted" id="mfa-method-hint">
            Confirm your identity to connect a new authenticator app. Your other
            browsers will be signed out after setup.
          </p>
          <p className="small muted" id="mfa-codes-warning">
            Generating recovery codes invalidates all previous recovery codes.
          </p>
          <div className="account-field">
            <label htmlFor="mfa-manage-password">Current password</label>
            <Input
              id="mfa-manage-password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={1024}
            />
          </div>
          <div className="account-field">
            <label htmlFor="mfa-manage-code">
              Authentication or recovery code
            </label>
            <Input
              id="mfa-manage-code"
              autoComplete="one-time-code"
              spellCheck={false}
              aria-describedby="mfa-grant-hint"
            />
          </div>
          <p id="mfa-grant-hint" className="small muted">
            For five minutes after signing in with a recovery code, you can
            leave the code field empty when replacing your authenticator.
          </p>
          <div className="account-dialog-actions">
            <Button type="button" variant="outline" id="mfa-proof-cancel">
              Cancel
            </Button>
            <Button variant="default" type="submit" value="replace">
              Continue
            </Button>
            <Button
              variant="default"
              type="submit"
              value="codes"
              aria-describedby="mfa-codes-warning"
            >
              Regenerate codes
            </Button>
          </div>
        </form>
        <div id="mfa-manage-enrollment" hidden>
          <p className="small muted">
            Scan the QR code with your new authenticator app or enter the setup
            key manually.
          </p>
          <div className="account-setup">
            <img
              id="mfa-manage-qr"
              className="mfa-qr"
              alt="New authenticator setup QR code"
              width={180}
              height={180}
            />
            <div className="account-field">
              <label htmlFor="mfa-manage-secret">Manual setup key</label>
              <Textarea
                id="mfa-manage-secret"
                className="mfa-secret"
                rows={2}
                readOnly
                spellCheck={false}
              />
              <Button
                type="button"
                id="mfa-manage-secret-copy"
                variant="outline"
              >
                Copy setup key
              </Button>
            </div>
          </div>
          <form id="mfa-manage-verify">
            <div className="account-field">
              <label htmlFor="mfa-manage-new-code">
                Code from the new authenticator
              </label>
              <Input
                id="mfa-manage-new-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
              />
            </div>
            <div className="account-dialog-actions">
              <Button type="button" variant="outline" id="mfa-manage-cancel">
                Cancel setup
              </Button>
              <Button variant="default" type="submit">
                Confirm authenticator
              </Button>
            </div>
          </form>
        </div>
        <div id="mfa-codes-view" hidden>
          <div id="mfa-manage-codes" hidden>
            <p className="small muted">
              Save these single-use codes. Your previous recovery codes no
              longer work.
            </p>
            <pre
              id="mfa-manage-codes-value"
              className="mfa-codes"
              aria-label="Recovery codes"
              tabIndex={0}
            />
            <div className="account-row-actions">
              <Button type="button" variant="outline" id="mfa-manage-copy">
                Copy codes
              </Button>
              <Button type="button" variant="outline" id="mfa-manage-download">
                Download codes
              </Button>
            </div>
            <div className="account-dialog-actions">
              <Button type="button" variant="outline" id="mfa-codes-back">
                Back to settings
              </Button>
              <Button type="button" variant="default" id="mfa-codes-done">
                I saved my codes
              </Button>
            </div>
          </div>
        </div>
        <p id="mfa-manage-feedback" className="small muted" role="status" />
        <p id="mfa-manage-error" className="form-error" role="alert" />
      </div>
    </dialog>
  );
}

export function AccountPanels() {
  return (
    <>
      <section
        className="settings-feature account-settings"
        data-settings-panel="password"
        aria-labelledby="password-title"
        hidden
      >
        <AccountHeading id="password-title" title="Password">
          Manage the credentials you use to sign in.
        </AccountHeading>
        <Row
          title="Username"
          description={<span id="account-username-value">Loading…</span>}
        >
          <Button
            type="button"
            variant="outline"
            id="account-edit-username"
            disabled
          >
            Edit username
          </Button>
        </Row>
        <Row
          title="Password"
          description={
            <>
              <span data-account-password-mask="" aria-hidden="true">
                Loading…
              </span>
              <span className="sr-only" data-account-password-status="">
                Loading password status
              </span>
            </>
          }
        >
          <PasswordAction disabled />
        </Row>
        <p id="settings-error" className="form-error" role="alert" />
      </section>
      <section
        className="settings-feature account-settings"
        data-settings-panel="2fa"
        aria-labelledby="mfa-settings-title"
        hidden
      >
        <AccountHeading id="mfa-settings-title" title="Account security">
          Manage how you sign in to Pocketmark.
        </AccountHeading>
        <Row
          title="Password"
          description={
            <>
              <span data-account-password-mask="" aria-hidden="true">
                Loading…
              </span>
              <span className="sr-only" data-account-password-status="">
                Loading password status
              </span>
            </>
          }
        >
          <PasswordAction disabled />
        </Row>
        <Row
          title="2-step verification"
          description="Use an authenticator app when you sign in."
          status={
            <span className="desk-mfa-status" data-settings-mfa-status="" />
          }
        >
          <Button type="button" variant="outline" id="mfa-manage-start">
            Change method
          </Button>
        </Row>
        <Row
          title="Recovery codes"
          description={
            <span id="mfa-codes-description">
              Use a one-time code if you lose access to your authenticator.
            </span>
          }
        >
          <Button
            type="button"
            variant="outline"
            id="mfa-codes-view-start"
            hidden
          >
            View codes
          </Button>
          <Button type="button" variant="outline" id="mfa-codes-start">
            Regenerate codes
          </Button>
        </Row>
        <p id="account-load-error" className="form-error" role="alert" />
      </section>
      <PasswordDialog />
      <AuthenticatorDialog />
    </>
  );
}
