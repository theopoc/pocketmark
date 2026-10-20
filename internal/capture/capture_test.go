package capture

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"testing"
)

func TestPublicAddresses(t *testing.T) {
	for _, raw := range []string{"8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "2001:4860:4860::8888"} {
		if !isPublic(netip.MustParseAddr(raw)) {
			t.Errorf("public address rejected: %s", raw)
		}
	}
	for _, raw := range []string{"0.0.0.0", "0.1.2.3", "10.1.1.1", "100.64.1.1", "127.0.0.1", "169.254.169.254", "172.31.2.1", "192.0.0.1", "192.0.2.1", "192.88.99.1", "192.168.1.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255", "::", "::1", "::ffff:8.8.8.8", "fc00::1", "fe80::1", "ff02::1", "64:ff9b::808:808", "2001::1", "2001:db8::1", "2002:7f00:1::", "3fff::1", "2606:4700::1%eth0"} {
		if isPublic(netip.MustParseAddr(raw)) {
			t.Errorf("unsafe address accepted: %s", raw)
		}
	}
}

func TestDialPinsResolvedAddress(t *testing.T) {
	lookups := 0
	lookup := func(context.Context, string, string) ([]netip.Addr, error) {
		lookups++
		return []netip.Addr{netip.MustParseAddr("8.8.8.8")}, nil
	}
	wantErr := errors.New("test dial")
	dial := publicDial(lookup, func(_ context.Context, _, address string) (net.Conn, error) {
		if address != "8.8.8.8:443" {
			t.Fatalf("dial used unpinned address: %s", address)
		}
		return nil, wantErr
	})
	_, err := dial(context.Background(), "tcp", "example.com:443")
	if !errors.Is(err, wantErr) || lookups != 1 {
		t.Fatalf("err=%v lookups=%d", err, lookups)
	}
}

func TestDialRejectsPrivateAndMixedDNS(t *testing.T) {
	for _, ips := range [][]netip.Addr{{netip.MustParseAddr("127.0.0.1")}, {netip.MustParseAddr("8.8.8.8"), netip.MustParseAddr("10.0.0.1")}, nil} {
		dial := publicDial(func(context.Context, string, string) ([]netip.Addr, error) { return ips, nil }, func(context.Context, string, string) (net.Conn, error) {
			t.Fatal("unsafe destination dialed")
			return nil, nil
		})
		if _, err := dial(context.Background(), "tcp", "example.com:443"); err == nil {
			t.Fatal("expected DNS rejection")
		}
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func fixtureClient(body []byte, contentType, encoding string, status int) *http.Client {
	return &http.Client{CheckRedirect: checkRedirect, Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		header := make(http.Header)
		header.Set("Content-Type", contentType)
		header.Set("Content-Encoding", encoding)
		return &http.Response{StatusCode: status, Header: header, Body: io.NopCloser(bytes.NewReader(body)), Request: r}, nil
	})}
}

func TestFetchRejectsUnsafeURLAndRedirect(t *testing.T) {
	for _, raw := range []string{"file:///etc/passwd", "http://user:pass@example.com", "http://127.0.0.1", "http://[::ffff:8.8.8.8]", "https:///missing"} {
		if _, err := fetch(context.Background(), raw, fixtureClient(nil, "text/html", "", 200)); err == nil {
			t.Errorf("accepted %q", raw)
		}
	}
	for _, destination := range []string{"http://169.254.169.254/latest", "file:///etc/passwd", "http://user:pass@example.com"} {
		calls := 0
		client := &http.Client{CheckRedirect: checkRedirect, Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			calls++
			return &http.Response{StatusCode: 302, Header: http.Header{"Location": {destination}}, Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
		})}
		if _, err := fetch(context.Background(), "https://example.com", client); err == nil || calls != 1 {
			t.Fatalf("redirect accepted: %s, calls %d, err %v", destination, calls, err)
		}
	}
}

func TestRedirectLimit(t *testing.T) {
	calls := 0
	client := &http.Client{CheckRedirect: checkRedirect, Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: 302, Header: http.Header{"Location": {"https://example.com/loop"}}, Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
	})}
	if _, err := fetch(context.Background(), "https://example.com", client); err == nil || calls != 6 {
		t.Fatalf("calls=%d err=%v", calls, err)
	}
}

func TestExtractionAndFetch(t *testing.T) {
	body := []byte(`<html><head><title> A &amp; B </title><meta name="description" content="Useful  page"><style>bad CSS</style></head><body><header>menu</header><nav>other links</nav><main><h1>Hello</h1><p>Readable   text &amp; content.</p><script>dangerous()</script><svg><text>bad vector</text></svg></main><footer>footer</footer></body></html>`)
	result, err := fetch(context.Background(), "https://example.com", fixtureClient(body, "text/html; charset=utf-8", "", 200))
	if err != nil {
		t.Fatal(err)
	}
	if result.Title != "A & B" || result.Description != "Useful page" || result.Content != "Hello Readable text & content." || !bytes.Equal(result.HTML, body) {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestResponseLimitsAndContentType(t *testing.T) {
	var zipped bytes.Buffer
	writer := gzip.NewWriter(&zipped)
	writer.Write(bytes.Repeat([]byte("a"), maxBody+1))
	writer.Close()
	for _, tc := range []struct {
		body           []byte
		kind, encoding string
		status         int
	}{
		{bytes.Repeat([]byte("a"), maxBody+1), "text/html", "", 200},
		{zipped.Bytes(), "text/html", "gzip", 200},
		{[]byte(`{"key":1}`), "application/json", "", 200},
		{[]byte("<html></html>"), "text/html", "br", 200},
		{[]byte("<html></html>"), "text/html", "", 500},
	} {
		if _, err := fetch(context.Background(), "https://example.com", fixtureClient(tc.body, tc.kind, tc.encoding, tc.status)); err == nil {
			t.Fatalf("accepted invalid response: %s/%s/%d", tc.kind, tc.encoding, tc.status)
		}
	}
}

func TestGzipAndSniff(t *testing.T) {
	var zipped bytes.Buffer
	writer := gzip.NewWriter(&zipped)
	writer.Write([]byte("<html><body>Hello</body></html>"))
	writer.Close()
	result, err := fetch(context.Background(), "https://example.com", fixtureClient(zipped.Bytes(), "", "gzip", 200))
	if err != nil || result.Content != "Hello" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
}

func TestTokenAndTextLimits(t *testing.T) {
	titled, err := extract([]byte("<title>" + strings.Repeat("é", 1000) + "</title>"))
	if err != nil || len(titled.Title) != 1024 {
		t.Fatalf("title bound: %d, err=%v", len(titled.Title), err)
	}
	if _, err := extract([]byte("<p>" + strings.Repeat("x", maxToken+1) + "</p>")); err == nil {
		t.Fatal("oversized tokenizer input accepted")
	}
	result, err := extract([]byte(strings.Repeat("<p>"+strings.Repeat("é", 1000)+"</p>", 300)))
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Content) > maxText || len(result.Content) < maxText-4 {
		t.Fatalf("text bound: %d", len(result.Content))
	}
}
