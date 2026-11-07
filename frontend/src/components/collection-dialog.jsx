import { Button } from "./ui/button";
import { Input } from "./ui/input";

export function CollectionDialog() {
  return (
    <dialog
      id="collection-dialog"
      className="modal compact-modal"
      aria-labelledby="collection-dialog-title"
    >
      <form id="collection-form">
        <div className="dialog-heading">
          <h2 id="collection-dialog-title">{"New collection"}</h2>
          <Button
            type="button"
            className="icon-button close-dialog"
            aria-label="Close"
          >
            <span data-icon="close" aria-hidden="true"></span>
          </Button>
        </div>
        <label htmlFor="collection-name">{"Name"}</label>
        <Input
          id="collection-name"
          required
          placeholder="Collection name"
          aria-describedby="collection-name-hint"
        />
        <p
          id="collection-name-hint"
          className="field-hint"
          aria-live="polite"
        ></p>
        <label htmlFor="collection-parent">{"Parent collection"}</label>
        <select id="collection-parent"></select>
        <p id="collection-error" className="form-error" role="alert"></p>
        <div className="dialog-actions">
          <Button type="button" className="button subtle close-dialog">
            {"Cancel"}
          </Button>
          <Button type="submit" className="button primary" id="save-collection">
            {"Save collection"}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
