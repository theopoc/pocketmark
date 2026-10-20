package capture

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"golang.org/x/net/html"
)

type OfflineReport struct {
	Embedded int `json:"embedded"`
	Omitted  int `json:"omitted"`
}

// Offline writes a passive self-contained snapshot. Network access has the same
// DNS pinning as basic captures. Assets are fetched sequentially, never retained
// in a cache. CSS imports are omitted rather than recursively crawling a site.
func Offline(ctx context.Context, rawURL string, dst io.Writer) (OfflineReport, error) {
	transport := &http.Transport{Proxy: nil, DialContext: publicDial(net.DefaultResolver.LookupNetIP, (&net.Dialer{Timeout: 5 * time.Second}).DialContext), DisableKeepAlives: true, MaxResponseHeaderBytes: 64 << 10, TLSHandshakeTimeout: 5 * time.Second}
	defer transport.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	return offline(ctx, rawURL, dst, &http.Client{Transport: transport, Timeout: 10 * time.Second, CheckRedirect: checkRedirect})
}

type offlineBuilder struct {
	ctx       context.Context
	client    *http.Client
	report    OfflineReport
	requests  int
	remaining int
}

func (b *offlineBuilder) fetch(raw string) ([]byte, string, *url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, "", nil, err
	}
	if err = validateURL(u); err != nil {
		return nil, "", nil, err
	}
	if b.requests >= 25 || b.remaining <= 0 {
		return nil, "", nil, errors.New("archive resource budget exhausted")
	}
	b.requests++
	req, err := http.NewRequestWithContext(b.ctx, "GET", u.String(), nil)
	if err != nil {
		return nil, "", nil, err
	}
	req.Header.Set("User-Agent", "Pocketmark/1.0 (offline archive)")
	resp, err := b.client.Do(req)
	if err != nil {
		return nil, "", nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, "", nil, fmt.Errorf("resource HTTP %d", resp.StatusCode)
	}
	limit := maxBody
	if b.remaining < limit {
		limit = b.remaining
	}
	rawBody, err := io.ReadAll(io.LimitReader(resp.Body, int64(limit+1)))
	if err != nil {
		return nil, "", nil, err
	}
	if len(rawBody) > limit {
		return nil, "", nil, errors.New("resource exceeds capture budget")
	}
	b.remaining -= len(rawBody)
	media, _, _ := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if media == "" {
		media = http.DetectContentType(rawBody)
	}
	return rawBody, media, resp.Request.URL, nil
}

func (b *offlineBuilder) resource(raw string, base *url.URL) string {
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(raw)), "data:") {
		return raw
	}
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		b.report.Omitted++
		return ""
	}
	u = base.ResolveReference(u)
	body, media, _, err := b.fetch(u.String())
	if err != nil {
		b.report.Omitted++
		return ""
	}
	// SVG can reference external content, fonts, scripts, or recursive data URLs;
	// omit it. Raster images and font bytes are passive in this CSP-restricted page.
	switch media {
	case "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/x-icon", "image/vnd.microsoft.icon", "font/woff", "font/woff2", "font/ttf", "font/otf", "application/font-woff", "application/vnd.ms-fontobject":
	default:
		b.report.Omitted++
		return ""
	}
	b.report.Embedded++
	return "data:" + media + ";base64," + base64.StdEncoding.EncodeToString(body)
}

var cssURL = regexp.MustCompile(`(?i)url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)`)
var cssImport = regexp.MustCompile(`(?is)@import\s+[^;{}]+;?`)

func (b *offlineBuilder) css(text string, base *url.URL) string {
	text = cssImport.ReplaceAllString(text, "")
	text = cssURL.ReplaceAllStringFunc(text, func(match string) string {
		p := cssURL.FindStringSubmatch(match)
		raw := p[1]
		if raw == "" {
			raw = p[2]
		}
		if raw == "" {
			raw = p[3]
		}
		data := b.resource(raw, base)
		return `url("` + strings.ReplaceAll(data, `"`, "%22") + `")`
	})
	// Prevent raw-text HTML parser breakout when serializing a <style> element.
	return strings.ReplaceAll(text, "<", `\3c `)
}

func offline(ctx context.Context, rawURL string, dst io.Writer, client *http.Client) (OfflineReport, error) {
	b := &offlineBuilder{ctx: ctx, client: client, remaining: 12 << 20}
	body, media, base, err := b.fetch(rawURL)
	if err != nil {
		return b.report, err
	}
	if media != "text/html" && media != "application/xhtml+xml" {
		return b.report, errors.New("offline capture requires HTML")
	}
	w := &limitedWriter{dst: dst, remaining: 20 << 20}
	_, err = io.WriteString(w, `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"><!-- Pocketmark passive offline snapshot: scripts, forms, frames and CSS imports omitted. -->`)
	if err != nil {
		return b.report, err
	}
	z := html.NewTokenizer(bytes.NewReader(body))
	z.SetMaxBuf(maxBody)
	var excluded []string
	style := false
	for {
		kind := z.Next()
		if kind == html.ErrorToken {
			if z.Err() != io.EOF {
				return b.report, z.Err()
			}
			break
		}
		t := z.Token()
		switch kind {
		case html.StartTagToken, html.SelfClosingTagToken:
			if t.Data == "script" || t.Data == "iframe" || t.Data == "object" || t.Data == "embed" || t.Data == "template" || t.Data == "noscript" || t.Data == "svg" || t.Data == "audio" || t.Data == "video" {
				if kind != html.SelfClosingTagToken && t.Data != "embed" {
					if len(excluded) > 256 {
						return b.report, errors.New("archive nesting limit")
					}
					excluded = append(excluded, t.Data)
				}
				continue
			}
			if len(excluded) > 0 {
				continue
			}
			if t.Data == "base" || t.Data == "meta" || t.Data == "source" {
				continue
			}
			if t.Data == "link" {
				href, rel := "", ""
				for _, a := range t.Attr {
					if a.Key == "href" {
						href = a.Val
					}
					if a.Key == "rel" {
						rel = a.Val
					}
				}
				if strings.EqualFold(rel, "stylesheet") && href != "" {
					u, e := url.Parse(href)
					if e == nil {
						u = base.ResolveReference(u)
						css, typ, cssBase, e := b.fetch(u.String())
						if e == nil && typ == "text/css" {
							b.report.Embedded++
							_, err = io.WriteString(w, "<style>"+b.css(string(css), cssBase)+"</style>")
							if err != nil {
								return b.report, err
							}
						} else {
							b.report.Omitted++
						}
					}
				}
				continue
			}
			attrs := []html.Attribute{}
			for _, a := range t.Attr {
				if a.Namespace != "" || strings.HasPrefix(a.Key, "on") || a.Key == "srcdoc" || a.Key == "srcset" || a.Key == "action" || a.Key == "formaction" || a.Key == "ping" || a.Key == "background" || a.Key == "nonce" || a.Key == "integrity" || a.Key == "crossorigin" {
					continue
				}
				switch a.Key {
				case "src", "poster":
					if t.Data != "img" {
						continue
					}
					a.Val = b.resource(a.Val, base)
				case "style":
					a.Val = b.css(a.Val, base)
				case "href":
					u, e := url.Parse(a.Val)
					if e != nil {
						continue
					}
					u = base.ResolveReference(u)
					if u.Scheme != "http" && u.Scheme != "https" {
						continue
					}
					a.Val = u.String()
				}
				attrs = append(attrs, a)
			}
			t.Attr = attrs
			if t.Data == "style" {
				style = true
			}
			_, err = io.WriteString(w, t.String())
		case html.EndTagToken:
			if len(excluded) > 0 {
				for i := len(excluded) - 1; i >= 0; i-- {
					if excluded[i] == t.Data {
						excluded = excluded[:i]
						break
					}
				}
				continue
			}
			if t.Data == "style" {
				style = false
			}
			_, err = io.WriteString(w, t.String())
		case html.TextToken:
			if len(excluded) > 0 {
				continue
			}
			if style {
				_, err = io.WriteString(w, b.css(t.Data, base))
			} else {
				_, err = io.WriteString(w, html.EscapeString(t.Data))
			}
		}
		if err != nil {
			return b.report, err
		}
	}
	return b.report, nil
}
