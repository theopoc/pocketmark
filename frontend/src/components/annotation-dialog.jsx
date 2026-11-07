import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

export function AnnotationDialog() {
  return (
    <dialog
      id="annotation-dialog"
      className="modal compact-modal"
      aria-labelledby="annotation-title"
    >
      <form id="annotation-form">
        <div className="dialog-heading">
          <h2 id="annotation-title">{"Annotation"}</h2>
          <Button
            type="button"
            className="icon-button close-dialog"
            aria-label="Close"
          >
            <span data-icon="close" aria-hidden="true"></span>
          </Button>
        </div>
        <p id="annotation-draft-notice" className="draft-notice" hidden>
          {"Unsaved annotation restored from this tab."}
        </p>
        <blockquote id="annotation-quote"></blockquote>
        <label htmlFor="annotation-note">{"Note"}</label>
        <Textarea id="annotation-note" rows="3"></Textarea>
        <label htmlFor="annotation-color">{"Highlight color"}</label>
        <select id="annotation-color">
          <option value="yellow">{"Yellow"}</option>
          <option value="green">{"Green"}</option>
          <option value="blue">{"Blue"}</option>
          <option value="pink">{"Pink"}</option>
        </select>
        <p id="annotation-error" className="form-error" role="alert"></p>
        <div className="dialog-actions">
          <Button type="button" className="button subtle close-dialog">
            {"Cancel"}
          </Button>
          <Button className="button primary" type="submit">
            {"Save annotation"}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
