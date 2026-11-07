import { Button } from "./ui/button";
import { Input } from "./ui/input";

export function HelpDialog() {
  return (
    <dialog
      id="help-dialog"
      className="modal help-modal"
      aria-labelledby="help-title"
    >
      {"\n    "}
      <header className="help-header">
        {"\n      "}
        <div className="dialog-heading">
          <h2 id="help-title">{"Help"}</h2>
          <Button
            type="button"
            className="icon-button close-dialog"
            aria-label="Close help"
          >
            <span data-icon="close" aria-hidden="true"></span>
          </Button>
        </div>
        {"\n      "}
        <label className="sr-only" htmlFor="help-search">
          {"Search help"}
        </label>
        {"\n      "}
        <Input
          id="help-search"
          type="search"
          placeholder="Search help"
          autoFocus
        />
        {"\n      "}
        <p
          id="help-results"
          className="small muted"
          role="status"
          aria-atomic="true"
        ></p>
        {"\n    "}
      </header>
      {"\n    "}
      <div className="help-body">
        {"\n      "}
        <div id="help-topics">
          {"\n        "}
          <details>
            {"\n          "}
            <summary>
              {"Bookmarks, collections & tags"}
              <span data-icon="chevron-right" aria-hidden="true"></span>
            </summary>
            {"\n          "}
            <div className="help-answer">
              {"\n            "}
              <ol>
                <li>
                  {"Choose "}
                  <strong>{"Add bookmark"}</strong>
                  {" and paste a URL."}
                </li>
                <li>
                  {"Pick a collection, or leave it in "}
                  <strong>{"Inbox"}</strong>
                  {"."}
                </li>
                <li>
                  {"In "}
                  <strong>{"Tags"}</strong>
                  {", choose an existing tag or type a new name and press "}
                  <kbd>{"Enter"}</kbd>
                  {"."}
                </li>
              </ol>
              {"\n            "}
              <p>
                {"Browse your full index in "}
                <strong>{"Tags"}</strong>
                {
                  ". To edit several bookmarks at once, click or tap an empty area of each bookmark, then choose "
                }
                <strong>{"Actions"}</strong>
                {". You can also focus a bookmark and press "}
                <kbd>{"Space"}</kbd>
                {"."}
              </p>
              {"\n          "}
            </div>
            {"\n        "}
          </details>
          {"\n        "}
          <details>
            {"\n          "}
            <summary>
              {"Search & filters"}
              <span data-icon="chevron-right" aria-hidden="true"></span>
            </summary>
            {"\n          "}
            <div className="help-answer">
              {"\n            "}
              <p>
                {
                  "Search covers titles, URLs, descriptions, notes, tags and captured text. A highlighted excerpt shows the match."
                }
              </p>
              {"\n            "}
              <p>
                {
                  "Search automatically includes similar words in bookmark titles, URLs, descriptions and tags, alongside full-text matches in notes and captured text."
                }
              </p>
              {"\n            "}
              <p>{"Clear the active chips to remove filters."}</p>
              {"\n          "}
            </div>
            {"\n        "}
          </details>
          {"\n        "}
          <details>
            {"\n          "}
            <summary>
              {"Reading, highlights & notes"}
              <span data-icon="chevron-right" aria-hidden="true"></span>
            </summary>
            {"\n          "}
            <div className="help-answer">
              {"\n            "}
              <p>
                {
                  "Open a bookmark’s title to see its saved HTML, screenshots and PDFs. Choose a format to open the latest copy and use the file selector for earlier copies. To read extracted text, choose "
                }
                <strong>{"Reading options → Text & highlights"}</strong>
                {
                  ". Reading options also contains text size, formatted view and capture controls."
                }
              </p>
              {"\n            "}
              <ul>
                <li>
                  {"Select a passage, then choose "}
                  <strong>{"Highlight"}</strong>
                  {"."}
                </li>
                <li>
                  {"Use "}
                  <strong>{"Notes"}</strong>
                  {" in the reader toolbar to write and save your notes."}
                </li>
              </ul>
              {"\n          "}
            </div>
            {"\n        "}
          </details>
          {"\n        "}
          <details>
            {"\n          "}
            <summary>
              {"Failed or missing captures"}
              <span data-icon="chevron-right" aria-hidden="true"></span>
            </summary>
            {"\n          "}
            <div className="help-answer">
              {"\n            "}
              <ol>
                <li>
                  {"Open the bookmark to check its capture status and reason."}
                </li>
                <li>
                  {"If it failed, choose "}
                  <strong>{"Retry capture"}</strong>
                  {". You can also use "}
                  <strong>{"Reading options → Refresh capture"}</strong>
                  {"."}
                </li>
                <li>
                  {"If the site requires signing in or blocks capture, use "}
                  <strong>{"Visit original"}</strong>
                  {", then attach an HTML snapshot or PDF under "}
                  <strong>{"Files"}</strong>
                  {"."}
                </li>
              </ol>
              {"\n            "}
              <p>{"Text-only captures cannot provide a formatted page."}</p>
              {"\n          "}
            </div>
            {"\n        "}
          </details>
          {"\n        "}
          <details>
            {"\n          "}
            <summary>
              {"Unsaved drafts"}
              <span data-icon="chevron-right" aria-hidden="true"></span>
            </summary>
            {"\n          "}
            <div className="help-answer">
              {"\n            "}
              <p>
                {
                  "Unsaved bookmark edits, notes and annotations stay in this tab when you close a dialog. They also survive a reload when browser storage is available. A warning appears before leaving with unsaved work."
                }
              </p>
              {"\n            "}
              <p>
                {"Save before closing the tab or signing out. "}
                <strong>{"Discard draft"}</strong>
                {" removes only your unsaved changes."}
              </p>
              {"\n          "}
            </div>
            {"\n        "}
          </details>
          {"\n        "}
          <details>
            {"\n          "}
            <summary>
              {"Backup & restore"}
              <span data-icon="chevron-right" aria-hidden="true"></span>
            </summary>
            {"\n          "}
            <div className="help-answer">
              {"\n            "}
              <p>
                <strong>{"Settings → Backup & restore"}</strong>
                {
                  " downloads the full library, captures, files and account settings. Keep the ZIP private."
                }
              </p>
              {"\n            "}
              <ol>
                <li>{"Stop Pocketmark."}</li>
                <li>
                  {
                    "Restore into an empty data directory, following the included "
                  }
                  <code>{"RESTORE.txt"}</code>
                  {" instructions."}
                </li>
                <li>{"Restart Pocketmark."}</li>
              </ol>
              {"\n            "}
              <p>
                {"Keep your server-secret (or legacy access-token / "}
                <code>{"POCKETMARK_TOKEN"}</code>
                {
                  ") separately. JSON and HTML exports contain bookmark metadata only."
                }
              </p>
              {"\n          "}
            </div>
            {"\n        "}
          </details>
          {"\n        "}
          <details>
            {"\n          "}
            <summary>
              {"Extensions & browser sync"}
              <span data-icon="chevron-right" aria-hidden="true"></span>
            </summary>
            {"\n          "}
            <div className="help-answer">
              {"\n            "}
              <p>
                {"Create a dedicated key under "}
                <strong>{"Settings → API keys"}</strong>
                {" for each extension or sync app. Choose "}
                <strong>{"Add, edit & capture"}</strong>
                {" for the Pocketmark extension, or "}
                <strong>{"Floccus sync"}</strong>
                {
                  " for Floccus. Browser sign-in uses your password and an authentication or recovery code."
                }
              </p>
              {"\n            "}
              <p>
                <strong>{"Settings"}</strong>
                {
                  " contains Floccus WebDAV instructions and mobile installation guidance."
                }
              </p>
              {"\n            "}
              <p>
                {
                  "Floccus uploads replace the synchronized bookmark tree. Review sync settings before uploading."
                }
              </p>
              {"\n          "}
            </div>
            {"\n        "}
          </details>
          {"\n        "}
          <details>
            {"\n          "}
            <summary>
              {"Keyboard shortcuts"}
              <span data-icon="chevron-right" aria-hidden="true"></span>
            </summary>
            {"\n          "}
            <div className="help-answer">
              {"\n            "}
              <dl className="help-shortcuts">
                {"\n              "}
                <div>
                  <dt>
                    <kbd>{"/"}</kbd>
                  </dt>
                  <dd>{"Search bookmarks or tags"}</dd>
                </div>
                {"\n              "}
                <div>
                  <dt>
                    <kbd>{"N"}</kbd>
                  </dt>
                  <dd>{"Add a bookmark"}</dd>
                </div>
                {"\n              "}
                <div>
                  <dt>
                    <kbd>{"Escape"}</kbd>
                  </dt>
                  <dd>{"Close a dialog; unsaved edits stay as a draft"}</dd>
                </div>
                {"\n              "}
                <div>
                  <dt>
                    <kbd>{"Tab"}</kbd>
                    {" / "}
                    <kbd>{"Shift"}</kbd>
                    {" + "}
                    <kbd>{"Tab"}</kbd>
                  </dt>
                  <dd>{"Move between controls"}</dd>
                </div>
                {"\n              "}
                <div>
                  <dt>
                    <kbd>{"Enter"}</kbd>
                    {" / "}
                    <kbd>{"Space"}</kbd>
                  </dt>
                  <dd>{"Activate a control"}</dd>
                </div>
                {"\n            "}
              </dl>
              {"\n            "}
              <p>
                {"The "}
                <kbd>{"/"}</kbd>
                {" and "}
                <kbd>{"N"}</kbd>
                {" shortcuts work when you are not typing in a field."}
              </p>
              {"\n          "}
            </div>
            {"\n        "}
          </details>
          {"\n      "}
        </div>
        {"\n      "}
        <div id="help-empty" hidden>
          <p>{"No matching topics."}</p>
          <p className="muted">{"Try “tags”, “capture” or “backup”."}</p>
          <Button id="help-clear" type="button" className="button subtle">
            {"Clear search"}
          </Button>
        </div>
        {"\n    "}
      </div>
      {"\n  "}
    </dialog>
  );
}
