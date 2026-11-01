package capture

import (
	"bytes"
	"context"
	"encoding/binary"
	"image"
	_ "image/gif"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"golang.org/x/net/html"
)

// SiteIcon fetches an optional small raster icon using the same public-address
// and redirect restrictions as page capture. The saved HTML is never executed.
func SiteIcon(ctx context.Context, rawURL string, archive []byte) ([]byte, string) {
	transport := &http.Transport{Proxy: nil, DialContext: publicDial(net.DefaultResolver.LookupNetIP, (&net.Dialer{Timeout: 5 * time.Second}).DialContext), DisableCompression: true, DisableKeepAlives: true, MaxResponseHeaderBytes: 64 << 10, TLSHandshakeTimeout: 5 * time.Second}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 5 * time.Second, CheckRedirect: checkRedirect}
	return siteIcon(ctx, rawURL, archive, client)
}

func siteIcon(ctx context.Context, rawURL string, archive []byte, client *http.Client) ([]byte, string) {
	base, err := url.Parse(rawURL)
	if err != nil || validateURL(base) != nil {
		return nil, ""
	}
	root := &url.URL{Scheme: base.Scheme, Host: base.Host, Path: "/favicon.ico"}
	candidates := []*url.URL{}
	z := html.NewTokenizer(bytes.NewReader(archive))
	z.SetMaxBuf(maxToken)
	for z.Next() != html.ErrorToken {
		t := z.Token()
		if t.Data != "link" {
			continue
		}
		var rel, href string
		for _, a := range t.Attr {
			if a.Key == "rel" {
				rel = strings.ToLower(a.Val)
			}
			if a.Key == "href" {
				href = strings.TrimSpace(a.Val)
			}
		}
		for _, part := range strings.Fields(rel) {
			if part == "icon" && len(href) <= 4096 {
				if u, e := base.Parse(href); e == nil && validateURL(u) == nil {
					candidates = append(candidates, u)
				}
				break
			}
		}
		if len(candidates) >= 4 {
			break
		}
	}
	candidates = append(candidates, root)
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	for _, u := range candidates {
		req, e := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
		if e != nil {
			continue
		}
		req.Header.Set("Accept", "image/png, image/jpeg, image/gif, image/x-icon")
		req.Header.Set("User-Agent", "Pocketmark/1.0 (+personal bookmark capture)")
		resp, e := client.Do(req)
		if e != nil {
			continue
		}
		if resp.StatusCode != http.StatusOK || resp.ContentLength > 128<<10 {
			resp.Body.Close()
			continue
		}
		data, e := io.ReadAll(io.LimitReader(resp.Body, (128<<10)+1))
		resp.Body.Close()
		if e == nil {
			if kind := iconType(data); kind != "" {
				return data, kind
			}
		}
	}
	return nil, ""
}

// Accept only bounded passive raster formats, never SVG or HTML.
func iconType(data []byte) string {
	if len(data) == 0 || len(data) > 128<<10 || bytes.Contains(data, []byte("acTL")) {
		return ""
	}
	if len(data) >= 22 && data[0] == 0 && data[1] == 0 && data[2] == 1 && data[3] == 0 {
		count := int(binary.LittleEndian.Uint16(data[4:6]))
		if count < 1 || count > 64 || 6+16*count > len(data) {
			return ""
		}
		for i := 0; i < count; i++ {
			entry := data[6+16*i:]
			size, offset := uint64(binary.LittleEndian.Uint32(entry[8:12])), uint64(binary.LittleEndian.Uint32(entry[12:16]))
			if size == 0 || offset < uint64(6+16*count) || offset+size > uint64(len(data)) {
				return ""
			}
		}
		return "image/x-icon"
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 || int64(cfg.Width)*int64(cfg.Height) > 1_000_000 {
		return ""
	}
	switch format {
	case "png":
		return "image/png"
	case "jpeg":
		return "image/jpeg"
	case "gif":
		return "image/gif"
	}
	return ""
}
