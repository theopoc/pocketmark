package store

import "strconv"

// AI-public metadata is the part of a bookmark that AI tagging may send to the
// provider: a title or description the owner entered, and what basic capture
// found on the public page (including a 1 KiB excerpt). Notes, attachments,
// text uploaded from the owner's browser and URL parameters stay local, and a
// URL used as a fallback title is omitted.
//
// Each write of a bookmark's title or description goes through a
// metadataWrite, which updates the ai_private_title, ai_private_description
// and ai_public_excerpt columns in the same statement. The
// invalidate_ai_tag_input trigger additionally keeps empty and URL fallback
// values private for replicas that predate these columns.

// metadataSource is where a bookmark's title and description came from. The
// zero value is metadata of unknown origin, which stays private.
type metadataSource struct {
	kind sourceKind
	// private lists the fields a markedReplica's pocketmark-ai-public marker
	// keeps private.
	private aiPrivateFields
}

type sourceKind uint8

const (
	// unknownSource is a sync record or Pocketmark export without a marker,
	// for example one written by an older replica.
	unknownSource sourceKind = iota
	// ownerEntered metadata was typed by the owner, in Pocketmark or in
	// another bookmark manager whose export is imported.
	ownerEntered
	// basicCapture fills missing metadata from the public page.
	basicCapture
	// browserUpload fills missing metadata from HTML saved by the owner's
	// browser, which may show signed-in content.
	browserUpload
	// markedReplica is a metadata export or sync record whose marker states
	// which fields are AI-public.
	markedReplica
)

var (
	sourceOwner   = metadataSource{kind: ownerEntered}
	sourceCapture = metadataSource{kind: basicCapture}
	sourceUpload  = metadataSource{kind: browserUpload}
)

// markedSource reads a pocketmark-ai-public marker from a metadata export.
func markedSource(public string) metadataSource {
	return metadataSource{kind: markedReplica, private: privateAIFields(public)}
}

// insertPrivacy is the flag pair for a new bookmark from this source.
func (s metadataSource) insertPrivacy() aiPrivateFields {
	switch s.kind {
	case ownerEntered:
		return aiPrivateFields{}
	case markedReplica:
		return s.private
	default:
		return aiPrivateFields{title: true, description: true}
	}
}

// metadataWrite changes an existing bookmark's title and description from one
// source.
type metadataWrite struct {
	source             metadataSource
	title, description string
	// excerpt is the placeholder of basic capture's extracted text, which the
	// caller also stores as content. Its first 1024 characters become the
	// public excerpt.
	excerpt string
	// keepDescription leaves the description and its flag untouched, for a
	// sync record without a desc element.
	keepDescription bool
}

// assignments returns the SET list items for title, description and their AI
// privacy columns, appending its parameters to args. PostgreSQL evaluates every
// item against the row as it was before the update.
func (w metadataWrite) assignments(args *sqlArgs) string {
	switch w.source.kind {
	case ownerEntered:
		// The owner vouches for what they change. A value left as it was keeps
		// its provenance.
		t, d := args.add(w.title), args.add(w.description)
		return "ai_private_title=ai_private_title AND title=" + t +
			",ai_private_description=ai_private_description AND description=" + d +
			",title=" + t + ",description=" + d
	case basicCapture, browserUpload:
		// Fill only a URL fallback title and an empty description; personal
		// metadata is never overwritten.
		t, d := args.add(w.title), args.add(w.description)
		fillTitle := "title=url AND " + t + "<>''"
		var flags string
		if w.source.kind == basicCapture {
			flags = "ai_public_excerpt=left(" + w.excerpt + ",1024)" +
				",ai_private_title=ai_private_title AND NOT(" + fillTitle + ")" +
				",ai_private_description=ai_private_description AND description<>''"
		} else {
			flags = "ai_private_title=ai_private_title OR (" + fillTitle + ")" +
				",ai_private_description=ai_private_description OR (description='' AND " + d + "<>'')"
		}
		return flags +
			",title=CASE WHEN " + fillTitle + " THEN " + t + " ELSE title END" +
			",description=CASE WHEN description='' THEN " + d + " ELSE description END"
	default:
		// A replica's unchanged value keeps its provenance, restricted further
		// by its marker. A changed value takes the marker's word, or stays
		// private without one.
		private := w.source.insertPrivacy()
		t := args.add(w.title)
		marked := args.add(w.source.kind == markedReplica)
		p := args.add(private.title)
		set := "ai_private_title=CASE WHEN title=" + t + " THEN ai_private_title OR (" + p + " AND " + marked + ") ELSE " + p + " END,title=" + t
		if !w.keepDescription {
			d, p := args.add(w.description), args.add(private.description)
			set += ",ai_private_description=CASE WHEN description=" + d + " THEN ai_private_description OR (" + p + " AND " + marked + ") ELSE " + p + " END,description=" + d
		}
		return set
	}
}

// sqlArgs numbers the positional parameters of a statement built from parts.
type sqlArgs []any

func (a *sqlArgs) add(v any) string {
	*a = append(*a, v)
	return "$" + strconv.Itoa(len(*a))
}

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
