import { SiteIcon } from "./site-icon";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { Icon } from "../../components/icon";
import { renderRegion } from "../../lib/render";

// The tested workspace rules also serve the standalone browser adapters.
import workspace from "../workspace.js";
const { domain, safeURL, searchExcerpt } = workspace;

function BookmarkAction({
  link,
  name,
  label,
  index,
  onClick,
  className = "",
  ...props
}) {
  return (
    <Button
      className={`card-action ${className}`}
      title={label}
      aria-label={`${label}: ${link.title || link.url}`}
      data-focus-key={`link:${link.id}:action:${index}`}
      onClick={onClick}
      {...props}
    >
      <Icon name={name} />
      <span className="mobile-action-label">{label}</span>
    </Button>
  );
}

function Thumbnail({ link, view }) {
  const [failed, setFailed] = useState(false);
  if (!link.hasThumbnail || failed) return null;
  return (
    <img
      className="card-thumbnail"
      alt=""
      loading="lazy"
      decoding="async"
      data-src={`/api/links/${link.id}/thumbnail`}
      src={view === "grid" ? `/api/links/${link.id}/thumbnail` : undefined}
      onError={() => setFailed(true)}
    />
  );
}

export function BookmarkCard({ link, model }) {
  const {
    view,
    query,
    expandedActions,
    expandedTags,
    onOpen,
    onEdit,
    onUpdate,
    onTag,
    onMoreTags,
    onActions,
    onDelete,
  } = model;
  const host = link.type === "file" ? "Saved file" : domain(link.url);
  const favoriteLabel = link.favorite
    ? "Remove from favorites"
    : "Add to favorites";
  const favorite = (
    <Button
      className={`card-action favorite-button${link.favorite ? " is-favorite" : ""}`}
      title={favoriteLabel}
      aria-label={`${favoriteLabel}: ${link.title || link.url}`}
      aria-pressed={!!link.favorite}
      data-focus-key={`link:${link.id}:action:0`}
      onClick={(event) =>
        onUpdate(link, { favorite: !link.favorite }, event.currentTarget)
      }
    >
      <Icon name="star" />
      <span className="mobile-action-label">Favorite</span>
    </Button>
  );
  const hostLabel = (
    <p
      className="card-domain"
      title={link.type === "file" ? undefined : link.url}
    >
      {host}
    </p>
  );
  const statuses = {
    pending: "Queued",
    processing: "Saving…",
    ready: "Captured",
    failed: "Capture failed",
  };
  const url = safeURL(link.url);
  const expanded = expandedActions === link.id;
  return (
    <article
      className="bookmark-card"
      data-id={link.id}
      data-label={link.title || link.url}
      data-focus-key={`link:${link.id}:select`}
      tabIndex={0}
      role="group"
      aria-keyshortcuts="Space Shift+Space"
      aria-description="Press Space to toggle selection. Shift+Space selects a range."
    >
      <div className="card-top">
        {view === "grid" && (
          <>
            {hostLabel}
            {favorite}
          </>
        )}
      </div>
      <Thumbnail key={model.revision} link={link} view={view} />
      <div className="card-body">
        <SiteIcon
          key={`${model.revision}:${link.updatedAt || link.url}`}
          link={link}
          view={view}
        />
        <div className="card-title-row">
          {view !== "grid" && favorite}
          <h2 className="card-title">
            <Button
              data-focus-key={`link:${link.id}:open`}
              onClick={() => onOpen(link)}
            >
              {link.title || link.url}
            </Button>
          </h2>
        </div>
        {link.description && (
          <p className="card-description">{link.description}</p>
        )}
        {query && link.searchSnippet && (
          <p className="search-excerpt">
            <span className="search-match-label">Match: </span>
            {searchExcerpt(link.searchSnippet).map((part, i) =>
              part.match ? <mark key={i}>{part.text}</mark> : part.text,
            )}
          </p>
        )}
        <div className="card-metadata">
          {view !== "grid" && hostLabel}
          <div className="card-tags">
            {(link.tags || [])
              .slice(0, expandedTags.has(link.id) ? undefined : 5)
              .map((name) => (
                <Button
                  key={name}
                  className="card-tag"
                  data-focus-key={`link:${link.id}:tag:${name}`}
                  onClick={() => onTag(name)}
                >
                  #{name}
                </Button>
              ))}
            {(link.tags || []).length > 5 && !expandedTags.has(link.id) && (
              <Button
                className="card-tag"
                data-focus-key={`link:${link.id}:more-tags`}
                aria-label={`Show all ${link.tags.length} tags for ${link.title || link.url}`}
                onClick={() => onMoreTags(link)}
              >
                +{link.tags.length - 5}
              </Button>
            )}
          </div>
        </div>
      </div>
      <div className="card-footer">
        <span
          className={`card-state ${statuses[link.status] ? link.status : "saved"}`}
        >
          {link.status === "processing" || !statuses[link.status] ? (
            <span className="capture-indicator" aria-hidden="true" />
          ) : (
            <Icon
              name={
                link.status === "ready"
                  ? "check"
                  : link.status === "failed"
                    ? "warning"
                    : "clock"
              }
            />
          )}
          {statuses[link.status] || "Not captured"}
        </span>
        <div className="card-actions">
          <Button
            type="button"
            className="card-actions-toggle button subtle"
            data-focus-key={`link:${link.id}:more`}
            aria-label={`Actions for ${link.title || link.url}`}
            aria-controls={`link-${link.id}-actions`}
            aria-expanded={expanded}
            onClick={() => onActions(link)}
          >
            Actions
          </Button>
          <div
            className={`card-overflow-actions${expanded ? " is-open" : ""}`}
            id={`link-${link.id}-actions`}
          >
            <BookmarkAction
              link={link}
              name={link.read ? "check" : "clock"}
              label={link.read ? "Mark unread" : "Mark as read"}
              index={1}
              className={link.read ? "read" : ""}
              onClick={(event) =>
                onUpdate(link, { read: !link.read }, event.currentTarget)
              }
            />
            <BookmarkAction
              link={link}
              name="edit"
              label="Edit bookmark"
              index={2}
              onClick={() => onEdit(link)}
            />
            <BookmarkAction
              link={link}
              name="trash"
              label="Delete bookmark"
              index={3}
              onClick={() => onDelete(link)}
            />
            {url && (
              <Button asChild className="card-action">
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Visit original"
                  aria-label={`Visit original: ${link.title || link.url}`}
                  data-focus-key={`link:${link.id}:action:4`}
                >
                  <Icon name="external" />
                  <span className="mobile-action-label">Visit original</span>
                </a>
              </Button>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

export function BookmarkList({ model }) {
  return model.links.map((link) => (
    <BookmarkCard key={link.id} link={link} model={model} />
  ));
}

export function renderBookmarks(element, model) {
  renderRegion(element, <BookmarkList model={model} />);
}
