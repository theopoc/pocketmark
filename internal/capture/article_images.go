// Article illustrations have first claim on a small, bounded set of resource
// requests. Keep offsets into the original HTML instead of allocating a DOM.
package capture

import (
	"bytes"
	"cmp"
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"golang.org/x/net/html"
)

const maxArticleImages = 12

func hasDataImagePrefix(s string) bool {
	const prefix = "data:image/"
	return len(s) >= len(prefix) && strings.EqualFold(s[:len(prefix)], prefix)
}

type articleImage struct {
	start, end, rank int
	url, fallback    string
}

func attr(t html.Token, name string) string {
	for _, a := range t.Attr {
		if a.Key == name {
			return strings.TrimSpace(a.Val)
		}
	}
	return ""
}

func commentContainer(t html.Token) bool {
	switch t.Data {
	case "div", "section", "aside", "article", "form", "ol", "ul", "li", "footer", "main":
	default:
		return false
	}
	for _, field := range []string{"id", "class"} {
		for _, token := range strings.Fields(strings.ToLower(attr(t, field))) {
			switch token {
			case "comments", "comment-list", "commentlist", "comments-list", "comments-area", "comment-area", "comment-thread", "comment-section", "comments-section", "comment-respond", "comment-form", "wp-block-comments", "wp-block-post-comments", "disqus_thread", "giscus", "utterances":
				return true
			}
		}
	}
	switch strings.ToLower(attr(t, "aria-label")) {
	case "comments", "article comments", "commentaires":
		return true
	}
	if strings.EqualFold(attr(t, "itemprop"), "comment") {
		return true
	}
	for _, itemType := range strings.Fields(attr(t, "itemtype")) {
		if itemType == "https://schema.org/Comment" || itemType == "http://schema.org/Comment" {
			return true
		}
	}
	return false
}

// Track matching nested tags so closing an inner div cannot reopen a thread.
type tokenSubtree struct {
	tag   string
	depth int
}

func (c *tokenSubtree) start(t html.Token, matches func(html.Token) bool) bool {
	if c.depth == 0 && !matches(t) {
		return false
	}
	if c.depth == 0 {
		c.tag = t.Data
	}
	if t.Type == html.StartTagToken && t.Data == c.tag {
		c.depth++
	}
	return true
}

func (c *tokenSubtree) end(tag string) bool {
	if c.depth == 0 {
		return false
	}
	if tag == c.tag {
		c.depth--
	}
	return true
}

var embeddedImageCandidate = regexp.MustCompile(`(?i)(?:^|[\s,])(data:image/(?:png|jpeg|gif|webp|avif|svg\+xml)[;,][^\s]+)`)

func candidateFromSet(raw string) string {
	// Keep an already self-contained candidate, including the comma inside its URL.
	if m := embeddedImageCandidate.FindStringSubmatch(raw); m != nil {
		return strings.TrimSuffix(m[1], ",")
	}
	// Select external files for a 1280 CSS-pixel reading viewport at 1x.
	if len(raw) > 8192 {
		return ""
	}
	best, bestWidth := "", 0.0
	for entry := range strings.SplitSeq(raw, ",") {
		parts := strings.Fields(entry)
		if len(parts) == 0 || len(parts) > 2 {
			continue
		}
		width := 1280.0
		if len(parts) == 2 {
			desc := parts[1]
			if len(desc) < 2 {
				continue
			}
			n, err := strconv.ParseFloat(desc[:len(desc)-1], 64)
			if err != nil || !(n > 0 && n <= 100000) {
				continue
			}
			switch desc[len(desc)-1] {
			case 'w':
				width = n
			case 'x':
				width = n * 1280
			default:
				continue
			}
		}
		if best == "" || bestWidth < 1280 && width > bestWidth || width >= 1280 && width < bestWidth {
			best, bestWidth = parts[0], width
		}
	}
	return best
}

func pictureMatches(t html.Token) bool {
	if typ := attr(t, "type"); typ != "" {
		switch strings.ToLower(typ) {
		case "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif":
		default:
			return false
		}
	}
	media := strings.ToLower(strings.TrimSpace(attr(t, "media")))
	if media == "" || media == "screen" || media == "all" {
		return true
	}
	media = strings.TrimPrefix(media, "screen and ")
	// Unknown, compound, or device-specific queries defer to the fallback img.
	for _, feature := range []string{"min-width", "max-width"} {
		prefix := "(" + feature + ":"
		if strings.HasPrefix(media, prefix) && strings.HasSuffix(media, "px)") {
			n, err := strconv.Atoi(strings.TrimSpace(media[len(prefix) : len(media)-3]))
			return err == nil && n >= 0 && (feature == "min-width" && n <= 1280 || feature == "max-width" && n >= 1280)
		}
	}
	return false
}

func imageReference(t html.Token, picture string) (string, string) {
	src := attr(t, "src")
	for _, key := range []string{"data-src", "data-original", "data-lazy-src"} {
		if lazy := attr(t, key); lazy != "" {
			return lazy, src
		}
	}
	if picture != "" {
		return picture, src
	}
	for _, key := range []string{"data-srcset", "srcset"} {
		if candidate := candidateFromSet(attr(t, key)); candidate != "" {
			return candidate, src
		}
	}
	return src, ""
}

var backgroundProperty = regexp.MustCompile(`(?i)(?:^|;)\s*background(?:-image)?\s*:\s*(url\([^;]+?\))`)

func backgroundImage(t html.Token) string {
	switch t.Data {
	case "span", "div", "figure":
	default:
		return ""
	}
	if attr(t, "role") != "img" {
		return ""
	}
	match := backgroundProperty.FindStringSubmatch(attr(t, "style"))
	if match == nil {
		return ""
	}
	parts := cssURL.FindStringSubmatch(match[1])
	if parts == nil {
		return ""
	}
	return cmp.Or(parts[1], parts[2], strings.TrimSpace(parts[3]))
}

func imageReferences(body []byte, base *url.URL, backgrounds bool) ([]articleImage, *url.URL) {
	type scope struct {
		tag, picture string
		rank         int
		skip         bool
	}
	var stack []scope
	var images []articleImage
	firstBase := false
	hasArticle := false
	z := html.NewTokenizer(bytes.NewReader(body))
	z.SetMaxBuf(max(maxBody, len(body)))
	offset := 0
	for {
		kind := z.Next()
		start := offset
		offset += len(z.Raw())
		switch kind {
		case html.ErrorToken:
			if hasArticle {
				images = slices.DeleteFunc(images, func(img articleImage) bool { return img.rank < 2 })
			}
			slices.SortFunc(images, func(a, b articleImage) int { return a.start - b.start })
			return images, base
		case html.EndTagToken:
			name, _ := z.TagName()
			for i := len(stack) - 1; i >= 0; i-- {
				if stack[i].tag == string(name) {
					stack = stack[:i]
					break
				}
			}
		case html.StartTagToken, html.SelfClosingTagToken:
			t := z.Token()
			parent := scope{rank: 0}
			if len(stack) > 0 {
				parent = stack[len(stack)-1]
			}
			state := scope{tag: t.Data, rank: parent.rank, skip: parent.skip}
			if !parent.skip && t.Data == "base" && !firstBase && attr(t, "href") != "" {
				firstBase = true
				if resolved, err := base.Parse(attr(t, "href")); err == nil {
					base = resolved
				}
			}
			switch t.Data {
			case "nav", "footer", "script", "style", "iframe", "template", "noscript", "svg", "math", "object", "form":
				state.skip = true
			case "header":
				state.skip = state.skip || state.rank < 2
			case "article", "main":
				state.rank = 2
			case "figure":
				if state.rank >= 2 {
					state.rank = 3
				} else {
					state.rank = 1
				}
			}
			if attr(t, "role") == "main" || attr(t, "itemprop") == "articleBody" {
				state.rank = max(2, state.rank)
			}
			if attr(t, "role") == "navigation" || attr(t, "aria-hidden") == "true" || commentContainer(t) || slices.ContainsFunc(t.Attr, func(a html.Attribute) bool { return a.Key == "hidden" }) {
				state.skip = true
			}
			if !state.skip && (t.Data == "article" || t.Data == "main" || attr(t, "role") == "main" || attr(t, "itemprop") == "articleBody") {
				hasArticle = true
			}
			if !state.skip && t.Data == "source" && parent.tag == "picture" && parent.picture == "" && pictureMatches(t) {
				stack[len(stack)-1].picture = candidateFromSet(attr(t, "srcset"))
			}
			if !state.skip {
				var raw, fallback string
				if t.Data == "img" {
					raw, fallback = imageReference(t, parent.picture)
				} else if backgrounds {
					raw = backgroundImage(t)
				}
				remote := raw != "" && len(raw) <= 4096 && !strings.HasPrefix(strings.ToLower(raw), "data:")
				src := attr(t, "src")
				// An embedded thumbnail in src wins over lazy and picture candidates
				// in the panel. The offline serializer also removes all source tags.
				inline := t.Data == "img" && hasDataImagePrefix(raw) && raw != src &&
					(!backgrounds || hasDataImagePrefix(src) || attr(t, "data-lazy-src") == raw)
				if remote || inline {
					if len(fallback) > 4096 || fallback == raw {
						fallback = ""
					}
					img := articleImage{start: start, end: offset, rank: state.rank, url: raw, fallback: fallback}
					if len(images) < maxArticleImages {
						images = append(images, img)
					} else {
						lowest := 0
						for i := range images {
							if images[i].rank < images[lowest].rank || images[i].rank == images[lowest].rank && images[i].start > images[lowest].start {
								lowest = i
							}
						}
						if img.rank > images[lowest].rank {
							images[lowest] = img
						}
					}
				}
			}
			switch t.Data {
			case "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr":
			default:
				if kind == html.StartTagToken {
					if len(stack) >= 256 {
						return nil, base
					}
					stack = append(stack, state)
				}
			}
		}
	}
}

// Fetch only passive raster bytes. The HTTP client pins and checks every dial
// and redirect. Reject content mislabeled as an image before embedding it.
func (b *offlineBuilder) articleRaster(img articleImage, base *url.URL, limit int) ([]byte, string) {
	for _, raw := range []string{img.url, img.fallback} {
		if raw == "" || b.ctx.Err() != nil {
			continue
		}
		resolved, err := base.Parse(raw)
		if err != nil {
			continue
		}
		data, _, _, err := b.fetchLimit(resolved.String(), limit)
		if err != nil {
			continue
		}
		media := http.DetectContentType(data)
		switch media {
		case "image/png", "image/jpeg", "image/gif", "image/webp":
			return data, media
		}
		if len(data) >= 12 && string(data[4:8]) == "ftyp" && (string(data[8:12]) == "avif" || string(data[8:12]) == "avis") {
			return data, "image/avif"
		}
	}
	return nil, ""
}

// Keep all other markup verbatim in the automatic reading copy, including the
// source encoding and script text. Original downloads use Result.HTML.
func illustratedArticle(ctx context.Context, body []byte, base *url.URL, client *http.Client) []byte {
	if len(body) > maxBody {
		return nil
	}
	images, base := imageReferences(body, base, true)
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	b := offlineBuilder{ctx: ctx, client: client, remaining: maxBody}
	var out bytes.Buffer
	cursor, size := 0, len(body)
	for _, img := range images {
		if ctx.Err() != nil {
			break
		}
		z := html.NewTokenizer(bytes.NewReader(body[img.start:img.end]))
		z.Next()
		t := z.Token()
		if hasDataImagePrefix(img.url) {
			// Promote the already-saved candidate and drop redundant image
			// attributes. Token.String escapes the URL, including SVG markup.
			t.Type = html.StartTagToken
			t.Attr = slices.DeleteFunc(t.Attr, func(a html.Attribute) bool {
				switch a.Key {
				case "src", "srcset", "data-srcset", "data-lazy-src", "data-src", "data-original":
					return true
				}
				return false
			})
			t.Attr = append(t.Attr, html.Attribute{Key: "src", Val: img.url})
			tag := t.String()
			nextSize := size - (img.end - img.start) + len(tag)
			if nextSize <= maxBody {
				out.Write(body[cursor:img.start])
				out.WriteString(tag)
				cursor, size = img.end, nextSize
			}
			continue
		}
		available := maxBody - size
		if available < 64 {
			continue
		}
		data, media := b.articleRaster(img, base, (available-40)*3/4)
		if len(data) == 0 {
			continue
		}
		prefix := illustrationPrefix(t, media)
		nextSize := size - (img.end - img.start) + len(prefix) + base64.StdEncoding.EncodedLen(len(data)) + 2
		if nextSize > maxBody {
			continue
		}
		out.Write(body[cursor:img.start])
		out.WriteString(prefix)
		enc := base64.NewEncoder(base64.StdEncoding, &out)
		_, _ = enc.Write(data)
		_ = enc.Close()
		out.WriteString(`">`)
		cursor, size = img.end, nextSize
	}
	if cursor == 0 {
		return nil
	}
	out.Write(body[cursor:])
	return out.Bytes()
}

type savedRaster struct {
	offset int64
	size   int
	media  string
	inline string
}

func illustrationPrefix(t html.Token, media string) string {
	t.Type = html.StartTagToken
	target := "src"
	if t.Data != "img" {
		target = "data-src"
	}
	t.Attr = slices.DeleteFunc(t.Attr, func(a html.Attribute) bool { return a.Key == target || a.Key == "srcset" })
	return strings.TrimSuffix(t.String(), ">") + " " + target + `="data:` + media + ";base64,"
}

// Stage prioritized illustrations on disk. Other page assets can then use the
// remaining time and bytes while the archive is serialized in document order.
func (b *offlineBuilder) stageImages(body []byte, base *url.URL, dst io.Writer) (*os.File, map[int]savedRaster, *url.URL, error) {
	images, base := imageReferences(body, base, false)
	if len(images) == 0 {
		return nil, nil, base, nil
	}
	dir := ""
	if file, ok := dst.(*os.File); ok {
		dir = filepath.Dir(file.Name())
	}
	f, err := os.CreateTemp(dir, ".pocketmark-article-images-*")
	if err != nil {
		return nil, nil, base, err
	}
	// The open descriptor remains usable. Crashes and normal closes reclaim it.
	if err := os.Remove(f.Name()); err != nil {
		f.Close()
		return nil, nil, base, err
	}
	saved := make(map[int]savedRaster, len(images))
	var offset int64
	for _, img := range images {
		if hasDataImagePrefix(img.url) {
			saved[img.start] = savedRaster{inline: img.url}
			continue
		}
		data, media := b.articleRaster(img, base, maxBody)
		rec := savedRaster{}
		if len(data) > 0 {
			if _, err = f.Write(data); err != nil {
				f.Close()
				return nil, nil, base, err
			}
			rec = savedRaster{offset: offset, size: len(data), media: media}
			offset += int64(len(data))
			b.report.Embedded++
		} else {
			b.report.Omitted++
		}
		saved[img.start] = rec
	}
	return f, saved, base, nil
}
