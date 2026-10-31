package capture

import (
	"io"
	"strings"

	"golang.org/x/net/html"
)

// Preview keeps the saved layout, including inline styles and embedded resources.
// The caller MUST render it in the nested sandboxed blob viewer whose parent CSP
// restricts frame-src to blob:. This lexical filter is defense in depth, not an
// HTML5 sanitizer: browser parsing contexts can expose unfiltered navigation.
// Tokenization is bounded by the attachment limit; no document tree is built.
func Preview(src io.Reader, dst io.Writer) error {
	z := html.NewTokenizer(io.LimitReader(src, 20<<20))
	z.SetMaxBuf(20 << 20)
	w := &limitedWriter{dst: dst, remaining: 40 << 20}
	for {
		kind := z.Next()
		if kind == html.ErrorToken {
			if z.Err() == io.EOF {
				return nil
			}
			return z.Err()
		}
		raw := string(z.Raw()) // Token unescapes attributes in the tokenizer buffer.
		if kind == html.StartTagToken || kind == html.SelfClosingTagToken {
			t := z.Token()
			if t.Data == "base" || t.Data == "animate" || t.Data == "set" || t.Data == "animatemotion" || t.Data == "animatetransform" {
				continue
			}
			if t.Data == "meta" {
				refresh := false
				for _, a := range t.Attr {
					if a.Key == "http-equiv" && strings.EqualFold(strings.TrimSpace(a.Val), "refresh") {
						refresh = true
					}
				}
				if refresh {
					continue
				}
			}
			if t.Data == "a" || t.Data == "area" {
				attrs := t.Attr[:0]
				for _, a := range t.Attr {
					if a.Key == "target" || a.Key == "ping" || a.Key == "download" ||
						((a.Key == "href" || a.Key == "xlink:href") && !strings.HasPrefix(strings.TrimSpace(a.Val), "#")) {
						continue
					}
					attrs = append(attrs, a)
				}
				t.Attr = attrs
				if _, err := io.WriteString(w, t.String()); err != nil {
					return err
				}
				continue
			}
		}
		if _, err := io.WriteString(w, raw); err != nil {
			return err
		}
	}
}
