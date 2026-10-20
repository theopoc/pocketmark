package capture

import (
	"strings"
	"testing"
)

func TestRecoverFromUnclosedNavigation(t *testing.T) {
	// Minimized from go.dev's mobile navigation: nested navs close with divs.
	page := `<html><head><title>Guide</title></head><body><aside><nav><div><nav>Menu</div><div><nav>More menu</div></nav></aside><main><article><h1>Guide</h1><p>Actual article text.</p></article></main><footer>Footer</footer></body></html>`
	result, err := extract([]byte(page))
	if err != nil {
		t.Fatal(err)
	}
	if result.Title != "Guide" || result.Content != "Guide Actual article text." {
		t.Fatalf("unexpected extracted content: %+v", result)
	}
}

func TestContentBoundaryDoesNotExposeExcludedAssets(t *testing.T) {
	for _, tag := range []string{"template", "svg", "noscript", "iframe", "script", "style"} {
		t.Run(tag, func(t *testing.T) {
			page := "<body><" + tag + "><nav><main><article>Hidden text</article></main></nav></" + tag + "><main>Visible text</main></body>"
			result, err := extract([]byte(page))
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(result.Content, "Hidden") || !strings.Contains(result.Content, "Visible text") {
				t.Fatalf("unexpected extracted content: %q", result.Content)
			}
		})
	}
}
