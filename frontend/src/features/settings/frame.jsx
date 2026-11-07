import { Button } from "../../components/ui/button";

const sections = [
  ["api-keys", "key", "API keys"],
  ["2fa", "shield", "Two-factor authentication"],
  ["sessions", "monitor", "Browser sessions"],
  ["password", "lock", "Password"],
  ["backup", "download", "Backup & restore"],
  ["sync", "refresh", "Browser bookmark sync"],
  ["mobile", "book", "Mobile & browser"],
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
        <span className="muted">Personal library</span>
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
          {sections.map(([section, icon, label]) => (
            <Button
              key={section}
              type="button"
              className="nav-item"
              data-settings-section={section}
            >
              <span data-icon={icon} aria-hidden="true"></span>
              {label}
            </Button>
          ))}
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
