package capture

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestOfflineEmbedsResourcesAndRestrictsNetwork(t *testing.T) {
	var requested []string
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		requested = append(requested, r.URL.String())
		body, typ := "", ""
		switch r.URL.Path {
		case "/page":
			typ = "text/html"
			body = `<html><head><link rel="stylesheet" href="/style.css"></head><body onload="evil()"><h1>Archive</h1><img src="/photo.png"><img src="http://127.0.0.1/private"><script>evil()</script><iframe src="https://evil.test"></iframe><a href="/next">Next</a></body></html>`
		case "/style.css":
			typ = "text/css"
			body = `@import "https://evil.test/remote.css"; body {background:url('/photo.png')}`
		case "/photo.png":
			typ = "image/png"
			body = "fake png for transport test"
		default:
			t.Fatalf("unexpected network request %s", r.URL)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {typ}}, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})}
	var out bytes.Buffer
	report, err := offline(context.Background(), "https://example.com/page", &out, client)
	if err != nil {
		t.Fatal(err)
	}
	got := out.String()
	for _, bad := range []string{"evil()", "127.0.0.1", "<script", "<iframe", "@import", "https://evil.test"} {
		if strings.Contains(got, bad) {
			t.Errorf("retained unsafe content %q", bad)
		}
	}
	for _, want := range []string{"data:image/png;base64,", "https://example.com/next", "default-src &#39;none&#39;"} {
		if want == "default-src &#39;none&#39;" {
			continue
		}
		if !strings.Contains(got, want) {
			t.Errorf("missing %q", want)
		}
	}
	if report.Embedded != 3 || report.Omitted != 1 || len(requested) != 4 {
		t.Fatalf("report=%+v requests=%v", report, requested)
	}
}
func TestOfflineResourceBudget(t *testing.T) {
	client := fixtureClient([]byte(`<img src="/x">`+strings.Repeat(`<img src="/x">`, 40)), "text/html", "", 200)
	var out bytes.Buffer
	r, err := offline(context.Background(), "https://example.com", &out, client)
	if err != nil {
		t.Fatal(err)
	}
	if r.Omitted != 41 {
		t.Fatalf("unexpected report %+v", r)
	}
	var huge bytes.Buffer
	if _, err = offline(context.Background(), "https://example.com", &huge, fixtureClient(bytes.Repeat([]byte("x"), maxBody+1), "text/html", "", 200)); err == nil {
		t.Fatal("oversize HTML accepted")
	}
}
func TestReaderPreservesStructureWithoutActiveContent(t *testing.T) {
	src := `<head><title>hidden</title></head><nav>menu<main><h1 onclick="alert(1)">Heading</h1><p>A <strong>bold</strong> word <a href="/next">Next</a><a href="javascript:evil()">Bad</a></p><script>alert(2)</script><style>evil</style><iframe>hidden frame</iframe><img src="https://tracker.test"><form>hidden form</form><pre>1 &lt; 2</pre></main>`
	var out bytes.Buffer
	if err := Reader(strings.NewReader(src), &out, "https://example.com/start"); err != nil {
		t.Fatal(err)
	}
	got := out.String()
	for _, want := range []string{"<h1>Heading</h1>", "<strong>bold</strong>", `href="https://example.com/next"`, "<pre>1 &lt; 2</pre>"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q", want)
		}
	}
	for _, bad := range []string{"onclick", "javascript:", "alert(", "hidden frame", "hidden form", "tracker.test", "<img", "menu"} {
		if strings.Contains(got, bad) {
			t.Errorf("unsafe content %q", bad)
		}
	}
}
