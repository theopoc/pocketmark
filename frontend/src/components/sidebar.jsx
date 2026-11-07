import { Button } from "./ui/button";
import { Input } from "./ui/input";

export function Sidebar() {
  return (
    <aside id="sidebar" className="sidebar" aria-label="Library navigation">
      {"\n      "}
      <div className="sidebar-brand">
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
          id="sidebar-mode"
          type="button"
          className="icon-button"
          aria-pressed="false"
          aria-label="Keep navigation open"
          title="Keep navigation open"
        >
          <span id="sidebar-mode-icon" aria-hidden="true"></span>
        </Button>
        <Button
          id="close-navigation"
          className="icon-button"
          aria-label="Close navigation"
        >
          <span data-icon="close" aria-hidden="true"></span>
        </Button>
      </div>
      {"\n      "}
      <div id="library-navigation">
        {"\n      "}
        <Button
          id="workspace-button"
          type="button"
          className="workspace-label"
          popoverTarget="workspace-popover"
          aria-expanded="false"
          aria-controls="workspace-popover"
          data-keep-navigation=""
        >
          <span className="workspace-avatar" aria-hidden="true">
            {"P"}
          </span>
          <span className="workspace-name">
            {"Library tools"}
            <span className="workspace-subtitle">
              {"Import, export & sign out"}
            </span>
          </span>
          <span
            className="workspace-chevron"
            data-icon="chevron-right"
            aria-hidden="true"
          ></span>
        </Button>
        {"\n      "}
        <div
          id="workspace-popover"
          className="workspace-popover"
          popover=""
          aria-label="Workspace actions"
        >
          {"\n        "}
          <Button
            id="import-button"
            type="button"
            className="nav-item"
            autoFocus
          >
            <span data-icon="download" aria-hidden="true"></span>
            {"Import"}
          </Button>
          {"\n        "}
          <Button id="export-button" type="button" className="nav-item">
            <span data-icon="upload" aria-hidden="true"></span>
            {"Export"}
          </Button>
          {"\n        "}
          <hr />
          {"\n        "}
          <Button
            id="logout-button"
            type="button"
            className="nav-item workspace-sign-out"
          >
            <span data-icon="logout" aria-hidden="true"></span>
            {"Sign out"}
          </Button>
          {"\n      "}
        </div>
        {"\n      "}
        <nav aria-label="Library">
          {"\n        "}
          <Button
            className="nav-item active"
            data-filter="all"
            aria-current="page"
          >
            <span data-icon="library" aria-hidden="true"></span>
            {"All bookmarks "}
            <span id="total-count" className="nav-count">
              {"0"}
            </span>
          </Button>
          {"\n        "}
          <Button className="nav-item" data-filter="inbox">
            <span data-icon="inbox" aria-hidden="true"></span>
            {"Inbox"}
          </Button>
          {"\n        "}
          <Button className="nav-item" data-filter="favorite">
            <span data-icon="star" aria-hidden="true"></span>
            {"Favorites"}
          </Button>
          {"\n        "}
          <Button className="nav-item" data-filter="unread">
            <span data-icon="clock" aria-hidden="true"></span>
            {"To read"}
          </Button>
          {"\n        "}
          <Button id="all-tags" className="nav-item">
            <span data-icon="tag" aria-hidden="true"></span>
            {"Tags"}
          </Button>
          {"\n      "}
        </nav>
        {"\n      "}
        <div className="sidebar-section-title">
          <h2>{"Collections"}</h2>
          <Button
            id="add-collection"
            className="icon-button"
            data-keep-navigation
            title="New collection"
            aria-label="New collection"
          >
            <span data-icon="plus" aria-hidden="true"></span>
          </Button>
        </div>
        {"\n      "}
        <div id="collections" className="collection-list"></div>
        {"\n      "}
        <div className="sidebar-bottom">
          {"\n        "}
          <div
            id="frequent-tags-heading"
            className="sidebar-section-title"
            hidden
          >
            <h2>{"Frequent tags"}</h2>
          </div>
          {"\n        "}
          <div id="tags" className="tag-cloud"></div>
          {"\n        "}
          <div className="sidebar-tools">
            <Button id="settings-button" type="button" className="nav-item">
              <span data-icon="settings" aria-hidden="true"></span>
              {"Settings"}
            </Button>
            <Button id="help-button" className="nav-item">
              <span data-icon="help" aria-hidden="true"></span>
              {"Help"}
            </Button>
            {"\n        "}
            <a className="nav-item api-documentation-link" href="/api-docs/">
              <span data-icon="book" aria-hidden="true"></span>
              {"API documentation"}
            </a>
          </div>
          {"\n        "}
          <Input
            id="import-file"
            type="file"
            accept="application/json,text/html,.json,.html,.htm"
            hidden
          />
          {"\n      "}
        </div>
        {"\n      "}
      </div>
      {"\n      "}
    </aside>
  );
}
