package capture

import (
	"bytes"
	"context"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"golang.org/x/net/html"
)

// Thumbnails are optional, passive raster bytes. Never decode full pixels in Go.
const MaxThumbnail = 512 << 10

func thumbnail(ctx context.Context, body []byte, base *url.URL, client *http.Client) []byte {
	z := html.NewTokenizer(bytes.NewReader(body))
	z.SetMaxBuf(maxToken)
	var candidate, fallback string
	for z.Next() != html.ErrorToken {
		t := z.Token()
		if t.Data != "meta" {
			continue
		}
		var name, value string
		for _, a := range t.Attr {
			if a.Key == "property" || a.Key == "name" {
				name = strings.ToLower(a.Val)
			}
			if a.Key == "content" {
				value = strings.TrimSpace(a.Val)
			}
		}
		if len(value) > 4096 {
			continue
		}
		if name == "og:image" && candidate == "" {
			candidate = value
		}
		if name == "twitter:image" && fallback == "" {
			fallback = value
		}
	}
	if candidate == "" {
		candidate = fallback
	}
	if candidate == "" {
		return nil
	}
	u, err := base.Parse(candidate)
	if err != nil || validateURL(u) != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil
	}
	req.Header.Set("Accept", "image/jpeg, image/png")
	req.Header.Set("User-Agent", "Pocketmark/1.0 (+personal bookmark capture)")
	resp, err := client.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 || resp.ContentLength > MaxThumbnail {
		return nil
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, MaxThumbnail+1))
	if err != nil || !ValidThumbnail(data) {
		return nil
	}
	return data
}

func ValidThumbnail(data []byte) bool {
	if len(data) == 0 || len(data) > MaxThumbnail || bytes.Contains(data, []byte("acTL")) {
		return false
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	return err == nil && (format == "jpeg" || format == "png") && cfg.Width > 0 && cfg.Height > 0 && int64(cfg.Width)*int64(cfg.Height) <= 1_000_000
}
