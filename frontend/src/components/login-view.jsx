import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

export function LoginView() {
  return (
    <section id="login-view" className="login-view" hidden>
      {"\n    "}
      <div className="login-intro">
        {"\n      "}
        <div className="login-brand-row">
          <a className="brand" href="/" aria-label="Pocketmark home">
            <img
              className="brand-mark"
              src="/icon.svg"
              width="29"
              height="32"
              alt=""
            />
            <span>{"Pocketmark"}</span>
          </a>
          <Button
            className="button subtle theme-toggle"
            data-theme-toggle
            aria-label="Dark mode"
            aria-pressed="true"
            title="Switch to light mode"
          >
            <span data-theme-icon aria-hidden="true"></span>
            <span data-theme-label>{"Dark"}</span>
          </Button>
        </div>
        {"\n      "}
        <div className="login-message">
          <h1>
            {"Your library."}
            <br />
            {"Always within reach."}
          </h1>
          <p>{"Save a page. Find an idea. Pick up where you left off."}</p>
        </div>
        {"\n      "}
        <p className="login-footnote">{"Your personal bookmark workspace."}</p>
        {"\n    "}
      </div>
      {"\n    "}
      <div className="login-panel">
        <div className="login-card">
          {"\n      "}
          <h2 id="login-title">{"Welcome back"}</h2>
          {"\n      "}
          <p id="login-description" className="muted">
            {"Sign in to your Pocketmark library."}
          </p>
          {"\n      "}
          <form id="login-form">
            {"\n        "}
            <label htmlFor="login-username">{"Username"}</label>
            <Input
              id="login-username"
              autoComplete="username"
              maxLength="120"
              required
              autoFocus
            />
            {"\n        "}
            <label htmlFor="login-password">{"Password"}</label>
            <Input
              id="login-password"
              type="password"
              autoComplete="current-password"
              aria-describedby="login-help"
              required
            />
            <p id="login-password-hint" className="field-hint" hidden>
              {"Use at least 12 characters."}
            </p>
            {"\n        "}
            <div id="login-confirm-fields" hidden>
              <label htmlFor="login-confirm">{"Confirm password"}</label>
              <Input
                id="login-confirm"
                type="password"
                autoComplete="new-password"
              />
            </div>
            {"\n        "}
            <Button id="login-submit" className="button primary" type="submit">
              <span id="login-submit-label">{"Sign in"}</span>{" "}
              <span data-icon="arrow-right" aria-hidden="true"></span>
            </Button>
            {"\n      "}
          </form>
          {"\n      "}
          <div id="mfa-enrollment" hidden>
            {"\n        "}
            <p className="small muted">
              {
                "Scan this QR code with your authenticator app, or enter the key manually."
              }
            </p>
            {"\n        "}
            <img
              id="mfa-qr"
              className="mfa-qr"
              alt="Authenticator setup QR code"
              width="220"
              height="220"
            />
            {"\n        "}
            <label htmlFor="mfa-secret">{"Manual setup key"}</label>
            <Textarea
              id="mfa-secret"
              className="mfa-secret"
              rows="2"
              readOnly
              spellCheck="false"
            ></Textarea>
            {"\n        "}
            <Button
              id="mfa-secret-copy"
              type="button"
              className="button subtle"
            >
              {"Copy setup key"}
            </Button>
            {"\n      "}
          </div>
          {"\n      "}
          <form id="mfa-code-form" hidden>
            {"\n        "}
            <label id="mfa-code-label" htmlFor="mfa-code">
              {"Authentication or recovery code"}
            </label>
            {"\n        "}
            <Input
              id="mfa-code"
              autoComplete="one-time-code"
              inputMode="text"
              spellCheck="false"
              required
            />
            {"\n        "}
            <Button className="button primary" type="submit">
              {"Verify and continue"}
            </Button>
            {"\n      "}
          </form>
          {"\n      "}
          <section
            id="mfa-login-codes"
            hidden
            aria-labelledby="mfa-login-codes-title"
          >
            {"\n        "}
            <h3 id="mfa-login-codes-title">{"Save your recovery codes"}</h3>
            {"\n        "}
            <p className="small muted">
              {
                "Each code works once if you lose your authenticator. Store them somewhere safe; they will not be shown again."
              }
            </p>
            {"\n        "}
            <pre
              id="mfa-login-codes-value"
              className="mfa-codes"
              tabIndex="0"
            ></pre>
            {"\n        "}
            <Button id="mfa-login-copy" type="button" className="button subtle">
              {"Copy recovery codes"}
            </Button>
            {"\n        "}
            <Button
              id="mfa-login-download"
              type="button"
              className="button subtle"
            >
              {"Download recovery codes"}
            </Button>
            {"\n        "}
            <Button
              id="mfa-login-continue"
              type="button"
              className="button primary"
            >
              {"I saved my codes"}
            </Button>
            {"\n      "}
          </section>
          {"\n      "}
          <Button
            id="mfa-back"
            type="button"
            className="text-button login-help"
            hidden
          >
            {"Back to sign in"}
          </Button>
          {"\n      "}
          <p id="login-error" className="form-error" role="alert"></p>
          {"\n      "}
          <p id="login-help" className="login-help muted small">
            {"Use your Pocketmark username and password."}
          </p>
          {"\n    "}
        </div>
      </div>
      {"\n  "}
    </section>
  );
}
