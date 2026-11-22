package store

// Metadata exports keep display values intact. The marker lists just the
// fields whose contents may also be used for AI tagging.
type aiPrivateFields struct {
	title, description bool
}

func (f aiPrivateFields) publicMarker() string {
	switch {
	case !f.title && !f.description:
		return "title description"
	case !f.title:
		return "title"
	case !f.description:
		return "description"
	default:
		return ""
	}
}

func privateAIFields(public string) aiPrivateFields {
	switch public {
	case "title description", "description title":
		return aiPrivateFields{}
	case "title":
		return aiPrivateFields{description: true}
	case "description":
		return aiPrivateFields{title: true}
	default:
		return aiPrivateFields{title: true, description: true}
	}
}
