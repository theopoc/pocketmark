package tagname

import (
	"strings"
	"testing"
)

func TestGenerated(t *testing.T) {
	for input, want := range map[string]string{
		" École  d’IA ": "école  d’ia", "C++": "c++", "C#": "c#", ".NET": ".net",
		"CI/CD": "ci/cd", "Node.js": "node.js", strings.Repeat("É", 40): strings.Repeat("é", 40),
	} {
		if got, ok := Generated(input); !ok || got != want {
			t.Errorf("Generated(%q) = %q, %t; want %q", input, got, ok, want)
		}
	}
	for _, input := range []string{
		"", "   ", "++", "new\nlabel", "\ttrimmed", "te\x00st", "\xff", "test\u202e",
		"https://example.com?a=b", "//example.org", "/private", "www.example.org",
		"one, two", "<html>", "person@example.org", strings.Repeat("Ⱦ", 40), strings.Repeat("é", 41),
	} {
		if name, ok := Generated(input); ok {
			t.Errorf("accepted %q as %q", input, name)
		}
	}
}
