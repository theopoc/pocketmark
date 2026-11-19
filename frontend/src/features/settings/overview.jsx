import { Button } from "../../components/ui/button";
import { Icon } from "../../components/icon";
import { settingsEntries, settingsGroups } from "./catalog";
import { SettingsThemes } from "./themes";

export function Appearance({ overview = false }) {
  return (
    <div className="desk-appearance">
      <header className="desk-card-heading">
        <h2>{overview ? "Appearance" : "Color theme"}</h2>
        <p>Choose the theme for this browser.</p>
      </header>
      <SettingsThemes />
      <label className="desk-shortcuts">
        <span>
          <strong>Single-key shortcuts</strong>
          <span className="desk-shortcuts-hint">
            <kbd>N</kbd> to add a bookmark, <kbd>/</kbd> to search.
          </span>
        </span>
        <input
          id={overview ? "overview-shortcuts" : "keyboard-shortcuts"}
          data-settings-shortcuts=""
          type="checkbox"
          role="switch"
          aria-label="Single-key shortcuts"
          defaultChecked
        />
      </label>
    </div>
  );
}
function Destination({ entry }) {
  return (
    <Button type="button" className="desk-row" data-settings-go={entry.id}>
      <span className="desk-row-icon">
        <Icon name={entry.icon} />
      </span>
      <span className="desk-row-label">
        <strong>{entry.name}</strong>
        <small>{entry.description}</small>
      </span>
      {entry.id === "2fa" && (
        <span className="desk-mfa-status" data-settings-mfa-status="" />
      )}
      {entry.id === "sessions" && (
        <span className="desk-value" data-settings-session-count="" />
      )}
      {entry.id === "api-keys" && (
        <span className="desk-value" data-settings-key-count="" />
      )}
      <Icon name="chevron-right" />
    </Button>
  );
}
export function SettingsOverview() {
  return (
    <section
      data-settings-panel="overview"
      aria-labelledby="settings-overview-title"
      hidden
    >
      <div className="desk-page-heading">
        <div>
          <h1 id="settings-overview-title" tabIndex="-1">
            Library settings
          </h1>
          <p>Make Pocketmark yours and manage access to your library.</p>
        </div>
        <div className="desk-find">
          <Icon name="search" />
          <input
            id="settings-search"
            type="search"
            aria-label="Search settings"
            placeholder="Find a setting…"
            autoComplete="off"
            maxLength={160}
          />
          <Button
            id="settings-clear-search"
            type="button"
            aria-label="Clear search"
            hidden
          >
            <Icon name="close" />
          </Button>
        </div>
      </div>
      <div id="settings-overview-cards">
        <div className="desk-feature-grid">
          <div className="desk-surface">
            <Appearance overview />
          </div>
          <section
            className="desk-backup desk-surface"
            aria-labelledby="desk-backup-title"
          >
            <div className="desk-backup-art" aria-hidden="true" />
            <div className="desk-backup-info">
              <div>
                <h2 id="desk-backup-title">Library backup</h2>
                <p>Save bookmarks, captures and notes in one archive.</p>
              </div>
              <Button type="button" variant="outline" data-settings-go="backup">
                Backup &amp; restore <Icon name="arrow-right" />
              </Button>
            </div>
          </section>
        </div>
        <div className="desk-groups">
          {settingsGroups.slice(1).map((group) => (
            <section
              className="desk-category"
              key={group.name}
              aria-label={group.name}
            >
              <h2>{group.name}</h2>
              <div className="desk-surface">
                {group.entries.map((entry) => (
                  <Destination key={entry.id} entry={entry} />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
      <section
        id="settings-search-results"
        className="desk-results"
        aria-label="Search results"
        hidden
      >
        <h2 role="status" id="settings-match-count" />
        <div className="desk-surface" id="settings-matches">
          {settingsEntries.map((entry) => (
            <Destination key={entry.id} entry={entry} />
          ))}
        </div>
        <p id="settings-no-match" hidden>
          Try “theme”, “backup” or “sessions”.
        </p>
      </section>
    </section>
  );
}
