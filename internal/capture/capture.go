// Package capture retrieves one public HTML document without a browser or subresources.
package capture

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"golang.org/x/net/html"
)

const (
	maxBody = 2 << 20
	maxText = 256 << 10
	// A page within maxBody may contain one large inline script or data
	// attribute. Keep tokenization bounded by the same document limit so
	// excluded script/style content does not prevent capturing the article.
	maxToken = maxBody
)

type Result struct {
	Title, Description, Content string
	HTML                        []byte
	Thumbnail                   []byte
}

// Fetch captures a single document. HTML is untrusted and must never be served
// inline on the application's origin; Content is plain text, not HTML.
func Fetch(ctx context.Context, rawURL string) (Result, error) {
	transport := &http.Transport{
		Proxy:                  nil,
		DialContext:            publicDial(net.DefaultResolver.LookupNetIP, (&net.Dialer{Timeout: 10 * time.Second}).DialContext),
		DisableCompression:     true,
		DisableKeepAlives:      true,
		MaxResponseHeaderBytes: 64 << 10,
		TLSHandshakeTimeout:    10 * time.Second,
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 20 * time.Second, CheckRedirect: checkRedirect}
	return fetch(ctx, rawURL, client)
}

func validateURL(u *url.URL) error {
	if u.Scheme != "http" && u.Scheme != "https" {
		return errors.New("capture requires an HTTP or HTTPS URL")
	}
	if u.User != nil || u.Hostname() == "" || strings.Contains(u.Hostname(), "%") {
		return errors.New("invalid capture host or credentials")
	}
	if ip, err := netip.ParseAddr(u.Hostname()); err == nil && !isPublic(ip) {
		return errors.New("capture destination is not public")
	}
	return nil
}

func checkRedirect(req *http.Request, via []*http.Request) error {
	if len(via) > 5 {
		return errors.New("capture exceeded five redirects")
	}
	return validateURL(req.URL)
}

type lookupFunc func(context.Context, string, string) ([]netip.Addr, error)
type dialFunc func(context.Context, string, string) (net.Conn, error)

func publicDial(lookup lookupFunc, dial dialFunc) dialFunc {
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		var ips []netip.Addr
		if ip, parseErr := netip.ParseAddr(host); parseErr == nil {
			ips = []netip.Addr{ip}
		} else {
			ips, err = lookup(ctx, "ip", host)
			if err != nil {
				return nil, fmt.Errorf("resolve capture host: %w", err)
			}
		}
		if len(ips) == 0 {
			return nil, errors.New("capture host has no addresses")
		}
		// Reject the entire answer if any destination is unsafe. Dial the checked
		// numeric address, never the hostname, to avoid DNS rebinding.
		for _, ip := range ips {
			if !isPublic(ip) {
				return nil, errors.New("capture destination is not public")
			}
		}
		for _, ip := range ips {
			conn, dialErr := dial(ctx, network, net.JoinHostPort(ip.String(), port))
			if dialErr == nil {
				return conn, nil
			}
			err = dialErr
		}
		return nil, err
	}
}

var blocked = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"), netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("169.254.0.0/16"), netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("192.88.99.0/24"), netip.MustParsePrefix("192.168.0.0/16"),
	netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"), netip.MustParsePrefix("224.0.0.0/3"),
	netip.MustParsePrefix("2001::/23"), netip.MustParsePrefix("2001:db8::/32"),
	netip.MustParsePrefix("2002::/16"), netip.MustParsePrefix("3fff::/20"),
}
var ipv6Global = netip.MustParsePrefix("2000::/3")

func isPublic(ip netip.Addr) bool {
	if !ip.IsValid() || ip.Zone() != "" || ip.Is4In6() || !ip.IsGlobalUnicast() || ip.IsPrivate() {
		return false
	}
	if ip.Is6() && !ipv6Global.Contains(ip) {
		return false
	}
	for _, prefix := range blocked {
		if prefix.Contains(ip) {
			return false
		}
	}
	return true
}

func fetch(ctx context.Context, rawURL string, client *http.Client) (Result, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return Result{}, err
	}
	if err = validateURL(u); err != nil {
		return Result{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return Result{}, err
	}
	req.Header.Set("User-Agent", "Pocketmark/1.0 (+personal bookmark capture)")
	req.Header.Set("Accept", "text/html, application/xhtml+xml")
	req.Header.Set("Accept-Encoding", "gzip")
	resp, err := client.Do(req)
	if err != nil {
		return Result{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return Result{}, fmt.Errorf("capture HTTP status %d", resp.StatusCode)
	}
	if resp.ContentLength > maxBody {
		return Result{}, errors.New("capture response exceeds 2 MiB")
	}
	body, err := readBounded(resp.Body)
	if err != nil {
		return Result{}, err
	}
	switch strings.ToLower(strings.TrimSpace(resp.Header.Get("Content-Encoding"))) {
	case "", "identity":
	case "gzip":
		reader, gzipErr := gzip.NewReader(bytes.NewReader(body))
		if gzipErr != nil {
			return Result{}, gzipErr
		}
		body, err = readBounded(reader)
		reader.Close()
		if err != nil {
			return Result{}, err
		}
	default:
		return Result{}, errors.New("unsupported capture content encoding")
	}
	contentType := resp.Header.Get("Content-Type")
	if contentType == "" {
		contentType = http.DetectContentType(body)
	}
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil || (mediaType != "text/html" && mediaType != "application/xhtml+xml") {
		return Result{}, errors.New("capture requires HTML content")
	}
	result, err := extract(body)
	if err != nil {
		return Result{}, err
	}
	result.HTML = body
	result.Thumbnail = thumbnail(ctx, body, resp.Request.URL, client)
	return result, nil
}

func readBounded(reader io.Reader) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(reader, maxBody+1))
	if err != nil {
		return nil, err
	}
	if len(body) > maxBody {
		return nil, errors.New("capture response exceeds 2 MiB")
	}
	return body, nil
}

var skipped = map[string]bool{"script": true, "style": true, "nav": true, "header": true, "footer": true, "svg": true, "noscript": true, "iframe": true, "template": true}

func extract(body []byte) (Result, error) {
	return extractReader(bytes.NewReader(body), maxToken)
}

// ExtractDocument indexes uploaded/client-rendered HTML without loading the
// complete archive. Large data-URL attributes remain bounded to 2 MiB each.
func ExtractDocument(src io.Reader) (Result, error) {
	return extractReader(io.LimitReader(src, 20<<20), 2<<20)
}

func extractReader(src io.Reader, tokenLimit int) (Result, error) {
	z := html.NewTokenizer(src)
	z.SetMaxBuf(tokenLimit)
	var result Result
	var content, title strings.Builder
	var excluded []string
	inHead, inTitle := false, false
	for {
		typeOf := z.Next()
		if typeOf == html.ErrorToken {
			if err := z.Err(); err != io.EOF {
				return Result{}, fmt.Errorf("parse capture HTML: %w", err)
			}
			break
		}
		switch typeOf {
		case html.StartTagToken, html.SelfClosingTagToken:
			token := z.Token()
			name := token.Data
			// Some real pages leave nested navigation elements unclosed. A
			// semantic content boundary can recover from layout exclusions,
			// but must not expose content inside templates or embedded assets.
			if name == "main" || name == "article" {
				layoutOnly := true
				for _, tag := range excluded {
					if tag != "nav" && tag != "header" && tag != "footer" {
						layoutOnly = false
						break
					}
				}
				if layoutOnly {
					excluded = nil
					inHead = false
				}
			}
			if skipped[name] && typeOf != html.SelfClosingTagToken {
				if len(excluded) >= 256 {
					return Result{}, errors.New("capture HTML nesting exceeds limit")
				}
				excluded = append(excluded, name)
			}
			if len(excluded) > 0 {
				continue
			}
			if name == "head" {
				inHead = true
			}
			if name == "body" {
				inHead = false
			}
			if name == "title" {
				inTitle = true
			}
			if name == "meta" && result.Description == "" {
				var kind, value string
				for _, attr := range token.Attr {
					if attr.Key == "name" || attr.Key == "property" {
						kind = strings.ToLower(attr.Val)
					}
					if attr.Key == "content" {
						value = attr.Val
					}
				}
				if kind == "description" || kind == "og:description" {
					var desc strings.Builder
					appendText(&desc, value, 4096)
					result.Description = desc.String()
				}
			}
		case html.EndTagToken:
			name, _ := z.TagName()
			tag := string(name)
			if len(excluded) > 0 {
				for i := len(excluded) - 1; i >= 0; i-- {
					if excluded[i] == tag {
						excluded = excluded[:i]
						break
					}
				}
				continue
			}
			if tag == "head" {
				inHead = false
			}
			if tag == "title" {
				inTitle = false
			}
		case html.TextToken:
			if len(excluded) > 0 {
				continue
			}
			if inTitle {
				appendText(&title, string(z.Text()), 1024)
			} else if !inHead {
				appendText(&content, string(z.Text()), maxText)
			}
		}
	}
	result.Title, result.Content = title.String(), content.String()
	return result, nil
}

func appendText(dst *strings.Builder, text string, limit int) {
	space := dst.Len() > 0
	for _, r := range text {
		if unicode.IsSpace(r) {
			space = dst.Len() > 0
			continue
		}
		size := utf8.RuneLen(r)
		if space {
			size++
		}
		if dst.Len()+size > limit {
			return
		}
		if space {
			dst.WriteByte(' ')
			space = false
		}
		dst.WriteRune(r)
	}
}
