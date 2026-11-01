package capture

import (
	"bytes"
	"context"
	"image"
	"image/png"
	"io"
	"net/http"
	"testing"
)

func TestSiteIconUsesSavedLinkAndRejectsUnsafeCandidates(t *testing.T) {
	var data bytes.Buffer
	if err := png.Encode(&data, image.NewRGBA(image.Rect(0, 0, 16, 16))); err != nil {
		t.Fatal(err)
	}
	var paths []string
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		paths = append(paths, r.URL.String())
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(data.Bytes())), Request: r}, nil
	})}
	got, kind := siteIcon(context.Background(), "https://example.com/page", []byte(`<link rel="shortcut icon" href="/assets/icon.png">`), client)
	if kind != "image/png" || !bytes.Equal(got, data.Bytes()) || len(paths) != 1 || paths[0] != "https://example.com/assets/icon.png" {
		t.Fatalf("%q %v", kind, paths)
	}
	paths = nil
	_, kind = siteIcon(context.Background(), "https://example.com/page", []byte(`<link rel="icon" href="http://127.0.0.1/secret">`), client)
	if kind != "image/png" || len(paths) != 1 || paths[0] != "https://example.com/favicon.ico" {
		t.Fatalf("unsafe candidate or missing fallback: %v", paths)
	}
	paths = nil
	siteIcon(context.Background(), "http://127.0.0.1/private", nil, client)
	if len(paths) != 0 {
		t.Fatal("private URL fetched")
	}
}

func TestSiteIconRejectsUntrustedOrOversizeBytes(t *testing.T) {
	for _, data := range [][]byte{[]byte(`<svg onload="alert(1)"/>`), []byte(`<html>bad</html>`), bytes.Repeat([]byte("a"), (128<<10)+1), {0, 0, 1, 0, 1, 0}} {
		if iconType(data) != "" {
			t.Fatalf("accepted invalid icon %q", data[:min(len(data), 24)])
		}
	}
}

func TestSiteIconTriesRasterAfterSVG(t *testing.T) {
	var pngData bytes.Buffer
	if err := png.Encode(&pngData, image.NewRGBA(image.Rect(0, 0, 16, 16))); err != nil {
		t.Fatal(err)
	}
	var paths []string
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		paths = append(paths, r.URL.Path)
		body := []byte(`<svg/>`)
		if r.URL.Path == "/icon.png" {
			body = pngData.Bytes()
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(body)), Request: r}, nil
	})}
	_, kind := siteIcon(context.Background(), "https://example.com/", []byte(`<link rel="icon" href="/icon.svg"><link rel="icon" href="/icon.png">`), client)
	if kind != "image/png" || len(paths) != 2 || paths[1] != "/icon.png" {
		t.Fatalf("kind=%s paths=%v", kind, paths)
	}
}
