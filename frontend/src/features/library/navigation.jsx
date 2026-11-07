import { Fragment } from "react";
import { Button } from "../../components/ui/button";
import { Icon } from "../../components/icon";
import { renderRegion } from "../../lib/render";

export function renderBreadcrumbs(element, crumbs, disabled) {
  renderRegion(
    element,
    crumbs.map((crumb, index) => (
      <Fragment key={crumb.key}>
        {index > 0 && <Icon name="chevron-right" />}
        <Button
          type="button"
          className={index === 0 ? "breadcrumb-root" : ""}
          data-focus-key={crumb.key}
          id={index === crumbs.length - 1 ? "breadcrumb-current" : undefined}
          aria-current={index === crumbs.length - 1 ? "page" : undefined}
          disabled={disabled}
          onClick={crumb.action}
        >
          {crumb.label}
        </Button>
      </Fragment>
    )),
  );
}

export function renderFilter(element, query, onClear) {
  renderRegion(
    element,
    query ? (
      <Button
        className="filter-chip"
        data-focus-key={`filter:Search: ${query}`}
        aria-label={`Remove Search: ${query} filter`}
        onClick={onClear}
      >
        Search: {query}
        <Icon name="close" />
      </Button>
    ) : null,
  );
}

export function renderCollectionNavigation(
  element,
  { collections, activeID, parentLabel, onSelect, onEdit, onDelete },
) {
  renderRegion(
    element,
    collections.length ? (
      collections.map((collection) => (
        <div
          key={collection.id}
          className="collection-row"
          style={{ marginLeft: `${Math.min(collection.depth, 5) * 9}px` }}
        >
          <Button
            className={`nav-item${String(activeID) === String(collection.id) ? " active" : ""}`}
            data-focus-key={`collection:${collection.id}`}
            aria-current={
              String(activeID) === String(collection.id) ? "page" : undefined
            }
            title={
              collection.parentId != null
                ? `Inside ${parentLabel(collection.parentId)}`
                : undefined
            }
            onClick={() => onSelect(collection)}
          >
            <Icon name="folder" />
            <span className="collection-name">{collection.name}</span>
          </Button>
          <Button
            className="icon-button delete-collection"
            data-focus-key={`edit-collection:${collection.id}`}
            data-keep-navigation=""
            title={`Rename or move ${collection.name}`}
            aria-label={`Rename or move ${collection.name}`}
            onClick={() => onEdit(collection)}
          >
            <Icon name="edit" />
          </Button>
          <Button
            className="icon-button delete-collection"
            data-focus-key={`delete-collection:${collection.id}`}
            data-keep-navigation=""
            title={`Delete ${collection.name}`}
            aria-label={`Delete ${collection.name}`}
            onClick={(event) => onDelete(collection, event.currentTarget)}
          >
            <Icon name="trash" />
          </Button>
        </div>
      ))
    ) : (
      <p className="small muted">No collections yet.</p>
    ),
  );
}

export function renderFrequentTags(element, tags, activeTag, onSelect) {
  renderRegion(
    element,
    tags.slice(0, 12).map((tag) => (
      <Button
        key={tag.name}
        className={`tag-button${activeTag === tag.name ? " active" : ""}`}
        data-focus-key={`tag:${tag.name}`}
        aria-pressed={activeTag === tag.name}
        title={`${tag.count} bookmark${tag.count === 1 ? "" : "s"}`}
        onClick={() => onSelect(tag.name)}
      >
        #{tag.name}
      </Button>
    )),
  );
}
