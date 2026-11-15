import { Button } from "../../components/ui/button";

import "../../forms.css";

const groups = [
  [
    "Account & security",
    [
      ["password", "lock", "Password"],
      ["2fa", "shield", "Two-factor authentication"],
      ["sessions", "monitor", "Browser sessions"],
    ],
  ],
  [
    "Apps & devices",
    [
      ["mobile", "book", "Phone & browser extension"],
      ["api-keys", "key", "API keys"],
      ["sync", "refresh", "Browser bookmark sync"],
    ],
  ],
  [
    "Library & data",
    [
      ["preferences", "settings", "Preferences"],
      ["transfer", "folder-input", "Import & export"],
      ["backup", "download", "Backup & restore"],
    ],
  ],
];

export function SettingsFrame({ children }) {
  return (
    <>
      <h1 id="settings-title" className="sr-only">
        Settings
      </h1>
      <header className="settings-topbar">
        <Button
          type="button"
          className="brand"
          data-settings-home
          aria-label="Pocketmark home"
        >
          <img
            className="brand-mark"
            src="/icon.svg"
            width="29"
            height="32"
            alt=""
          />
          <span>Pocketmark</span>
        </Button>
        <Button type="button" className="text-button" id="settings-overview">
          All settings
        </Button>
        <Button
          className="button subtle theme-toggle"
          data-theme-toggle
          aria-label="Dark mode"
          aria-pressed="true"
          title="Switch to light mode"
        >
          <span data-theme-icon aria-hidden="true"></span>
          <span data-theme-label>Dark</span>
        </Button>
      </header>
      <div className="settings-layout">
        <nav
          id="settings-navigation"
          className="settings-navigation"
          aria-label="Settings sections"
        >
          <h2 id="settings-index-title" tabIndex="-1">
            Settings
          </h2>
          <div className="settings-groups">
            {groups.map(([label, sections]) => (
              <section
                className="settings-group"
                key={label}
                aria-label={label}
              >
                <h3>{label}</h3>
                {sections.map(([section, icon, title]) => (
                  <Button
                    type="button"
                    key={section}
                    className="nav-item"
                    data-settings-section={section}
                  >
                    <span data-icon={icon} aria-hidden="true" />
                    {title}
                  </Button>
                ))}
              </section>
            ))}
          </div>
          <Button
            type="button"
            className="nav-item settings-library-back"
            data-settings-back
          >
            <span data-icon="arrow-left" aria-hidden="true"></span>
            Back to library
          </Button>
        </nav>
        <div className="settings-workspace">{children}</div>
      </div>
    </>
  );
}
