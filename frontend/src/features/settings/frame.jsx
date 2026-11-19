import { Button } from "../../components/ui/button";
import { Icon } from "../../components/icon";
import { settingsGroups } from "./catalog";
import { Appearance, SettingsOverview } from "./overview";
import "./desk.css";

function NavItem({ id, icon, name }) {
  return (
    <Button type="button" className="nav-item" data-settings-section={id}>
      <Icon name={icon} />
      {name}
    </Button>
  );
}
export function SettingsFrame({ children }) {
  return (
    <>
      <span id="settings-title" className="sr-only">
        Settings
      </span>
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
          type="button"
          className="desk-library"
          data-settings-back
          aria-label="Back to library"
        >
          <Icon name="library" />
          <span>Library</span>
        </Button>
        <Button
          className="button subtle theme-toggle"
          data-theme-toggle
          aria-label="Dark mode"
          aria-pressed="true"
          title="Switch to light mode"
        >
          <span data-theme-icon aria-hidden="true" />
          <span data-theme-label>Dark</span>
        </Button>
      </header>
      <div className="settings-layout">
        <nav
          id="settings-navigation"
          className="settings-navigation"
          aria-label="Settings sections"
        >
          <NavItem id="overview" icon="grid" name="Overview" />
          {settingsGroups.map((group) => (
            <div key={group.name} role="group" aria-label={group.name}>
              <p>{group.name}</p>
              {group.entries.map((entry) => (
                <NavItem {...entry} key={entry.id} />
              ))}
            </div>
          ))}
        </nav>
        <div className="settings-workspace">
          <SettingsOverview />
          <div id="settings-detail-intro" hidden>
            <nav aria-label="Settings breadcrumb" className="desk-path">
              <Button data-settings-go="overview" type="button">
                <Icon name="arrow-left" />
                Overview
              </Button>
              <span aria-hidden="true">/</span>
              <span id="settings-detail-group" />
            </nav>
            <header className="desk-intro">
              <span id="settings-detail-icon" className="desk-emblem" />
              <div>
                <h1 id="settings-detail-title" tabIndex="-1" />
                <p id="settings-detail-description" />
              </div>
            </header>
          </div>
          <section
            data-settings-panel="appearance"
            className="settings-section"
            aria-label="Appearance"
            hidden
          >
            <Appearance />
          </section>
          {children}
        </div>
      </div>
    </>
  );
}
