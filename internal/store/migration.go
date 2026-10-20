package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/mattn/go-sqlite3"
)

// Imports intentionally exclude captured assets. Copy the SQLite database for a full backup.
type importLink struct {
	CreatedAt    string            `json:"createdAt"`
	UpdatedAt    string            `json:"updatedAt"`
	ID           int64             `json:"id"`
	URL          string            `json:"url"`
	Title        string            `json:"title"`
	Name         string            `json:"name"`
	Type         string            `json:"type"`
	Description  string            `json:"description"`
	Notes        string            `json:"notes"`
	CollectionID *int64            `json:"collectionId"`
	Tags         []json.RawMessage `json:"tags"`
	Favorite     bool              `json:"favorite"`
	Read         bool              `json:"read"`
}
type importCollection struct {
	Collection
	Links []importLink `json:"links"`
}
type importData struct {
	Format      string             `json:"format"`
	Version     int                `json:"version"`
	Collections []importCollection `json:"collections"`
	Links       []importLink       `json:"links"`
	PinnedLinks []importLink       `json:"pinnedLinks"`
}
type ImportResult struct {
	Imported int `json:"imported"`
	Skipped  int `json:"skipped"`
}

func (s *Store) Import(ctx context.Context, r io.Reader) (ImportResult, error) {
	var result ImportResult
	var data importData
	d := json.NewDecoder(r)
	if e := d.Decode(&data); e != nil {
		return result, e
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return result, errors.New("expected a single JSON document")
	}
	if data.Format != "" && (data.Format != "pocketmark" || data.Version != 1) {
		return result, errors.New("unsupported export format or version")
	}
	if data.Collections == nil && data.Links == nil {
		return result, errors.New("expected a Pocketmark or legacy client export with collections or links")
	}
	if len(data.Collections) > 2000 {
		return result, errors.New("import supports at most 2000 collections")
	}
	n := len(data.Links)
	for _, c := range data.Collections {
		n += len(c.Links)
	}
	if n > 10000 {
		return result, errors.New("import supports at most 10000 links per file")
	}
	tx, e := s.DB.BeginTx(ctx, nil)
	if e != nil {
		return result, e
	}
	defer tx.Rollback()
	ids := map[int64]int64{}
	byID := map[int64]importCollection{}
	for _, c := range data.Collections {
		if _, ok := byID[c.ID]; ok {
			return result, fmt.Errorf("duplicate collection id %d", c.ID)
		}
		byID[c.ID] = c
	}
	visiting := map[int64]bool{}
	var resolve func(int64) (int64, error)
	resolve = func(old int64) (int64, error) {
		if id, ok := ids[old]; ok {
			return id, nil
		}
		if visiting[old] {
			return 0, errors.New("cyclic collection hierarchy")
		}
		c, ok := byID[old]
		if !ok {
			return 0, fmt.Errorf("missing parent collection %d", old)
		}
		visiting[old] = true
		var parent *int64
		if c.ParentID != nil {
			id, e := resolve(*c.ParentID)
			if e != nil {
				return 0, e
			}
			parent = &id
		}
		id, e := findOrAddDescribedCollection(ctx, tx, c.Name, parent, c.Description)
		if e != nil {
			return 0, e
		}
		ids[old] = id
		delete(visiting, old)
		return id, nil
	}
	for _, c := range data.Collections {
		if _, e := resolve(c.ID); e != nil {
			return result, e
		}
	}
	pinned := map[string]bool{}
	for _, p := range data.PinnedLinks {
		pinned[p.URL] = true
	}
	add := func(in importLink, collectionID *int64) error {
		if in.Type != "" && in.Type != "url" && !(in.Type == "file" && IsFileURL(in.URL)) {
			result.Skipped++
			return nil
		}
		l := Link{URL: in.URL, Title: in.Title, Description: in.Description, Notes: in.Notes, Tags: []string{}, CollectionID: collectionID, Favorite: in.Favorite || pinned[in.URL], Read: in.Read}
		if l.Title == "" {
			l.Title = in.Name
		}
		for _, raw := range in.Tags {
			var tag string
			if e := json.Unmarshal(raw, &tag); e != nil {
				var obj struct {
					Name string `json:"name"`
				}
				if e = json.Unmarshal(raw, &obj); e != nil {
					return errors.New("invalid tag")
				}
				tag = obj.Name
			}
			l.Tags = append(l.Tags, tag)
		}
		created, e := importTime(in.CreatedAt)
		if e != nil {
			return e
		}
		updated, e := importTime(in.UpdatedAt)
		if e != nil {
			return e
		}
		id, e := Insert(ctx, tx, l)
		if e != nil {
			var se sqlite3.Error
			if errors.As(e, &se) && se.ExtendedCode == sqlite3.ErrConstraintUnique {
				result.Skipped++
				return nil
			}
			return fmt.Errorf("invalid bookmark: %w", e)
		}
		if created != "" || updated != "" {
			if created == "" {
				created = updated
			}
			if updated == "" {
				updated = created
			}
			if _, e = tx.ExecContext(ctx, "UPDATE links SET created_at=?,updated_at=? WHERE id=?", created, updated, id); e != nil {
				return e
			}
		}
		result.Imported++
		return nil
	}
	for _, c := range data.Collections {
		id := ids[c.ID]
		for _, l := range c.Links {
			if e := add(l, &id); e != nil {
				return ImportResult{}, e
			}
		}
	}
	for _, l := range data.Links {
		var id *int64
		if l.CollectionID != nil {
			v, ok := ids[*l.CollectionID]
			if !ok {
				return ImportResult{}, errors.New("bookmark references a missing collection")
			}
			id = &v
		}
		if e := add(l, id); e != nil {
			return ImportResult{}, e
		}
	}
	if e = tx.Commit(); e != nil {
		return ImportResult{}, e
	}
	return result, nil
}

// Export uses a consistent read transaction and streams bookmarks one at a time.
func (s *Store) Export(ctx context.Context, w io.Writer) error {
	tx, e := s.DB.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if _, e = io.WriteString(w, `{"format":"pocketmark","version":1,"collections":[`); e != nil {
		return e
	}
	rows, e := tx.QueryContext(ctx, "SELECT id,name,parent_id,description FROM collections ORDER BY id")
	if e != nil {
		return e
	}
	enc := json.NewEncoder(w)
	first := true
	for rows.Next() {
		var c Collection
		if e = rows.Scan(&c.ID, &c.Name, &c.ParentID, &c.Description); e != nil {
			rows.Close()
			return e
		}
		if !first {
			if _, e = io.WriteString(w, ","); e != nil {
				rows.Close()
				return e
			}
		}
		first = false
		if e = enc.Encode(c); e != nil {
			rows.Close()
			return e
		}
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	if _, e = io.WriteString(w, `],"links":[`); e != nil {
		return e
	}
	rows, e = tx.QueryContext(ctx, "SELECT "+columns+" FROM links l ORDER BY id")
	if e != nil {
		return e
	}
	defer rows.Close()
	first = true
	for rows.Next() {
		l, e := scan(rows, false)
		if e != nil {
			return e
		}
		if !first {
			if _, e = io.WriteString(w, ","); e != nil {
				return e
			}
		}
		first = false
		if e = enc.Encode(l); e != nil {
			return e
		}
	}
	if e = rows.Err(); e != nil {
		return e
	}
	if _, e = io.WriteString(w, "]}"); e != nil {
		return e
	}
	return tx.Commit()
}

func importTime(raw string) (string, error) {
	if raw == "" {
		return "", nil
	}
	t, e := time.Parse(time.RFC3339Nano, raw)
	if e != nil {
		return "", errors.New("invalid imported timestamp")
	}
	return t.UTC().Format(time.RFC3339Nano), nil
}
func findOrAddCollection(ctx context.Context, tx *sql.Tx, name string, parent *int64) (int64, error) {
	return findOrAddDescribedCollection(ctx, tx, name, parent, nil)
}
func findOrAddDescribedCollection(ctx context.Context, tx *sql.Tx, name string, parent *int64, description *string) (int64, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 120 {
		return 0, errors.New("invalid collection name")
	}
	if description != nil && len(*description) > 8192 {
		return 0, errors.New("collection description exceeds 8 KiB")
	}
	var id int64
	e := tx.QueryRowContext(ctx, "SELECT id FROM collections WHERE name=? AND parent_id IS ? ORDER BY id LIMIT 1", name, parent).Scan(&id)
	if e == nil {
		if description != nil {
			// Import merges into existing named folders without discarding their
			// descriptions; an empty destination can recover imported metadata.
			_, e = tx.ExecContext(ctx, "UPDATE collections SET description=? WHERE id=? AND description=''", *description, id)
		}
		return id, e
	}
	if !errors.Is(e, sql.ErrNoRows) {
		return 0, e
	}
	r, e := tx.ExecContext(ctx, "INSERT INTO collections(name,parent_id,description) VALUES(?,?,COALESCE(?,''))", name, parent, description)
	if e != nil {
		return 0, e
	}
	return r.LastInsertId()
}
