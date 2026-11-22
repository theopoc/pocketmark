// Package tagname validates topic labels suggested by AI tagging.
package tagname

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// Generated canonicalizes a model suggestion. Existing library tags can be
// selected by index even when their owner chose a different naming style.
func Generated(raw string) (string, bool) {
	if !utf8.ValidString(raw) {
		return "", false
	}
	hasWord := false
	for _, r := range raw {
		switch {
		case unicode.IsLetter(r), unicode.IsNumber(r):
			hasWord = true
		case unicode.IsMark(r), unicode.Is(unicode.Zs, r), strings.ContainsRune("+#.-_/'’&()", r):
		default:
			return "", false
		}
	}
	trimmed := strings.TrimSpace(raw)
	name := strings.ToLower(trimmed)
	if !hasWord || len(trimmed) > 80 || len(name) > 80 || strings.HasPrefix(name, "/") ||
		strings.Contains(name, "//") || strings.HasPrefix(name, "www.") {
		return "", false
	}
	return name, true
}
