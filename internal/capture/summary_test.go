package capture

import (
	"strings"
	"testing"
)

func TestCardSummaryUsesEditorialProseWhenDescriptionIsMissing(t *testing.T) {
	for _, tc := range []struct{ name, body, want string }{
		{"article before ancillary text", "<nav><p>Menu</p></nav><p>Subscribe</p><article><div id='comments'><p>Reply</p></div><div hidden><p>Hidden</p></div><p>Première  <em>idée</em>.<br>  Suite.</p><p>Second paragraph.</p></article>", "Première idée. Suite."},
		{"main role", "<p>Before.</p><div role=main><p> </p><p>Article.</p></div>", "Article."},
		{"byline", "<main><p class='author'>Reporter</p><p>A bridge closed today.</p></main>", "A bridge closed today."},
		{"plain paragraph", "<body><p>Page without a landmark.</p></body>", "Page without a landmark."},
		{"ancillary only", "<header><p>Menu</p></header><div id=comments><p>Comment</p></div>", ""},
		{"late metadata", "<article><p>Introduction.</p></article><meta name=description content='Publisher description.'>", "Publisher description."},
		{"bounded unicode", "<article><p>" + strings.Repeat("é", 190) + "</p></article>", strings.Repeat("é", 160) + "…"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			result, err := ExtractDocument(strings.NewReader(tc.body))
			if err != nil || result.Description != tc.want {
				t.Fatalf("got %q, error %v, want %q", result.Description, err, tc.want)
			}
		})
	}
}
