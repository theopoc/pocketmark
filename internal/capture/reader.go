package capture

import (
	"errors"
	"io"
	"net/url"
	"strings"

	"golang.org/x/net/html"
)

var readerTags = map[string]bool{"p": true, "div": true, "h1": true, "h2": true, "h3": true, "h4": true, "h5": true, "h6": true, "ul": true, "ol": true, "li": true, "blockquote": true, "pre": true, "code": true, "strong": true, "em": true, "b": true, "i": true, "del": true, "br": true, "hr": true, "table": true, "thead": true, "tbody": true, "tr": true, "th": true, "td": true, "a": true, "figure": true, "figcaption": true, "article": true, "section": true, "main": true}

// Reader renders a structural, passive article. It deliberately omits all remote
// resources, styles, forms and active elements; links get absolute safe URLs.
func Reader(src io.Reader, dst io.Writer, rawURL string) error {
	base, _ := url.Parse(rawURL)
	z := html.NewTokenizer(io.LimitReader(src, 2<<20))
	z.SetMaxBuf(2 << 20)
	w := &limitedWriter{dst: dst, remaining: 1 << 20}
	if _, err := io.WriteString(w, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Reader</title><style>body{max-width:72ch;margin:2rem auto;padding:0 1rem;font:18px/1.7 system-ui;color:#233d32;background:#fafcf9}a{color:#176c46}pre{white-space:pre-wrap;background:#eff3ed;padding:1rem}table{border-collapse:collapse}td,th{border:1px solid #ccd7ca;padding:.4rem}blockquote{border-left:3px solid #6a9b70;padding-left:1rem}h1,h2,h3{line-height:1.3}</style></head><body>`); err != nil {
		return err
	}
	var excluded []string
	for {
		kind := z.Next()
		if kind == html.ErrorToken {
			if z.Err() != io.EOF {
				return z.Err()
			}
			break
		}
		t := z.Token()
		if kind == html.StartTagToken || kind == html.SelfClosingTagToken {
			if t.Data == "main" || t.Data == "article" {
				layout := true
				for _, n := range excluded {
					if n != "nav" && n != "header" && n != "footer" && n != "head" {
						layout = false
					}
				}
				if layout {
					excluded = nil
				}
			}
			if skipped[t.Data] || t.Data == "head" || t.Data == "object" || t.Data == "form" || t.Data == "button" || t.Data == "select" || t.Data == "textarea" {
				if kind != html.SelfClosingTagToken {
					if len(excluded) > 256 {
						return errors.New("reader nesting limit")
					}
					excluded = append(excluded, t.Data)
				}
				continue
			}
			if len(excluded) > 0 || !readerTags[t.Data] {
				continue
			}
			attrs := []html.Attribute{}
			if t.Data == "a" {
				for _, a := range t.Attr {
					if a.Key == "href" {
						if u, e := url.Parse(a.Val); e == nil {
							if base != nil {
								u = base.ResolveReference(u)
							}
							if u.Scheme == "http" || u.Scheme == "https" {
								attrs = append(attrs, html.Attribute{Key: "href", Val: u.String()}, html.Attribute{Key: "rel", Val: "noreferrer noopener"}, html.Attribute{Key: "target", Val: "_blank"})
							}
						}
					}
				}
			}
			t.Attr = attrs
			if _, e := io.WriteString(w, t.String()); e != nil {
				return e
			}
		} else if kind == html.EndTagToken {
			if len(excluded) > 0 {
				for i := len(excluded) - 1; i >= 0; i-- {
					if excluded[i] == t.Data {
						excluded = excluded[:i]
						break
					}
				}
				continue
			}
			if readerTags[t.Data] {
				if _, e := io.WriteString(w, t.String()); e != nil {
					return e
				}
			}
		} else if kind == html.TextToken && len(excluded) == 0 {
			if _, e := io.WriteString(w, html.EscapeString(t.Data)); e != nil {
				return e
			}
		}
	}
	_, err := io.WriteString(w, "</body></html>")
	return err
}

type limitedWriter struct {
	dst       io.Writer
	remaining int64
}

func (w *limitedWriter) Write(p []byte) (int, error) {
	if int64(len(p)) > w.remaining {
		return 0, errors.New("archive output exceeds limit")
	}
	n, err := w.dst.Write(p)
	w.remaining -= int64(n)
	return n, err
}

// ExtractText is useful for client-produced SingleFile archives as well as HTTP captures.
func ExtractText(body []byte) (string, error) {
	r, e := extract(body)
	return strings.TrimSpace(r.Content), e
}
