import { Button } from "../../components/ui/button";
import { Icon } from "../../components/icon";

function LibrarySample({ mode }) {
  return (
    <span className={"desk-sample " + mode} aria-hidden="true">
      <span className="desk-sample-window">
        <span className="desk-sample-header">
          <img src="/icon.svg" alt="" />
          Pocketmark
        </span>
        <span className="desk-sample-layout">
          <span className="desk-sample-menu">
            <i />
            <i />
            <i />
          </span>
          <span className="desk-sample-content">
            <b>All bookmarks</b>
            {[
              ["book", "Reading list"],
              ["folder", "Design notes"],
              ["bookmark", "Field guide"],
            ].map(([icon, name]) => (
              <span className="desk-sample-row" key={name}>
                <Icon name={icon} />
                {name}
              </span>
            ))}
          </span>
        </span>
      </span>
    </span>
  );
}
export function SettingsThemes() {
  return (
    <div className="desk-palette" role="group" aria-label="Color theme">
      {["light", "dark"].map((mode) => (
        <Button
          key={mode}
          className="desk-choice"
          type="button"
          data-settings-theme={mode}
          aria-pressed={mode === "dark"}
        >
          <LibrarySample mode={mode} />
          <span className="desk-choice-foot">
            <Icon name={mode === "light" ? "sun" : "moon"} />
            {mode === "light" ? "Light" : "Dark"}
            <span className="desk-choice-mark">
              <Icon name="check" />
            </span>
          </span>
        </Button>
      ))}
    </div>
  );
}
