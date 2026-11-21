package capture

import (
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/net/html"
)

// With no publisher description, use the first prose paragraph in a main or
// article landmark. An unmarked page can supply a paragraph outside its menus.
// A later semantic landmark takes precedence over that provisional paragraph.
type paragraphSummary struct {
	body, ignored  tokenSubtree
	rank, bestRank int
	space          bool
	text           strings.Builder
}

func summaryNoise(t html.Token) bool {
	switch t.Data {
	case "p", "div", "section", "span", "form", "aside", "main", "article":
		for class := range strings.FieldsSeq(attr(t, "class")) {
			switch class {
			case "byline", "author", "post-meta", "entry-meta", "breadcrumbs", "related-posts", "print-only":
				return true
			}
		}
		role := attr(t, "role")
		return t.Data == "form" || role == "navigation" || role == "banner" ||
			attr(t, "aria-hidden") == "true" || attr(t, "itemprop") == "author" ||
			slices.ContainsFunc(t.Attr, func(a html.Attribute) bool { return a.Key == "hidden" })
	}
	return false
}

func summaryLandmark(t html.Token) bool {
	return t.Data == "main" || t.Data == "article" ||
		((t.Data == "div" || t.Data == "section") && (attr(t, "role") == "main" || attr(t, "itemprop") == "articleBody"))
}

func (p *paragraphSummary) start(t html.Token) {
	if (p.bestRank == 2 && p.rank == 0) || p.ignored.start(t, summaryNoise) {
		return
	}
	inArticle := p.body.start(t, summaryLandmark)
	switch t.Data {
	case "p":
		p.rank = 1
		if inArticle {
			p.rank = 2
		}
		if p.rank <= p.bestRank || t.Type != html.StartTagToken {
			p.rank = 0
		}
	case "br":
		p.space = true
	}
}

func (p *paragraphSummary) end(tag string) {
	if p.ignored.end(tag) {
		return
	}
	p.body.end(tag)
	if tag == "p" || tag == "main" || tag == "article" {
		p.rank = 0
	}
}

func (p *paragraphSummary) append(text string) {
	if p.rank == 0 || p.ignored.depth > 0 {
		return
	}
	for _, r := range text {
		if unicode.IsSpace(r) {
			p.space = true
			continue
		}
		if p.rank > p.bestRank {
			p.text.Reset()
			p.space = false
			p.bestRank = p.rank
		}
		size := utf8.RuneLen(r)
		if p.space {
			size++
		}
		if p.text.Len()+size > 320 {
			p.text.WriteRune('…')
			p.rank = 0
			return
		}
		if p.space {
			p.text.WriteByte(' ')
			p.space = false
		}
		p.text.WriteRune(r)
	}
}
