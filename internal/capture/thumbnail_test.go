package capture

import (
	"bytes"
	"context"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/url"
	"testing"
)

func TestThumbnailPublicImageAndBounds(t *testing.T) {
	var b bytes.Buffer
	png.Encode(&b, image.NewRGBA(image.Rect(0, 0, 20, 10)))
	base, _ := url.Parse("https://example.com/articles/page")
	calls := 0
	client := &http.Client{CheckRedirect: checkRedirect, Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.String() != "https://example.com/preview.png" {
			t.Fatal(r.URL)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(b.Bytes())), Request: r}, nil
	})}
	got := thumbnail(context.Background(), []byte(`<meta property="og:image" content="/preview.png">`), base, client)
	if !bytes.Equal(got, b.Bytes()) || calls != 1 {
		t.Fatal("missing thumbnail")
	}
	for _, raw := range []string{"http://127.0.0.1/image", "file:///etc/passwd", "http://user:pass@example.com/image"} {
		if got := thumbnail(context.Background(), []byte(`<meta property="og:image" content="`+raw+`">`), base, client); len(got) != 0 {
			t.Fatal("unsafe image accepted")
		}
	}
	if calls != 1 {
		t.Fatal("unsafe request made")
	}
	b.Reset()
	png.Encode(&b, image.NewRGBA(image.Rect(0, 0, 1001, 1000)))
	if ValidThumbnail(b.Bytes()) || ValidThumbnail(bytes.Repeat([]byte("a"), MaxThumbnail+1)) || ValidThumbnail([]byte(`<svg/>`)) {
		t.Fatal("image limits bypassed")
	}
}
