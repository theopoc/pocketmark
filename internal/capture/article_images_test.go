package capture

import (
	"bytes"
	"context"
	"encoding/base64"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"testing"

	"golang.org/x/net/html"
)

func TestArticleImagesKeepOriginalAndPrioritizeIllustrations(t *testing.T) {
	var img bytes.Buffer
	if err := png.Encode(&img, image.NewRGBA(image.Rect(0, 0, 3, 2))); err != nil {
		t.Fatal(err)
	}
	data := "data:image/png;base64," + base64.StdEncoding.EncodeToString(img.Bytes())
	base := "https://site.test/articles/post"
	noise := strings.Repeat(`<img src="/logo">`, 32)
	page := `<!DOCTYPE HTML><head><base href="https://media.test/pics/"></head><nav>` + noise + `</nav>
	<main><article><h1>Original article</h1><section id="comments"><div><img src="/avatar"></div></section>
	<aside><figure><picture><source media="(max-width: 600px)" srcset="mobile.png">
	<source media="(min-width: 600px)" srcset="small.png 400w, great.png 1280w, huge.png 2400w">
	<img class="author-figure" src="placeholder.png" alt="Illustration"></picture><figcaption>Legend</figcaption></figure></aside>
	<figure><img data-src="lazy.png" alt="Lazy"></figure></article></main>`
	var calls []string
	client := &http.Client{CheckRedirect: checkRedirect, Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls = append(calls, r.URL.String())
		body, media := []byte(page), "text/html"
		if r.URL.String() != base {
			media = "image/png"
			body = img.Bytes()
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {media}}, Body: io.NopCloser(bytes.NewReader(body)), Request: r}, nil
	})}
	result, err := fetch(context.Background(), base, client)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{base, "https://media.test/pics/great.png", "https://media.test/pics/lazy.png"}
	if !slices.Equal(calls, want) {
		t.Fatalf("automatic calls %v", calls)
	}
	if string(result.HTML) != page || !bytes.Contains(result.ReaderHTML, []byte("Original article")) || strings.Count(string(result.ReaderHTML), data) != 2 || !bytes.Contains(result.ReaderHTML, []byte(`class="author-figure"`)) {
		t.Fatal("raw HTML or article image fidelity changed")
	}
	calls = nil
	var saved bytes.Buffer
	report, err := offline(context.Background(), base, &saved, client)
	if err != nil {
		t.Fatal(err)
	}
	if len(calls) > 25 || len(calls) < 3 || !slices.Equal(calls[:3], want) || report.Embedded < 2 || strings.Count(saved.String(), data) < 2 || strings.Contains(saved.String(), "placeholder.png") {
		t.Fatalf("offline did not prioritize both editorial illustrations: count=%d report=%+v", len(calls), report)
	}
}

func TestArticleImagesSkipUnusableAndOverBudgetResources(t *testing.T) {
	base, _ := url.Parse("https://article.test/")
	body := []byte(`<article><img src="http://127.0.0.1/private"><img src="/not-raster"><img src="/too-large"></article>`)
	var calls int
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.Host != "article.test" {
			t.Fatal("unvalidated resource")
		}
		length := int64(6)
		if r.URL.Path == "/too-large" {
			length = maxBody + 1
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"image/png"}}, ContentLength: length, Body: io.NopCloser(strings.NewReader("<html>")), Request: r}, nil
	})}
	if out := illustratedArticle(context.Background(), body, base, client); out != nil || calls != 2 {
		t.Fatalf("unexpected derivative or requests: %d bytes, %d calls", len(out), calls)
	}
	if out := illustratedArticle(context.Background(), bytes.Repeat([]byte("x"), maxBody), base, client); out != nil || calls != 2 {
		t.Fatal("no room for illustration")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if out := illustratedArticle(ctx, body, base, client); out != nil || calls != 2 {
		t.Fatal("cancelled illustration used network")
	}
}

func TestArticleCommentsExcludeNestedThreadsOnly(t *testing.T) {
	body := `<main><article><p>First</p><section class="comments-area"><section>thread</section><p>nested reply</p></section><div itemtype="https://schema.org/Comment"><article>reply</article></div><code class="comments">keep syntax example</code><aside>Important advice</aside><p>Last</p></article></main>`
	r, err := ExtractDocument(strings.NewReader(body))
	if err != nil || r.Content != "First keep syntax example Important advice Last" {
		t.Fatalf("index %q: %v", r.Content, err)
	}
	var out bytes.Buffer
	if err = Reader(strings.NewReader(body), &out, "https://article.test"); err != nil || strings.Contains(out.String(), "reply") || strings.Contains(out.String(), "thread") || !strings.Contains(out.String(), "Important advice") || !strings.Contains(out.String(), "keep syntax example") {
		t.Fatalf("passive reader %s: %v", out.String(), err)
	}
}

func TestIndexedHTMLDecodesDeclaredCharsetAndRetainsCode(t *testing.T) {
	for _, tc := range []struct{ name, header, source, want string }{
		{"meta", "", "<meta charset=windows-1252><p>caf\xe9 &amp; \x80</p>", "café & €"},
		{"transport", "text/html; charset=iso-8859-1", "<p>cr\xe8me</p>", "crème"},
		{"utf8-late", "", "<!--charset " + strings.Repeat(" ", 1100) + "--><p>été</p>", "été"},
		{"utf8-bom", "text/html; charset=windows-1252", "\xef\xbb\xbf<p>déjà</p>", "déjà"},
		{"pre", "", "<pre><code>if x:\n\t<span>x</span><span>++</span>;\n\n  end<br>last</code></pre>", "if x:\n\tx++;\n\n  end\nlast"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := extractReader(decodedHTML(strings.NewReader(tc.source), tc.header), maxToken)
			if err != nil || got.Content != tc.want {
				t.Fatalf("got %q, want %q: %v", got.Content, tc.want, err)
			}
		})
	}
}

func TestReadingCopyKeepsOnlyExplicitIllustrationBackgrounds(t *testing.T) {
	page := `<article><div style="background-image:url(decor.png)">Decorative</div><div role="img" aria-label="Map" style="background:url(map.png)"></div></article>`
	u, _ := url.Parse("https://example.com/post/")
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != "https://example.com/post/map.png" {
			t.Fatalf("unexpected %s", r.URL)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("\x89PNG\r\n\x1a\nfixture")), Request: r}, nil
	})}
	result := illustratedArticle(context.Background(), []byte(page), u, client)
	if !bytes.Contains(result, []byte(`data-src="data:image/png;base64,`)) || !bytes.Contains(result, []byte(`aria-label="Map"`)) {
		t.Fatalf("missing background: %s", result)
	}
}

func TestOfflineKeepsEmbeddedFallbackWhenPreferredPictureFails(t *testing.T) {
	const fallback = "data:image/png;base64,iVBORw0KGgo="
	page := `<article><picture><source srcset="/missing.png"><img alt="Figure" src="` + fallback + `"></picture></article>`
	var requests []string
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		requests = append(requests, r.URL.Path)
		status, body := 200, page
		if r.URL.Path != "/article" {
			status, body = 404, ""
		}
		return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": {"text/html"}}, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})}
	var dst bytes.Buffer
	report, err := offline(context.Background(), "https://example.test/article", &dst, client)
	if err != nil || !slices.Equal(requests, []string{"/article", "/missing.png"}) || !strings.Contains(dst.String(), `src="`+fallback+`"`) || report.Omitted != 1 {
		t.Fatalf("fallback missing: requests=%v, report=%+v, err=%v", requests, report, err)
	}
}

func TestPeripheralFiguresCannotDisplaceArticleImages(t *testing.T) {
	body := strings.Repeat(`<figure><img src="/promo.png"></figure>`, maxArticleImages) + `<main><article><img src="/story.png"></article></main>`
	base, _ := url.Parse("https://example.test/")
	images, _ := imageReferences([]byte(body), base, false)
	if len(images) != 1 || images[0].url != "/story.png" {
		t.Fatalf("editorial priority lost: %+v", images)
	}
}

func TestHTTPCharsetSurvivesEveryReadingCopy(t *testing.T) {
	const raw = "<html><p>caf\xe9 &amp; \x80</p></html>"
	const contentType = "text/html; charset=windows-1252"
	const want = "café & €"
	r, err := fetch(context.Background(), "https://example.test/article", fixtureClient([]byte(raw), contentType, "", 200))
	if err != nil || string(r.HTML) != raw || r.Content != want {
		t.Fatalf("automatic archive/index, err=%v text=%q", err, r.Content)
	}
	indexed, err := ExtractDocument(bytes.NewReader(r.ReaderHTML))
	if err != nil || indexed.Content != want {
		t.Fatalf("standalone derivative: text=%q err=%v", indexed.Content, err)
	}
	var out bytes.Buffer
	_, err = offline(context.Background(), "https://example.test/article", &out, fixtureClient([]byte(raw), contentType, "", 200))
	if err != nil {
		t.Fatal(err)
	}
	indexed, err = ExtractDocument(&out)
	if err != nil || indexed.Content != want {
		t.Fatalf("offline charset: text=%q err=%v", indexed.Content, err)
	}
}

func TestFullSizeHeaderOnlyCharsetKeepsEveryByte(t *testing.T) {
	body := bytes.Repeat([]byte{0xe9}, maxBody)
	got := selfDescribingArticle(body, nil, "text/html; charset=windows-1252")
	if len(got) > maxBody+64 || !bytes.HasSuffix(got, body) || detectHTMLEncoding(got, "").name != "windows-1252" {
		t.Fatal("full source or charset lost")
	}
}

func TestSelfContainedPictureNeverReplacedWithRemoteFallback(t *testing.T) {
	const embedded = "data:image/png;base64,iVBORw0KGgo="
	page := `<article><picture><source srcset="` + embedded + ` 1x"><img src="fallback.png"></picture></article>`
	requests := 0
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		requests++
		if r.URL.Path != "/article" {
			t.Fatalf("unnecessary fetch %s", r.URL)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"text/html"}}, Body: io.NopCloser(strings.NewReader(page)), Request: r}, nil
	})}
	got, err := fetch(context.Background(), "https://example.test/article", client)
	if err != nil || got.ReaderHTML != nil || string(got.HTML) != page {
		t.Fatal("self-contained candidate overwritten")
	}
	var output bytes.Buffer
	_, err = offline(context.Background(), "https://example.test/article", &output, client)
	if err != nil || requests != 2 || !strings.Contains(output.String(), `src="`+embedded+`"`) {
		t.Fatal("embedded candidate missing from offline image")
	}
}

func TestAutomaticReadingCopyPromotesEmbeddedImageOverEmbeddedPlaceholder(t *testing.T) {
	const prefix = "data:image/png;base64,"
	pngURL := func(width, height int, pixel color.RGBA) string {
		img := image.NewRGBA(image.Rect(0, 0, width, height))
		draw.Draw(img, img.Bounds(), image.NewUniform(pixel), image.Point{}, draw.Src)
		var buf bytes.Buffer
		if err := png.Encode(&buf, img); err != nil {
			t.Fatal(err)
		}
		return prefix + base64.StdEncoding.EncodeToString(buf.Bytes())
	}
	red := color.RGBA{R: 222, G: 40, B: 70, A: 255}
	figure := pngURL(11, 7, red)
	thumb := pngURL(1, 1, color.RGBA{R: 128, G: 128, B: 128, A: 255})
	for name, markup := range map[string]string{
		"picture": `<picture><source srcset="` + figure + ` 1x"><img src="` + thumb + `"></picture>`,
		"lazy":    `<img src="` + thumb + `" data-src="` + figure + `">`,
	} {
		t.Run(name, func(t *testing.T) {
			raw := `<article>` + markup + `</article>`
			calls := 0
			client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				calls++
				if r.URL.Path != "/article" {
					t.Fatalf("unexpected image request %s", r.URL)
				}
				return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"text/html"}}, Body: io.NopCloser(strings.NewReader(raw)), Request: r}, nil
			})}
			got, err := fetch(context.Background(), "https://example.test/article", client)
			if err != nil || calls != 1 || string(got.HTML) != raw || len(got.ReaderHTML) > maxBody {
				t.Fatalf("original or budgets changed: %v", err)
			}
			z := html.NewTokenizer(bytes.NewReader(got.ReaderHTML))
			for z.Next() != html.ErrorToken {
				tag := z.Token()
				if tag.Data != "img" || tag.Type != html.StartTagToken {
					continue
				}
				data, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(attr(tag, "src"), prefix))
				if err != nil {
					t.Fatal(err)
				}
				img, err := png.Decode(bytes.NewReader(data))
				if err != nil || img.Bounds() != image.Rect(0, 0, 11, 7) || color.RGBAModel.Convert(img.At(0, 0)) != red {
					t.Fatalf("expected full-size red figure: %v", err)
				}
				return
			}
			t.Fatal("reading copy has no img")
		})
	}
}
