package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/mattn/go-sqlite3"
	nethtml "golang.org/x/net/html"
)

// ImportHTML tokenizes Netscape bookmark files incrementally, retaining only
// the current bookmark and a bounded folder stack. The transaction is atomic.
func (s *Store) ImportHTML(ctx context.Context, r io.Reader) (ImportResult, error) {
	result := ImportResult{}
	tx, e := s.DB.BeginTx(ctx, nil)
	if e != nil {
		return result, e
	}
	defer tx.Rollback()
	limited := &io.LimitedReader{R: r, N: 8*1024*1024 + 1}
	z := nethtml.NewTokenizer(limited)
	z.SetMaxBuf(128 * 1024)
	stack := []*int64{}
	var parent, pending *int64
	var current *Link
	var text strings.Builder
	mode := ""
	folders, links := 0, 0
	seenDL := false
	flush := func() error {
		if current == nil {
			return nil
		}
		links++
		if links > 10000 {
			return errors.New("import supports at most 10000 bookmarks")
		}
		if !strings.HasPrefix(current.URL, "http://") && !strings.HasPrefix(current.URL, "https://") {
			result.Skipped++
			current = nil
			return nil
		}
		created := current.CreatedAt
		id, e := Insert(ctx, tx, *current)
		if e != nil {
			var se sqlite3.Error
			if errors.As(e, &se) && se.ExtendedCode == sqlite3.ErrConstraintUnique {
				result.Skipped++
				current = nil
				return nil
			}
			return e
		}
		if created != "" {
			if _, e = tx.ExecContext(ctx, "UPDATE links SET created_at=?,updated_at=? WHERE id=?", created, created, id); e != nil {
				return e
			}
		}
		result.Imported++
		current = nil
		return nil
	}
	for {
		tt := z.Next()
		switch tt {
		case nethtml.ErrorToken:
			if z.Err() != io.EOF {
				return ImportResult{}, z.Err()
			}
			if limited.N <= 0 {
				return ImportResult{}, errors.New("bookmark file exceeds 8 MiB")
			}
			if e = flush(); e != nil {
				return ImportResult{}, e
			}
			if !seenDL {
				return ImportResult{}, errors.New("expected a Netscape bookmarks HTML file")
			}
			if e = tx.Commit(); e != nil {
				return ImportResult{}, e
			}
			return result, nil
		case nethtml.StartTagToken, nethtml.SelfClosingTagToken:
			token := z.Token()
			switch token.Data {
			case "dl":
				if e = flush(); e != nil {
					return ImportResult{}, e
				}
				seenDL = true
				if len(stack) >= 100 {
					return ImportResult{}, errors.New("folder nesting exceeds 100")
				}
				stack = append(stack, parent)
				if pending != nil {
					parent = pending
					pending = nil
				}
				mode = ""
			case "h3":
				if e = flush(); e != nil {
					return ImportResult{}, e
				}
				mode = "folder"
				text.Reset()
			case "a":
				if e = flush(); e != nil {
					return ImportResult{}, e
				}
				mode = "link"
				text.Reset()
				current = &Link{CollectionID: parent}
				for _, a := range token.Attr {
					switch a.Key {
					case "href":
						current.URL = a.Val
					case "tags":
						current.Tags = strings.Split(a.Val, ",")
					case "add_date":
						if sec, e := strconv.ParseInt(a.Val, 10, 64); e == nil && sec >= 0 {
							current.CreatedAt = time.Unix(sec, 0).UTC().Format(time.RFC3339Nano)
						}
					}
				}
			case "dd":
				mode = "description"
				text.Reset()
			case "dt":
				if mode == "description" && current != nil {
					current.Description = strings.TrimSpace(text.String())
				}
				mode = ""
			}
		case nethtml.TextToken:
			if mode != "" {
				tokenText := z.Text()
				if text.Len()+len(tokenText) > 65536 {
					return ImportResult{}, errors.New("bookmark text too large")
				}
				text.Write(tokenText)
				if mode == "description" && current != nil {
					current.Description = strings.TrimSpace(text.String())
				}
			}
		case nethtml.EndTagToken:
			name, _ := z.TagName()
			switch string(name) {
			case "h3":
				if mode == "folder" {
					folders++
					if folders > 2000 {
						return ImportResult{}, errors.New("import supports at most 2000 folders")
					}
					id, e := findOrAddCollection(ctx, tx, text.String(), parent)
					if e != nil {
						return ImportResult{}, e
					}
					pending = &id
					mode = ""
				}
			case "a":
				if mode == "link" && current != nil {
					current.Title = strings.TrimSpace(text.String())
					mode = ""
				}
			case "dl":
				if e = flush(); e != nil {
					return ImportResult{}, e
				}
				if len(stack) > 0 {
					parent = stack[len(stack)-1]
					stack = stack[:len(stack)-1]
				}
				mode = ""
			}
		}
	}
}

// ExportHTML streams bookmarks and writes folders depth-first. Only the small
// collection directory is retained in memory; bookmark bodies are never read.
func (s *Store) ExportHTML(ctx context.Context, w io.Writer) error {
	tx, e := s.DB.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	children := map[int64][]Collection{}
	rows, e := tx.QueryContext(ctx, "SELECT id,name,parent_id FROM collections ORDER BY name COLLATE NOCASE,id")
	if e != nil {
		return e
	}
	for rows.Next() {
		var c Collection
		if e = rows.Scan(&c.ID, &c.Name, &c.ParentID); e != nil {
			rows.Close()
			return e
		}
		key := int64(0)
		if c.ParentID != nil {
			key = *c.ParentID
		}
		children[key] = append(children[key], c)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	if _, e = io.WriteString(w, "<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV=\"Content-Type\" CONTENT=\"text/html; charset=UTF-8\">\n<TITLE>Pocketmark bookmarks</TITLE>\n<H1>Pocketmark bookmarks</H1>\n<DL><p>\n"); e != nil {
		return e
	}
	var folder func(*int64, int) error
	folder = func(parent *int64, depth int) error {
		if depth > 100 {
			return errors.New("folder nesting exceeds 100")
		}
		rows, e := tx.QueryContext(ctx, "SELECT url,title,description,tags,created_at FROM links WHERE collection_id IS ? AND url NOT LIKE 'pocketmark-file:%' ORDER BY id", parent)
		if e != nil {
			return e
		}
		for rows.Next() {
			var url, title, desc, tags, created string
			if e = rows.Scan(&url, &title, &desc, &tags, &created); e != nil {
				rows.Close()
				return e
			}
			t, _ := time.Parse(time.RFC3339Nano, created)
			var taglist []string
			_ = json.Unmarshal([]byte(tags), &taglist)
			if _, e = fmt.Fprintf(w, "<DT><A HREF=\"%s\" ADD_DATE=\"%d\" TAGS=\"%s\">%s</A>\n", html.EscapeString(url), t.Unix(), html.EscapeString(strings.Join(taglist, ",")), html.EscapeString(title)); e != nil {
				rows.Close()
				return e
			}
			if desc != "" {
				if _, e = fmt.Fprintf(w, "<DD>%s\n", html.EscapeString(desc)); e != nil {
					rows.Close()
					return e
				}
			}
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return e
		}
		key := int64(0)
		if parent != nil {
			key = *parent
		}
		for _, c := range children[key] {
			if _, e = fmt.Fprintf(w, "<DT><H3>%s</H3>\n<DL><p>\n", html.EscapeString(c.Name)); e != nil {
				return e
			}
			if e = folder(&c.ID, depth+1); e != nil {
				return e
			}
			if _, e = io.WriteString(w, "</DL><p>\n"); e != nil {
				return e
			}
		}
		return nil
	}
	if e = folder(nil, 0); e != nil {
		return e
	}
	if _, e = io.WriteString(w, "</DL><p>\n"); e != nil {
		return e
	}
	return tx.Commit()
}
