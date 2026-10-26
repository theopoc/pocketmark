package capture

import (
	"strings"
	"testing"
)

func TestPreviewRemovesNamespacedNavigation(t *testing.T) {
	for _, attribute := range []string{`xlink:href="https://example.test/leak"`, `XLINK:HREF="/leak"`, `href="#safe" xlink:href="/leak"`, `xlink:href="&#47;leak"`, `xlink:href="/leak" xlink:href="/second-leak"`} {
		var out strings.Builder
		err := Preview(strings.NewReader(`<svg xmlns:xlink="http://www.w3.org/1999/xlink"><a `+attribute+`><text y="20">Saved</text></a></svg>`), &out)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(out.String(), "leak") || strings.Contains(out.String(), "xlink:href=") {
			t.Fatalf("navigation retained: %s", out.String())
		}
		if !strings.Contains(out.String(), `<text y="20">Saved</text>`) {
			t.Fatal("saved appearance lost")
		}
	}
	var out strings.Builder
	if err := Preview(strings.NewReader(`<svg><a xlink:href="#local"><text>Local</text></a></svg>`), &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), `xlink:href="#local"`) {
		t.Fatal("local fragment removed")
	}
}
