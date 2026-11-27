package store

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

var (
	// An UPDATE of links, or an upsert into it, up to its WHERE clause.
	linkUpdate = regexp.MustCompile(`(?is)(?:\bUPDATE\s+links(?:\s+(?:AS\s+)?\w+)?|\bINSERT\s+INTO\s+links\b.*?\bDO\s+UPDATE)\s+SET\b(.*?)(?:\bWHERE\b|$)`)
	// A bare title or description column, not ai_private_title or a qualified
	// name such as l.title, assigned in the SET list.
	metadataAssignment = regexp.MustCompile(`(?i)(^|[^\w.])(title|description)\s*=`)
	linkInsert         = regexp.MustCompile(`(?is)\bINSERT\s+INTO\s+links\b\s*(\([^)]*\))?`)
)

// Every write of a bookmark's displayed title or description must also decide
// whether AI tagging may send it. Only metadataWrite assigns both together, so
// a statement elsewhere that sets them directly has skipped that decision.
// The store owns all SQL; this checks its string literals and + chains, not
// statements assembled with fmt or strings.Builder.
func TestOnlyMetadataSourcesWriteBookmarkMetadata(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	for _, name := range files {
		if strings.HasSuffix(name, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, name, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(f, func(n ast.Node) bool {
			expr, ok := n.(ast.Expr)
			if !ok {
				return true
			}
			sql, ok := sqlText(expr)
			if !ok {
				return true
			}
			for _, m := range linkUpdate.FindAllStringSubmatch(sql, -1) {
				if metadataAssignment.MatchString(m[1]) {
					t.Errorf("%s: UPDATE links sets title or description without a metadata source; use metadataWrite", fset.Position(expr.Pos()))
				}
			}
			for _, m := range linkInsert.FindAllStringSubmatch(sql, -1) {
				columns := strings.ToLower(m[1])
				if !strings.Contains(columns, "ai_private_title") || !strings.Contains(columns, "ai_private_description") {
					t.Errorf("%s: INSERT INTO links omits the AI privacy columns; take them from metadataSource.insertPrivacy", fset.Position(expr.Pos()))
				}
			}
			// A concatenation is checked as a whole; skip its parts.
			return false
		})
	}
}

// sqlText joins a string literal or a + chain containing one, writing ? for
// operands that are not literals.
func sqlText(e ast.Expr) (string, bool) {
	switch v := e.(type) {
	case *ast.BasicLit:
		if v.Kind != token.STRING {
			return "", false
		}
		s, err := strconv.Unquote(v.Value)
		return s, err == nil
	case *ast.BinaryExpr:
		if v.Op != token.ADD {
			return "", false
		}
		l, lok := sqlText(v.X)
		r, rok := sqlText(v.Y)
		if !lok && !rok {
			return "", false
		}
		if !lok {
			l = " ? "
		}
		if !rok {
			r = " ? "
		}
		return l + r, true
	case *ast.ParenExpr:
		return sqlText(v.X)
	}
	return "", false
}
