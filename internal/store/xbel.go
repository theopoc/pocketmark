package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"
)

// XBEL synchronization is an authoritative metadata snapshot. Bodies and assets
// are retained for URLs still present. All input is validated before committing.
type xbelNode struct {
	Kind                        string
	ID, Title, URL, Description string
	HasDescription              bool
	HighestID                   int64
	Children                    []*xbelNode
}

func readXBEL(r io.Reader) (*xbelNode, error) {
	d := xml.NewDecoder(io.LimitReader(r, 8*1024*1024+1))
	root := &xbelNode{Kind: "xbel"}
	stack := []*xbelNode{root}
	count := 0
	opened := false
	closed := false
	ids := map[string]bool{}
	for {
		tok, e := d.Token()
		if e == io.EOF {
			if !opened || !closed || len(stack) != 1 {
				return nil, errors.New("incomplete XBEL")
			}
			return root, nil
		}
		if e != nil {
			return nil, e
		}
		switch t := tok.(type) {
		case xml.Comment:
			text := string(t)
			if at := strings.Index(text, "highestId :"); at >= 0 {
				tail := text[at+len("highestId :"):]
				if end := strings.IndexByte(tail, ':'); end >= 0 {
					value, e := strconv.ParseInt(strings.TrimSpace(tail[:end]), 10, 64)
					if e != nil || value < 0 || value > 9007199254740991 {
						return nil, errors.New("invalid XBEL highestId")
					}
					if value > root.HighestID {
						root.HighestID = value
					}
				}
			}
		case xml.StartElement:
			if closed {
				return nil, errors.New("multiple XML documents")
			}
			if !opened {
				if t.Name.Local != "xbel" {
					return nil, errors.New("expected xbel root")
				}
				opened = true
				continue
			}
			switch t.Name.Local {
			case "folder", "bookmark":
				if stack[len(stack)-1].Kind == "bookmark" || len(stack) > 64 {
					return nil, errors.New("invalid or deeply nested XBEL")
				}
				count++
				if count > 12000 {
					return nil, errors.New("XBEL has too many entries")
				}
				n := &xbelNode{Kind: t.Name.Local}
				for _, a := range t.Attr {
					if a.Name.Local == "id" {
						n.ID = a.Value
					}
					if a.Name.Local == "href" {
						n.URL = a.Value
					}
				}
				if n.ID != "" {
					if len(n.ID) > 128 || ids[n.ID] {
						return nil, errors.New("invalid or duplicate XBEL ID")
					}
					ids[n.ID] = true
					if n.ID[0] >= '0' && n.ID[0] <= '9' {
						parsed, e := strconv.ParseInt(n.ID, 10, 64)
						if e != nil || parsed <= 0 || parsed > 9007199254740991 || strconv.FormatInt(parsed, 10) != n.ID {
							return nil, errors.New("invalid numeric XBEL ID")
						}
					}
					if strings.HasPrefix(n.ID, "b-") || strings.HasPrefix(n.ID, "c-") {
						prefix := "b-"
						if n.Kind == "folder" {
							prefix = "c-"
						}
						parsed, e := strconv.ParseInt(strings.TrimPrefix(n.ID, prefix), 10, 64)
						if e != nil || parsed <= 0 || n.ID != prefix+strconv.FormatInt(parsed, 10) {
							return nil, errors.New("invalid Pocketmark XBEL ID")
						}
					}
				}
				p := stack[len(stack)-1]
				p.Children = append(p.Children, n)
				stack = append(stack, n)
			case "title", "desc":
				var value string
				if e := d.DecodeElement(&value, &t); e != nil {
					return nil, e
				}
				if len(value) > 8192 {
					return nil, errors.New("XBEL text too long")
				}
				n := stack[len(stack)-1]
				if t.Name.Local == "title" {
					n.Title = value
				} else {
					n.Description = value
					n.HasDescription = true
				}
			default:
				if e := d.Skip(); e != nil {
					return nil, e
				}
			}
		case xml.EndElement:
			if t.Name.Local == "xbel" {
				closed = true
			} else if t.Name.Local == "folder" || t.Name.Local == "bookmark" {
				if len(stack) < 2 {
					return nil, errors.New("invalid XBEL structure")
				}
				stack = stack[:len(stack)-1]
			}
		}
	}
}
func exportXBEL(ctx context.Context, tx *sql.Tx, w io.Writer) error {
	if e := ensureDAVIDs(ctx, tx); e != nil {
		return e
	}
	var highest int64
	if e := tx.QueryRowContext(ctx, "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='dav_ids'),0)").Scan(&highest); e != nil {
		return e
	}
	enc := xml.NewEncoder(w)
	if _, e := io.WriteString(w, xml.Header); e != nil {
		return e
	}
	start := xml.StartElement{Name: xml.Name{Local: "xbel"}, Attr: []xml.Attr{{Name: xml.Name{Local: "version"}, Value: "1.0"}}}
	if e := enc.EncodeToken(start); e != nil {
		return e
	}
	if e := enc.EncodeToken(xml.CharData("\n")); e != nil {
		return e
	}
	if e := enc.EncodeToken(xml.Comment(fmt.Sprintf("- highestId :%d: for Floccus bookmark sync browser extension ", highest))); e != nil {
		return e
	}
	if e := enc.EncodeToken(xml.CharData("\n")); e != nil {
		return e
	}
	count, folders := 0, 0
	var emit func(*int64, int) error
	emit = func(parent *int64, depth int) error {
		if depth > 64 {
			return errors.New("collection hierarchy too deep for XBEL")
		}
		type entry struct {
			id, local int64
			kind      string
		}
		rows, e := tx.QueryContext(ctx, `SELECT d.id,d.local_id,d.kind,d.position FROM dav_ids d JOIN collections c ON d.kind='folder' AND d.local_id=c.id WHERE c.parent_id IS ?
UNION ALL SELECT d.id,d.local_id,d.kind,d.position FROM dav_ids d JOIN links l ON d.kind='bookmark' AND d.local_id=l.id WHERE l.collection_id IS ? AND (l.url LIKE 'http://%' OR l.url LIKE 'https://%') ORDER BY 4,1`, parent, parent)
		if e != nil {
			return e
		}
		entries := []entry{}
		for rows.Next() {
			var item entry
			var position int64
			if e = rows.Scan(&item.id, &item.local, &item.kind, &position); e != nil {
				rows.Close()
				return e
			}
			entries = append(entries, item)
			if len(entries) > 12000 {
				rows.Close()
				return errors.New("XBEL entry limit")
			}
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return e
		}
		for _, item := range entries {
			tag := xml.StartElement{Name: xml.Name{Local: item.kind}, Attr: []xml.Attr{{Name: xml.Name{Local: "id"}, Value: strconv.FormatInt(item.id, 10)}}}
			var title, desc, rawURL string
			if item.kind == "folder" {
				folders++
				if folders > 2000 {
					return errors.New("XBEL supports at most 2000 collections")
				}
				e = tx.QueryRowContext(ctx, "SELECT name FROM collections WHERE id=?", item.local).Scan(&title)
			} else {
				count++
				if count > 10000 {
					return errors.New("XBEL supports at most 10000 links")
				}
				e = tx.QueryRowContext(ctx, "SELECT title,description,url FROM links WHERE id=?", item.local).Scan(&title, &desc, &rawURL)
				tag.Attr = append(tag.Attr, xml.Attr{Name: xml.Name{Local: "href"}, Value: rawURL})
			}
			if e != nil {
				return e
			}
			if e = enc.EncodeToken(tag); e != nil {
				return e
			}
			if e = enc.EncodeElement(title, xml.StartElement{Name: xml.Name{Local: "title"}}); e != nil {
				return e
			}
			if item.kind == "folder" {
				if e = emit(&item.local, depth+1); e != nil {
					return e
				}
			} else if desc != "" {
				if e = enc.EncodeElement(desc, xml.StartElement{Name: xml.Name{Local: "desc"}}); e != nil {
					return e
				}
			}
			if e = enc.EncodeToken(tag.End()); e != nil {
				return e
			}
		}
		return nil
	}
	if e := emit(nil, 0); e != nil {
		return e
	}
	if e := enc.EncodeToken(start.End()); e != nil {
		return e
	}
	return enc.Flush()
}
func (s *Store) ExportXBEL(ctx context.Context, w io.Writer) (string, error) {
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		return "", e
	}
	defer tx.Rollback()
	h := sha256.New()
	if e = exportXBEL(ctx, tx, io.MultiWriter(w, h)); e != nil {
		return "", e
	}
	return `"` + hex.EncodeToString(h.Sum(nil)) + `"`, tx.Commit()
}

var ErrSyncConflict = errors.New("library changed; download and merge before uploading")

func (s *Store) ReplaceXBEL(ctx context.Context, r io.Reader, expected string) error {
	root, e := readXBEL(r)
	if e != nil {
		return e
	}
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if e = ensureDAVIDs(ctx, tx); e != nil {
		return e
	}
	if expected != "" && expected != "*" {
		h := sha256.New()
		if e = exportXBEL(ctx, tx, h); e != nil {
			return e
		}
		if `"`+hex.EncodeToString(h.Sum(nil))+`"` != expected {
			return ErrSyncConflict
		}
	}
	if e = replaceXBELTree(ctx, tx, root); e != nil {
		return e
	}
	return tx.Commit()
}
func replaceXBELTree(ctx context.Context, tx *sql.Tx, root *xbelNode) error {
	var e error
	if _, e = tx.ExecContext(ctx, "CREATE TEMP TABLE IF NOT EXISTS sync_links(id INTEGER PRIMARY KEY);DELETE FROM sync_links;CREATE TEMP TABLE IF NOT EXISTS sync_collections(id INTEGER PRIMARY KEY);DELETE FROM sync_collections"); e != nil {
		return e
	}
	seen := map[string]bool{}
	folders, links := 0, 0
	now := time.Now().UTC().Format(time.RFC3339Nano)
	var visit func(*xbelNode, *int64) error
	visit = func(n *xbelNode, parent *int64) error {
		for position, child := range n.Children {
			numericID, e := resolveDAVNodeID(ctx, tx, child)
			if e != nil {
				return e
			}
			if child.Kind == "folder" {
				folders++
				name := strings.TrimSpace(child.Title)
				if folders > 2000 || name == "" || len(name) > 120 {
					return errors.New("invalid folder or collection limit")
				}
				var cid int64
				// Our stable IDs survive renames/moves. Foreign clients get path-based matching.
				own, _ := strconv.ParseInt(strings.TrimPrefix(child.ID, "c-"), 10, 64)
				if strings.HasPrefix(child.ID, "c-") && own > 0 {
					if e := tx.QueryRowContext(ctx, "SELECT id FROM collections WHERE id=? AND id NOT IN(SELECT id FROM sync_collections)", own).Scan(&cid); e != nil {
						return errors.New("unknown or repeated collection ID; download and merge first")
					}
				}
				if cid == 0 {
					_ = tx.QueryRowContext(ctx, "SELECT id FROM collections WHERE name=? AND parent_id IS ? AND id NOT IN(SELECT id FROM sync_collections) ORDER BY id LIMIT 1", name, parent).Scan(&cid)
				}
				if cid == 0 {
					res, e := tx.ExecContext(ctx, "INSERT INTO collections(name,parent_id) VALUES(?,?)", name, parent)
					if e != nil {
						return e
					}
					cid, e = res.LastInsertId()
					if e != nil {
						return e
					}
				} else {
					if _, e := tx.ExecContext(ctx, "UPDATE collections SET name=?,parent_id=? WHERE id=?", name, parent, cid); e != nil {
						return e
					}
				}
				if _, e := tx.ExecContext(ctx, "INSERT INTO sync_collections(id) VALUES(?)", cid); e != nil {
					return e
				}
				if e := mapDAVNode(ctx, tx, "folder", cid, numericID, position); e != nil {
					return e
				}
				if e := visit(child, &cid); e != nil {
					return e
				}
			} else {
				links++
				l := Link{URL: child.URL, Title: child.Title, Description: child.Description, CollectionID: parent}
				if links > 10000 {
					return errors.New("XBEL supports at most 10000 links")
				}
				if e := Normalize(&l); e != nil {
					return e
				}
				if !strings.HasPrefix(l.URL, "http://") && !strings.HasPrefix(l.URL, "https://") {
					return errors.New("XBEL bookmarks require an HTTP or HTTPS URL")
				}
				if seen[l.URL] {
					return errors.New("duplicate URLs cannot be represented in this library")
				}
				seen[l.URL] = true
				var lid int64
				var e error
				if strings.HasPrefix(child.ID, "b-") {
					own, _ := strconv.ParseInt(strings.TrimPrefix(child.ID, "b-"), 10, 64)
					if e = tx.QueryRowContext(ctx, "SELECT id FROM links WHERE id=? AND id NOT IN(SELECT id FROM sync_links) AND (url LIKE 'http://%' OR url LIKE 'https://%')", own).Scan(&lid); e != nil {
						return errors.New("unknown or repeated bookmark ID; download and merge first")
					}
					var conflict int64
					if e = tx.QueryRowContext(ctx, "SELECT id FROM links WHERE url=? AND id<>?", l.URL, lid).Scan(&conflict); e == nil {
						return errors.New("bookmark ID and URL refer to different records")
					}
					if e != sql.ErrNoRows {
						return e
					}
					e = nil
				} else {
					e = tx.QueryRowContext(ctx, "SELECT id FROM links WHERE url=?", l.URL).Scan(&lid)
				}
				if e == sql.ErrNoRows {
					lid, e = Insert(ctx, tx, l)
				} else if e == nil {
					_, e = tx.ExecContext(ctx, `UPDATE links SET title=?,description=CASE WHEN ? THEN ? ELSE description END,collection_id=?,updated_at=?,
status=CASE WHEN url<>? THEN 'pending' ELSE status END,error=CASE WHEN url<>? THEN '' ELSE error END,
content=CASE WHEN url<>? THEN '' ELSE content END,archive=CASE WHEN url<>? THEN NULL ELSE archive END,url=? WHERE id=?`, l.Title, child.HasDescription, l.Description, parent, now, l.URL, l.URL, l.URL, l.URL, l.URL, lid)
				}
				if e != nil {
					return e
				}
				if _, e = tx.ExecContext(ctx, "INSERT INTO sync_links(id) VALUES(?)", lid); e != nil {
					return e
				}
				if e = mapDAVNode(ctx, tx, "bookmark", lid, numericID, position); e != nil {
					return e
				}
			}
		}
		return nil
	}
	if e = visit(root, nil); e != nil {
		return e
	}
	if _, e = tx.ExecContext(ctx, "DELETE FROM links WHERE id NOT IN(SELECT id FROM sync_links) AND (url LIKE 'http://%' OR url LIKE 'https://%');DELETE FROM collections WHERE id NOT IN(SELECT id FROM sync_collections);DELETE FROM sync_links;DELETE FROM sync_collections"); e != nil {
		return e
	}
	// Ordering-only imports must invalidate any previously uploaded snapshot too.
	if root.HighestID > 0 {
		if _, e = tx.ExecContext(ctx, "INSERT INTO sqlite_sequence(name,seq) SELECT 'dav_ids',? WHERE NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='dav_ids');UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='dav_ids'", root.HighestID, root.HighestID); e != nil {
			return e
		}
	}
	if _, e = tx.ExecContext(ctx, "UPDATE dav_revision SET value=value+1,modified=unixepoch() WHERE id=1"); e != nil {
		return e
	}
	return nil
}

func resolveDAVNodeID(ctx context.Context, tx *sql.Tx, n *xbelNode) (int64, error) {
	id, e := strconv.ParseInt(n.ID, 10, 64)
	if e != nil {
		return 0, nil
	}
	var kind string
	var local int64
	e = tx.QueryRowContext(ctx, "SELECT kind,local_id FROM dav_ids WHERE id=?", id).Scan(&kind, &local)
	if e == sql.ErrNoRows {
		n.ID = ""
		return id, nil
	}
	if e != nil {
		return 0, e
	}
	if kind != n.Kind {
		return 0, errors.New("XBEL ID changes its node type")
	}
	prefix := "b-"
	if kind == "folder" {
		prefix = "c-"
	}
	n.ID = prefix + strconv.FormatInt(local, 10)
	return id, nil
}
func mapDAVNode(ctx context.Context, tx *sql.Tx, kind string, local, requested int64, position int) error {
	var existing int64
	e := tx.QueryRowContext(ctx, "SELECT id FROM dav_ids WHERE kind=? AND local_id=?", kind, local).Scan(&existing)
	if e == nil {
		if requested > 0 && requested != existing {
			return errors.New("XBEL ID conflicts with an existing record")
		}
		_, e = tx.ExecContext(ctx, "UPDATE dav_ids SET position=? WHERE id=?", position, existing)
		return e
	}
	if e != sql.ErrNoRows {
		return e
	}
	if requested > 0 {
		_, e = tx.ExecContext(ctx, "INSERT INTO dav_ids(id,kind,local_id,position) VALUES(?,?,?,?)", requested, kind, local, position)
	} else {
		_, e = tx.ExecContext(ctx, "INSERT INTO dav_ids(kind,local_id,position) VALUES(?,?,?)", kind, local, position)
	}
	return e
}
