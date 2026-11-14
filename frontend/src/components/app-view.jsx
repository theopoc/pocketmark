import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { SettingsFrame } from "../features/settings/frame";

export function AppView() {
  return (
    <div id="app-view" className="app-shell" hidden>
      {"\n    "}
      <a className="skip-link" href="#main-content">
        {"Skip to content"}
      </a>
      {"\n    "}
      <main id="main-content" className="main-content" tabIndex="-1">
        {"\n      "}
        <header className="topbar">
          <div className="topbar-location">
            <Button
              id="open-navigation"
              className="icon-button"
              aria-label="Open navigation"
              aria-controls="navigation-dialog"
              aria-expanded="false"
            >
              <span data-icon="menu" aria-hidden="true"></span>
            </Button>
            <nav
              id="breadcrumb"
              className="breadcrumb"
              aria-label="Breadcrumb"
              title="Scroll to see earlier levels"
            ></nav>
          </div>
          <div className="topbar-actions">
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
            <span className="workspace-badge">
              <span data-icon="lock" aria-hidden="true"></span>
              {"Personal library"}
            </span>
          </div>
        </header>
        {"\n      "}
        <section
          id="settings-page"
          className="settings-page"
          aria-labelledby="settings-title"
          hidden
        >
          {"\n        "}
          <SettingsFrame>
            <section
              className="settings-section"
              data-settings-panel="password"
              aria-labelledby="password-title"
              hidden
            >
              <h2 id="password-title">{"Password"}</h2>
              <p className="small muted">{"Manage your sign-in details."}</p>
              <form id="account-form">
                <p id="account-status" className="small muted"></p>
                <label htmlFor="account-username">{"Username"}</label>
                <Input id="account-username" autoComplete="username" required />
                <label htmlFor="account-password">{"New password"}</label>
                <Input
                  id="account-password"
                  type="password"
                  minLength="12"
                  autoComplete="new-password"
                  required
                />
                <p className="small muted">{"At least 12 characters."}</p>
                <Button className="button primary" type="submit">
                  {"Save password"}
                </Button>
              </form>
              <p id="settings-error" className="form-error" role="alert"></p>
            </section>
            <section
              className="settings-section"
              data-settings-panel="2fa"
              aria-labelledby="mfa-settings-title"
              hidden
            >
              {"\n    "}
              <h2 id="mfa-settings-title">{"Two-factor authentication"}</h2>
              {"\n    "}
              <p className="small muted">
                {
                  "Use an authenticator app when signing in. Replacing it signs out your other browsers."
                }
              </p>
              {"\n    "}
              <form id="mfa-manage-form">
                {"\n      "}
                <label htmlFor="mfa-manage-password">
                  {"Current password"}
                </label>
                <Input
                  id="mfa-manage-password"
                  type="password"
                  autoComplete="current-password"
                  required
                  maxLength="1024"
                />
                {"\n      "}
                <label htmlFor="mfa-manage-code">
                  {"Authentication or recovery code"}
                </label>
                <Input
                  id="mfa-manage-code"
                  autoComplete="one-time-code"
                  spellCheck="false"
                />
                {"\n      "}
                <p className="small muted">
                  {
                    "For five minutes after signing in with a recovery code, you can leave the code field empty when replacing your authenticator."
                  }
                </p>
                {"\n      "}
                <p id="mfa-codes-warning" className="small muted">
                  {
                    "Generating recovery codes invalidates all previous recovery codes."
                  }
                </p>
                {"\n      "}
                <div className="token-actions">
                  <Button
                    className="button subtle"
                    type="submit"
                    value="replace"
                  >
                    {"Replace authenticator"}
                  </Button>
                  <Button
                    className="button subtle"
                    type="submit"
                    value="codes"
                    aria-describedby="mfa-codes-warning"
                  >
                    {"Generate recovery codes"}
                  </Button>
                </div>
                {"\n    "}
              </form>
              {"\n    "}
              <div id="mfa-manage-enrollment" hidden>
                <p className="small muted">
                  {
                    "Scan the new QR code or enter the setup key in your authenticator."
                  }
                </p>
                <img
                  id="mfa-manage-qr"
                  className="mfa-qr"
                  alt="New authenticator setup QR code"
                  width="220"
                  height="220"
                />
                <label htmlFor="mfa-manage-secret">{"Manual setup key"}</label>
                <Textarea
                  id="mfa-manage-secret"
                  className="mfa-secret"
                  rows="2"
                  readOnly
                  spellCheck="false"
                ></Textarea>
                <Button
                  id="mfa-manage-secret-copy"
                  type="button"
                  className="button subtle"
                >
                  {"Copy setup key"}
                </Button>
                <form id="mfa-manage-verify">
                  <label htmlFor="mfa-manage-new-code">
                    {"Code from the new authenticator"}
                  </label>
                  <Input
                    id="mfa-manage-new-code"
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    required
                  />
                  <Button className="button primary" type="submit">
                    {"Confirm new authenticator"}
                  </Button>
                  <Button
                    id="mfa-manage-cancel"
                    className="button subtle"
                    type="button"
                  >
                    {"Cancel replacement"}
                  </Button>
                </form>
              </div>
              {"\n    "}
              <div id="mfa-manage-codes" hidden>
                <p className="small muted">
                  {
                    "Save these single-use codes now. Previous codes no longer work."
                  }
                </p>
                <pre
                  id="mfa-manage-codes-value"
                  className="mfa-codes"
                  tabIndex="0"
                ></pre>
                <div className="token-actions">
                  <Button
                    id="mfa-manage-copy"
                    className="button subtle"
                    type="button"
                  >
                    {"Copy recovery codes"}
                  </Button>
                  <Button
                    id="mfa-manage-download"
                    className="button subtle"
                    type="button"
                  >
                    {"Download recovery codes"}
                  </Button>
                </div>
              </div>
              {"\n    "}
              <p
                id="mfa-manage-feedback"
                className="small muted"
                role="status"
              ></p>
              <p id="mfa-manage-error" className="form-error" role="alert"></p>
              {"\n  "}
            </section>
            <section
              className="settings-section"
              data-settings-panel="sessions"
              aria-labelledby="sessions-title"
              hidden
            >
              {"\n    "}
              <h2 id="sessions-title">{"Browser sessions"}</h2>
              {"\n    "}
              <p className="small muted">
                {
                  "Review signed-in browsers and revoke access. All sessions expire after seven days. Browser details are reported by the device and may be unavailable or inaccurate."
                }
              </p>
              {"\n    "}
              <div className="token-actions">
                <Button
                  id="sessions-refresh"
                  type="button"
                  className="button subtle"
                >
                  {"Refresh sessions"}
                </Button>
                <Button
                  id="sessions-others"
                  type="button"
                  className="button subtle"
                >
                  {"Sign out other browsers"}
                </Button>
              </div>
              {"\n    "}
              <ul id="sessions-list" aria-label="Browser sessions"></ul>
              {"\n    "}
              <form id="session-idle-form">
                <label htmlFor="session-idle">
                  {"Sign out this browser after inactivity"}
                </label>
                <select id="session-idle">
                  <option value="15">{"15 minutes"}</option>
                  <option value="60">{"1 hour"}</option>
                  <option value="1440">{"24 hours"}</option>
                  <option value="0">{"Only at the seven-day expiry"}</option>
                </select>
                <p className="small muted">
                  {
                    "Requests from an open library count as activity. Changing this setting requires recent password confirmation."
                  }
                </p>
                <Button className="button subtle" type="submit">
                  {"Save timeout"}
                </Button>
              </form>
              {"\n    "}
              <p
                id="sessions-feedback"
                className="small muted"
                role="status"
              ></p>
              <p id="sessions-error" className="form-error" role="alert"></p>
              {"\n  "}
            </section>
            {"        "}
            <section
              className="settings-section"
              data-settings-panel="api-keys"
              aria-labelledby="api-keys-title"
              hidden
            >
              {"\n    "}
              <div className="token-heading">
                <div>
                  <h2 id="api-keys-title">{"API keys"}</h2>
                  <p className="small muted">
                    {"Connect each app with its own key."}
                  </p>
                </div>
                <span id="token-count" className="small muted"></span>
              </div>
              {"\n    "}
              <div id="new-token" hidden>
                {"\n      "}
                <label htmlFor="new-token-value">{"New API key"}</label>
                {"\n      "}
                <Input
                  id="new-token-value"
                  type="password"
                  readOnly
                  autoComplete="off"
                  spellCheck="false"
                  aria-describedby="new-token-help"
                />
                {"\n      "}
                <p id="new-token-help" className="small muted">
                  {
                    "Copy this key now. You won’t be able to view it again after leaving Settings."
                  }
                </p>
                {"\n      "}
                <div className="token-actions">
                  {"\n        "}
                  <Button
                    id="toggle-token"
                    className="button subtle"
                    type="button"
                    aria-label="Show API key"
                    aria-controls="new-token-value"
                  >
                    {"Show key"}
                  </Button>
                  {"\n        "}
                  <Button
                    id="copy-token"
                    className="button subtle"
                    type="button"
                  >
                    {"Copy key"}
                  </Button>
                  {"\n      "}
                </div>
                {"\n    "}
              </div>
              {"\n    "}
              <p id="tokens-error" className="form-error" role="alert"></p>
              {"\n    "}
              <details id="token-create" className="token-create">
                <summary className="button primary">
                  <span data-icon="plus" aria-hidden="true"></span>
                  {"Create API key"}
                </summary>
                {"    "}
                <form id="token-form">
                  {"\n      "}
                  <p id="token-help" className="small muted">
                    {"Choose a name and the access this app needs."}
                  </p>
                  {"\n      "}
                  <label htmlFor="token-name">{"Key name"}</label>
                  {"\n      "}
                  <Input
                    id="token-name"
                    required
                    maxLength="100"
                    placeholder="My browser extension"
                    aria-describedby="token-help"
                  />
                  {"\n      "}
                  <label htmlFor="token-profile">{"Permissions"}</label>
                  {"\n      "}
                  <select
                    id="token-profile"
                    aria-describedby="token-permissions-help"
                  >
                    <option value="read">{"Read only"}</option>
                    <option value="capture">{"Add, edit & capture"}</option>
                    <option value="sync">{"Floccus sync"}</option>
                    <option value="full">{"Full library access"}</option>
                  </select>
                  {"\n      "}
                  <p id="token-permissions-help" className="small muted">
                    {
                      "Read only can read and export your library. No profile can manage your account, keys, sessions or full backups."
                    }
                  </p>
                  {"\n      "}
                  <label htmlFor="token-expiry">{"Expires after"}</label>
                  <select id="token-expiry">
                    <option value="30">{"30 days"}</option>
                    <option value="90">{"90 days"}</option>
                    <option value="365">{"1 year"}</option>
                    <option value="0">{"Never"}</option>
                  </select>
                  {"\n      "}
                  <Button className="button subtle" type="submit">
                    {"Create key"}
                  </Button>
                  {"\n    "}
                </form>
                {"\n    "}
              </details>
              {"\n    "}
              <ul
                id="token-list"
                aria-label="API keys"
                aria-describedby="token-activity-help"
              ></ul>
              {"\n    "}
              <p id="token-activity-help" className="small muted">
                {
                  "Last used includes connected apps and bookmark sync. Earlier activity may be unavailable."
                }
              </p>
              {"\n    "}
              <p id="tokens-feedback" className="small muted" role="status"></p>
              {"\n      "}
            </section>
            <section
              className="settings-section"
              data-settings-panel="backup"
              aria-labelledby="backup-title"
              hidden
            >
              <h2 id="backup-title">{"Backup & restore"}</h2>
              <p className="small muted">
                {
                  "A full backup keeps your bookmarks, captures, attachments, highlights and account settings together."
                }
              </p>
              <a className="button subtle" href="/api/backup">
                {"Download full backup"}
              </a>
              <details className="help-details">
                <summary>{"How to restore a backup"}</summary>
                <ol className="small muted">
                  <li>{"Stop Pocketmark before restoring."}</li>
                  <li>
                    {
                      "Unzip the backup and follow its RESTORE instructions. Use an empty PostgreSQL database and keep your server-secret (or legacy access-token / POCKETMARK_TOKEN) separately."
                    }
                  </li>
                  <li>
                    {
                      "Restore file ownership if needed, then restart Pocketmark."
                    }
                  </li>
                </ol>
                <p className="small muted">
                  {
                    "JSON and browser HTML exports contain bookmark metadata, not captures or attached files."
                  }
                </p>
              </details>
            </section>
            <section
              className="settings-section"
              data-settings-panel="sync"
              aria-labelledby="sync-title"
              hidden
            >
              {"\n    "}
              <h2 id="sync-title">{"Browser bookmark sync"}</h2>
              <p className="small muted">
                {
                  "Use a dedicated Floccus API key to sync bookmarks and collection folders."
                }
              </p>
              {"\n    "}
              <ol className="setup-steps">
                <li>
                  <a href="/?settings=api-keys">{"Create an API key"}</a>
                  {" with "}
                  <strong>{"Floccus sync"}</strong>
                  {" permissions."}
                </li>
                <li>
                  {"In Floccus, add a "}
                  <strong>{"WebDAV"}</strong>
                  {" account."}
                  <label htmlFor="sync-address">{"Server address"}</label>
                  <div className="copy-field">
                    <Input id="sync-address" readOnly />
                    <Button
                      id="sync-copy"
                      type="button"
                      className="button subtle"
                    >
                      {"Copy address"}
                    </Button>
                  </div>
                </li>
                <li>
                  {"Use "}
                  <code>{"bookmarks.xbel"}</code>
                  {
                    " as the file name, any username, and your dedicated API key as the password."
                  }
                </li>
              </ol>
              {"\n    "}
              <p className="small muted">
                {
                  "Uploading a Floccus file replaces the synchronized bookmark tree. Deletions in that file remove matching bookmarks."
                }
              </p>
              {"\n  "}
            </section>
            <section
              className="settings-section"
              data-settings-panel="mobile"
              aria-labelledby="mobile-title"
              hidden
            >
              {"\n    "}
              <h2 id="mobile-title">{"Mobile & browser"}</h2>
              {"\n    "}
              <h3>{"Install on your phone"}</h3>
              <p className="small muted">
                {
                  "Open Pocketmark in your phone’s browser, then choose its install or Add to Home Screen command. Availability depends on your browser and operating system."
                }
              </p>
              <p className="small muted">
                {
                  "Where supported, share a link from another app to Pocketmark to save it."
                }
              </p>
              {"\n    "}
              <h3>{"Save from Chrome"}</h3>
              <p className="small muted">
                {
                  "The companion extension can save a link, rendered HTML, screenshots or a PDF. Connect it to this server with a dedicated API key using "
                }
                <strong>{"Add, edit & capture"}</strong>
                {" permissions."}
              </p>
              <a className="button subtle" href="/?settings=api-keys">
                {"Manage API keys"}
              </a>
              {"\n    "}
              <h3>{"Keyboard shortcuts"}</h3>
              <label className="inline-check">
                <Input id="keyboard-shortcuts" type="checkbox" defaultChecked />
                {" Enable single-key shortcuts"}
              </label>
              <p className="small muted">
                {"Use "}
                <kbd>{"N"}</kbd>
                {" to add a bookmark and "}
                <kbd>{"/"}</kbd>
                {
                  " to search while browsing your library. Turn these off when using dictation or if they interrupt your work. This preference stays in this browser."
                }
              </p>
              {"\n  "}
            </section>
          </SettingsFrame>
          {"\n      "}
        </section>
        {"\n      "}
        <div id="library-content" className="library-content">
          {"\n      "}
          <p
            id="import-progress"
            className="operation-progress"
            role="status"
            hidden
          >
            {"Importing bookmarks…"}
          </p>
          {"\n      "}
          <p
            id="import-result"
            className="operation-result"
            role="status"
            hidden
          ></p>
          {"\n      "}
          <p
            id="upload-progress"
            className="operation-progress"
            role="status"
            hidden
          >
            {"Uploading file…"}
          </p>
          {"\n      "}
          <section id="tags-view" hidden aria-labelledby="tags-title">
            {"\n        "}
            <div className="library-header">
              <div>
                <h1 id="tags-title" tabIndex="-1">
                  {"Tags"}
                </h1>
                <p className="muted">
                  {"Browse your tags. Select one to see its bookmarks."}
                </p>
              </div>
              <Button id="tags-back" className="button subtle">
                <span data-icon="arrow-left" aria-hidden="true"></span>
                {"Back to library"}
              </Button>
            </div>
            {"\n        "}
            <label className="search-box">
              <span data-icon="search" aria-hidden="true"></span>
              <span className="sr-only">{"Search tags"}</span>
              <Input
                id="tags-search"
                type="search"
                placeholder="Search tags…"
                autoComplete="off"
                maxLength="512"
              />
            </label>
            {"\n        "}
            <p id="tags-library-context" className="small muted" hidden></p>
            <div className="tags-summary">
              <span id="tags-results" aria-live="polite"></span>
              <Button id="tags-retry" className="text-button">
                {"Refresh tags"}
              </Button>
            </div>
            {"\n        "}
            <div id="tags-letter-control" className="tags-letter-picker">
              <label htmlFor="tags-letter-picker">{"Jump to letter"}</label>
              <select id="tags-letter-picker">
                <option value="">{"Choose a letter"}</option>
              </select>
            </div>
            {"\n        "}
            <div
              id="tags-error"
              className="error-banner"
              role="alert"
              hidden
            ></div>
            {"\n        "}
            <div id="tags-index-layout" className="tags-index-layout">
              {"\n          "}
              <div
                id="tags-list"
                className="tags-directory"
                aria-label="Tags"
                aria-busy="false"
              ></div>
              {"\n          "}
              <nav
                id="tags-alphabet"
                className="tags-alphabet"
                aria-label="Jump to tag letter"
              ></nav>
              {"\n        "}
            </div>
            {"\n        "}
            <section
              id="tags-empty-state"
              className="empty-state"
              aria-labelledby="tags-empty-title"
              hidden
            >
              <div
                id="tags-empty-art"
                className="empty-art"
                data-icon="tag"
                aria-hidden="true"
              ></div>
              <h2 id="tags-empty-title">{"No tags yet"}</h2>
              <p id="tags-empty" className="muted">
                {
                  "Add tags when saving or editing a bookmark to group related ideas across collections."
                }
              </p>
              <div className="reader-actions">
                <Button
                  id="tags-browse-bookmarks"
                  className="button primary"
                  type="button"
                >
                  {"View all bookmarks"}
                </Button>
                <Button
                  id="tags-clear-search"
                  className="button primary"
                  type="button"
                  hidden
                >
                  {"Clear tag search"}
                </Button>
              </div>
            </section>
            {"\n        "}
            <nav
              id="tags-pagination"
              className="pagination"
              aria-label="Tag pages"
              hidden
            >
              <Button id="tags-previous" className="button subtle">
                {"Previous"}
              </Button>
              <span id="tags-page-label"></span>
              <Button id="tags-next" className="button subtle">
                {"Next"}
              </Button>
            </nav>
            {"\n      "}
          </section>
          {"\n      "}
          <div id="library-view">
            {"\n      "}
            <section className="library-header" aria-labelledby="page-title">
              {"\n        "}
              <div>
                <h1 id="page-title" tabIndex="-1">
                  {"All bookmarks"}
                </h1>
                <p id="page-subtitle" className="muted">
                  {"Everything you save, in one place."}
                </p>
              </div>
              {"\n        "}
              <div className="reader-actions">
                <Input
                  id="library-file"
                  type="file"
                  accept="application/pdf,image/png,image/jpeg,image/gif,image/webp,text/html,.html,.htm"
                  hidden
                />
                <Button id="add-bookmark" className="button primary">
                  <span data-icon="plus" aria-hidden="true"></span>
                  {"Add bookmark"}
                  <kbd data-shortcut-hint>{"N"}</kbd>
                </Button>
                <Button id="upload-file-button" className="button subtle">
                  <span data-icon="upload" aria-hidden="true"></span>
                  {"Upload file"}
                </Button>
              </div>
              {"\n      "}
            </section>
            {"\n      "}
            <div className="library-toolbar">
              {"\n        "}
              <label className="search-box">
                <span data-icon="search" aria-hidden="true"></span>
                <span className="sr-only">{"Search bookmarks"}</span>
                <Input
                  id="search"
                  type="search"
                  placeholder="Search bookmarks, tags, and content…"
                  autoComplete="off"
                />
                <kbd aria-hidden="true" data-shortcut-hint>
                  {"/"}
                </kbd>
              </label>
              {"\n      "}
            </div>
            {"\n      "}
            <div
              className="quick-filters"
              role="group"
              aria-label="Filter bookmarks"
            >
              {"\n        "}
              <Button type="button" data-quick-filter="all" aria-pressed="true">
                <span data-icon="check" aria-hidden="true"></span>
                {"All"}
              </Button>
              {"\n        "}
              <Button
                type="button"
                data-quick-filter="unread"
                aria-pressed="false"
              >
                <span data-icon="check" aria-hidden="true"></span>
                {"Unread"}
              </Button>
              {"\n        "}
              <Button
                type="button"
                data-quick-filter="favorite"
                aria-pressed="false"
              >
                <span data-icon="check" aria-hidden="true"></span>
                {"Favorites"}
              </Button>
              {"\n        "}
              <Button
                type="button"
                data-quick-filter="inbox"
                aria-pressed="false"
              >
                <span data-icon="check" aria-hidden="true"></span>
                {"Inbox"}
              </Button>
              {"\n      "}
            </div>
            {"\n      "}
            <div
              id="active-filters"
              className="active-filters"
              aria-label="Active filters"
              hidden
            ></div>
            {"\n      "}
            <div className="results-bar">
              <span id="results-label" aria-live="polite">
                {"Loading your library…"}
              </span>
              <div className="results-tools">
                <div className="selection-guidance">
                  <span className="selection-hint">
                    {"Click or drag to select"}
                  </span>
                  <details className="selection-help">
                    <summary aria-label="Selection help">
                      <span data-icon="info" aria-hidden="true"></span>
                    </summary>
                    <div id="selection-help" className="selection-help-panel">
                      <strong>{"Select bookmarks"}</strong>
                      <p>
                        {
                          "Click an empty area of a bookmark to select it. Drag across bookmarks to select several."
                        }
                      </p>
                      <p>
                        <kbd>{"Shift"}</kbd>
                        {" + click selects a range. "}
                        <kbd>{"Ctrl"}</kbd>
                        {" / "}
                        <kbd>{"⌘"}</kbd>
                        {" + drag adds to your selection."}
                      </p>
                      <p>
                        {"On the keyboard, focus a bookmark and press "}
                        <kbd>{"Space"}</kbd>
                        {". Press "}
                        <kbd>{"Esc"}</kbd>
                        {" to clear."}
                      </p>
                      <p>
                        {
                          "On touch screens, tap an empty area of a bookmark. Titles open the reader; action buttons work as usual."
                        }
                      </p>
                    </div>
                  </details>
                </div>
                {"\n        "}
                <div className="library-view-controls">
                  {"\n          "}
                  <Button
                    id="refresh-button"
                    className="button subtle icon-only"
                    title="Refresh library"
                    aria-label="Refresh library"
                  >
                    <span data-icon="refresh" aria-hidden="true"></span>
                  </Button>
                  {"\n          "}
                  <Button
                    id="sort-toggle"
                    className="button subtle"
                    type="button"
                    aria-label="Sort bookmarks: Newest first"
                    title="Sort bookmarks: Newest first"
                    aria-haspopup="menu"
                    aria-controls="sort-menu"
                    aria-expanded="false"
                  >
                    <span data-icon="sort" aria-hidden="true"></span>
                    <span id="sort-label">{"Newest first"}</span>
                  </Button>
                  {"\n          "}
                  <div
                    id="sort-menu"
                    className="sort-menu"
                    role="menu"
                    aria-labelledby="sort-menu-title"
                    hidden
                  >
                    {"\n            "}
                    <p id="sort-menu-title" className="sort-menu-title">
                      {"Sort bookmarks"}
                    </p>
                    {"\n            "}
                    <Button
                      type="button"
                      role="menuitemradio"
                      aria-checked="true"
                      data-sort="newest"
                      tabIndex="-1"
                    >
                      <span data-icon="check" aria-hidden="true"></span>
                      {"Newest first"}
                    </Button>
                    {"\n            "}
                    <Button
                      type="button"
                      role="menuitemradio"
                      aria-checked="false"
                      data-sort="oldest"
                      tabIndex="-1"
                    >
                      <span data-icon="check" aria-hidden="true"></span>
                      {"Oldest first"}
                    </Button>
                    {"\n            "}
                    <Button
                      type="button"
                      role="menuitemradio"
                      aria-checked="false"
                      data-sort="title"
                      tabIndex="-1"
                    >
                      <span data-icon="check" aria-hidden="true"></span>
                      {"Title A–Z"}
                    </Button>
                    {"\n            "}
                    <Button
                      type="button"
                      role="menuitemradio"
                      aria-checked="false"
                      data-sort="title_desc"
                      tabIndex="-1"
                    >
                      <span data-icon="check" aria-hidden="true"></span>
                      {"Title Z–A"}
                    </Button>
                    {"\n            "}
                    <Button
                      type="button"
                      role="menuitemradio"
                      aria-checked="false"
                      data-sort="updated"
                      tabIndex="-1"
                    >
                      <span data-icon="check" aria-hidden="true"></span>
                      {"Recently updated"}
                    </Button>
                    {"\n          "}
                  </div>
                  {"\n          "}
                  <div
                    className="view-switch"
                    role="group"
                    aria-label="Library view"
                  >
                    <Button
                      id="view-list"
                      className="view-button"
                      aria-label="List view"
                      aria-pressed="true"
                      title="List view"
                    >
                      <span data-icon="list" aria-hidden="true"></span>
                    </Button>
                    <Button
                      id="view-grid"
                      className="view-button"
                      aria-label="Grid view"
                      aria-pressed="false"
                      title="Grid view"
                    >
                      <span data-icon="grid" aria-hidden="true"></span>
                    </Button>
                  </div>
                  {"\n        "}
                </div>
                {"      "}
              </div>
            </div>
            {"\n      "}
            <div
              id="library-error"
              className="error-banner"
              role="alert"
              hidden
            ></div>
            {"\n      "}
            <section
              id="bookmark-grid"
              className="bookmark-grid view-list"
              aria-label="Bookmarks"
              aria-busy="true"
            ></section>
            {"\n      "}
            <section
              id="empty-state"
              className="empty-state"
              aria-labelledby="empty-title"
              hidden
            >
              <div
                id="empty-art"
                className="empty-art"
                data-icon="bookmark"
                aria-hidden="true"
              ></div>
              <h2 id="empty-title">{"Your library starts here"}</h2>
              <p id="empty-message" className="muted">
                {
                  "Save your first bookmark, or bring your existing bookmarks with you."
                }
              </p>
              <div className="reader-actions">
                <Button id="empty-add" className="button primary">
                  <span data-icon="plus" aria-hidden="true"></span>
                  {"Add bookmark"}
                </Button>
                <Button
                  id="empty-import"
                  className="button subtle"
                  type="button"
                >
                  {"Import bookmarks"}
                </Button>
                <Button id="empty-reset" className="button subtle" hidden>
                  {"Clear filters"}
                </Button>
              </div>
            </section>
            {"\n      "}
            <div
              id="bulk-bar"
              className="bulk-bar"
              role="group"
              aria-label="Selected bookmark actions"
              hidden
            >
              {"\n        "}
              <div className="bulk-selection">
                <span id="selected-count" role="status">
                  {"0 selected"}
                </span>
              </div>
              {"\n        "}
              <div className="bulk-buttons">
                {"\n          "}
                <Button
                  id="select-page"
                  type="button"
                  className="bulk-button"
                  aria-pressed="false"
                >
                  <span data-icon="list" aria-hidden="true"></span>
                  <span id="select-page-label">{"Select all"}</span>
                </Button>
                {"\n          "}
                <Button
                  id="bulk-move"
                  type="button"
                  className="bulk-button"
                  aria-haspopup="dialog"
                >
                  <span data-icon="folder-input" aria-hidden="true"></span>
                  {"Move"}
                </Button>
                {"\n          "}
                <Button
                  id="bulk-tag-action"
                  type="button"
                  className="bulk-button"
                  aria-haspopup="dialog"
                >
                  <span data-icon="tag" aria-hidden="true"></span>
                  {"Tags"}
                </Button>
                {"\n          "}
                <Button
                  id="bulk-favorite"
                  type="button"
                  className="bulk-button"
                  aria-haspopup="dialog"
                >
                  <span data-icon="star" aria-hidden="true"></span>
                  {"Favorites"}
                </Button>
                {"\n          "}
                <Button
                  id="bulk-read"
                  type="button"
                  className="bulk-button"
                  aria-haspopup="dialog"
                >
                  <span id="bulk-read-icon" aria-hidden="true"></span>
                  <span id="bulk-read-label">{"Read"}</span>
                </Button>
                {"\n          "}
                <Button
                  id="bulk-capture"
                  type="button"
                  className="bulk-button"
                  aria-haspopup="dialog"
                >
                  <span data-icon="refresh" aria-hidden="true"></span>
                  {"Refresh captures"}
                </Button>
                {"\n          "}
                <Button
                  id="bulk-delete"
                  type="button"
                  className="bulk-button bulk-delete"
                  aria-haspopup="dialog"
                >
                  <span data-icon="trash" aria-hidden="true"></span>
                  {"Delete"}
                </Button>
                {"\n        "}
              </div>
              {"\n        "}
              <Button
                id="bulk-open"
                type="button"
                className="bulk-button bulk-mobile-open"
                aria-haspopup="dialog"
              >
                <span data-icon="menu" aria-hidden="true"></span>
                {"Actions"}
              </Button>
              {"\n        "}
              <Button
                id="clear-selection"
                type="button"
                className="bulk-button bulk-clear"
                aria-label="Clear selection"
                title="Clear selection (Esc)"
              >
                <span data-icon="close" aria-hidden="true"></span>
              </Button>
              {"\n      "}
            </div>
            {"\n      "}
            <nav
              id="pagination"
              className="pagination"
              aria-label="Results pages"
              hidden
            >
              <Button id="previous-page" className="button subtle">
                <span data-icon="arrow-left" aria-hidden="true"></span>
                {"Previous"}
              </Button>
              <span id="page-label"></span>
              <Button id="next-page" className="button subtle">
                {"Next"}
                <span data-icon="arrow-right" aria-hidden="true"></span>
              </Button>
            </nav>
            {"\n      "}
          </div>
          {"\n      "}
          <footer className="main-footer">
            <span>{"Pocketmark"}</span>
            <span data-shortcut-hint>
              <kbd>{"/"}</kbd>
              {" Search "}
              <span className="shortcut-divider">{"·"}</span> <kbd>{"N"}</kbd>
              {" New bookmark"}
            </span>
          </footer>
          {"\n      "}
        </div>
        {"\n    "}
      </main>
      {"\n  "}
    </div>
  );
}
