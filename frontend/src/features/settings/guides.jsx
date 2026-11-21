import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";

function Guide({ id, title, children }) {
  return (
    <section
      className="settings-section settings-guide"
      data-settings-panel={id}
      aria-labelledby={id + "-title"}
      hidden
    >
      <h2 id={id + "-title"}>{title}</h2>
      {children}
    </section>
  );
}

export function SettingsGuides() {
  return (
    <>
      <section
        className="settings-feature"
        id="scheduled-backups"
        data-settings-panel="backup"
        aria-labelledby="backup-title"
        hidden
      />
      <Guide id="sync" title="Connect Floccus">
        <p className="small muted">
          Use a dedicated Floccus API key to sync bookmarks and collection
          folders.
        </p>
        <ol className="setup-steps">
          <li>
            <a href="/?settings=api-keys">Create an API key</a> with the{" "}
            <strong>Sync</strong> role.
          </li>
          <li>
            In Floccus, add a <strong>WebDAV</strong> account.
            <label htmlFor="sync-address">Server address</label>
            <div className="copy-field">
              <Input id="sync-address" readOnly />
              <Button id="sync-copy" className="button subtle" type="button">
                Copy address
              </Button>
            </div>
          </li>
          <li>
            Use <code>bookmarks.xbel</code> as the file name, any username, and
            your dedicated API key as the password.
          </li>
        </ol>
        <p className="small muted">
          Uploading a Floccus file replaces the synchronized bookmark tree.
          Deletions in that file remove matching bookmarks.
        </p>
      </Guide>
      <section
        className="settings-section settings-guide"
        data-settings-panel="mobile"
        aria-labelledby="mobile-title"
        hidden
      >
        <section>
          <h2 id="mobile-title">Install on your phone</h2>
          <p className="small muted">
            Open Pocketmark in your phone’s browser, then choose its install or
            Add to Home Screen command. Availability depends on your browser and
            operating system.
          </p>
          <p className="small muted">
            Where supported, share a link from another app to Pocketmark to save
            it.
          </p>
        </section>
        <section>
          <h2>Save from Chrome</h2>
          <p className="small muted">
            The companion extension can save a link, rendered HTML, screenshots
            or a PDF. Connect it to this server with a dedicated API key using
            the <strong>Editor</strong> role.
          </p>
          <a className="button subtle" href="/?settings=api-keys">
            Manage API keys
          </a>
        </section>
      </section>
    </>
  );
}
