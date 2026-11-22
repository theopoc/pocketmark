import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { AccountPanels } from "../features/settings/account-panels";
import { SettingsGuides } from "../features/settings/guides";
import { SettingsFrame } from "../features/settings/frame";
import { SessionsPanel } from "../features/settings/sessions";

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
              className="settings-feature"
              data-settings-panel="ai-tagging"
              aria-labelledby="ai-tagging-title"
              hidden
            >
              <header className="account-section-heading">
                <h1 id="ai-tagging-title" tabIndex="-1">
                  AI tagging
                </h1>
                <p>
                  ChatGPT applies up to three tags per bookmark. It reuses your
                  existing tags and creates lowercase tags when none fit.
                </p>
              </header>
              <div id="ai-tagging-settings" />
            </section>
            <AccountPanels />
            <SessionsPanel />
            {"        "}
            <section
              className="settings-feature"
              data-settings-panel="api-keys"
              aria-labelledby="api-keys-title"
              hidden
            >
              <div id="token-list"></div>
            </section>
            <SettingsGuides />
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
            <fieldset className="quick-filters">
              <legend className="sr-only">Filter bookmarks</legend>
              {[
                ["all", "All", "library"],
                ["unread", "Unread", "clock"],
                ["favorite", "Favorites", "star"],
                ["inbox", "Inbox", "inbox"],
              ].map(([value, label, icon]) => (
                <label key={value}>
                  <Input
                    type="radio"
                    name="quick-filter"
                    value={value}
                    defaultChecked={value === "all"}
                  />
                  <span className="quick-filter-label">
                    <span data-icon={icon} aria-hidden="true"></span>
                    {label}
                  </span>
                </label>
              ))}
            </fieldset>
            {"\n      "}
            <div
              id="active-filters"
              className="active-filters"
              role="group"
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
