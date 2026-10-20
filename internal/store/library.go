package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode"
)

// fuzzyMatch processes only one bounded metadata record at a time. It never
// builds a resident search index or loads captured page bodies.
func fuzzyMatch(query, metadata string) bool {
	terms := strings.FieldsFunc(strings.ToLower(query), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) })
	words := strings.FieldsFunc(strings.ToLower(metadata), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) })
	if len(terms) > 16 {
		return false
	}
	for _, term := range terms {
		found := false
		for _, word := range words {
			if strings.HasPrefix(word, term) || oneEdit(term, word) {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return len(terms) > 0
}
func oneEdit(a, b string) bool {
	x, y := []rune(a), []rune(b)
	if len(x) < 4 || len(x) > 80 || len(y) > 80 || len(x)-len(y) > 1 || len(y)-len(x) > 1 {
		return false
	}
	i, j, edits := 0, 0, 0
	for i < len(x) && j < len(y) {
		if x[i] == y[j] {
			i++
			j++
			continue
		}
		edits++
		if edits > 1 {
			return false
		}
		if len(x) > len(y) {
			i++
		} else if len(y) > len(x) {
			j++
		} else {
			i++
			j++
		}
	}
	if i < len(x) || j < len(y) {
		edits++
	}
	return edits <= 1
}
func (s *Store) UpdateCollection(ctx context.Context, id int64, c Collection) error {
	c.Name = strings.TrimSpace(c.Name)
	if c.Name == "" || len(c.Name) > 120 {
		return errors.New("invalid collection name")
	}
	if c.Description != nil && len(*c.Description) > 8192 {
		return errors.New("collection description exceeds 8 KiB")
	}
	if c.ParentID != nil && *c.ParentID <= 0 {
		c.ParentID = nil
	}
	tx, e := s.DB.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if c.ParentID != nil {
		var n int
		e = tx.QueryRowContext(ctx, `WITH RECURSIVE ancestors(id,parent_id) AS (SELECT id,parent_id FROM collections WHERE id=? UNION SELECT c.id,c.parent_id FROM collections c JOIN ancestors a ON c.id=a.parent_id) SELECT count(*) FROM ancestors WHERE id=?`, *c.ParentID, id).Scan(&n)
		if e != nil {
			return e
		}
		if n > 0 {
			return errors.New("cyclic collection hierarchy")
		}
	}
	r, e := tx.ExecContext(ctx, "UPDATE collections SET name=?,parent_id=?,description=COALESCE(?,description) WHERE id=?", c.Name, c.ParentID, c.Description, id)
	if e = affected(r, e); e != nil {
		return e
	}
	return tx.Commit()
}

type BulkChange struct {
	IDs          []int64  `json:"ids"`
	Action       string   `json:"action"`
	CollectionID *int64   `json:"collectionId"`
	Tags         []string `json:"tags"`
	Value        bool     `json:"value"`
}

func (s *Store) Bulk(ctx context.Context, b BulkChange) error {
	if len(b.IDs) < 1 || len(b.IDs) > 500 {
		return errors.New("select 1–500 bookmarks")
	}
	var query string
	var args []any
	switch b.Action {
	case "delete":
		query = "DELETE FROM links WHERE id=?"
	case "move":
		query = "UPDATE links SET collection_id=?,updated_at=? WHERE id=?"
		if b.CollectionID != nil && *b.CollectionID <= 0 {
			b.CollectionID = nil
		}
		args = []any{b.CollectionID, time.Now().UTC().Format(time.RFC3339Nano)}
	case "tags":
		l := Link{URL: "https://example.invalid", Tags: b.Tags}
		if e := Normalize(&l); e != nil {
			return e
		}
		tags, _ := json.Marshal(l.Tags)
		query = "UPDATE links SET tags=?,updated_at=? WHERE id=?"
		args = []any{string(tags), time.Now().UTC().Format(time.RFC3339Nano)}
	case "favorite", "read":
		query = "UPDATE links SET " + b.Action + "=?,updated_at=? WHERE id=?"
		args = []any{b.Value, time.Now().UTC().Format(time.RFC3339Nano)}
	case "capture":
		query = "UPDATE links SET status='pending',error='' WHERE id=? AND status<>'processing' AND url NOT LIKE 'pocketmark-file:%'"
	default:
		return errors.New("invalid bulk action")
	}
	tx, e := s.DB.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	seen := map[int64]bool{}
	for _, id := range b.IDs {
		if id <= 0 || seen[id] {
			return errors.New("invalid or duplicate bookmark id")
		}
		seen[id] = true
		r, e := tx.ExecContext(ctx, query, append(args, id)...)
		if e = affected(r, e); e != nil {
			return e
		}
	}
	return tx.Commit()
}

type Annotation struct {
	ID        int64  `json:"id"`
	LinkID    int64  `json:"linkId"`
	Quote     string `json:"quote"`
	Start     int    `json:"start"`
	End       int    `json:"end"`
	Note      string `json:"note"`
	Color     string `json:"color"`
	CreatedAt string `json:"createdAt"`
	Stale     bool   `json:"stale"`
}

func annotationValid(a Annotation, content string) bool {
	if a.Start < 0 || a.End <= a.Start {
		return false
	}
	startByte, endByte, count := -1, -1, 0
	for index := range content {
		if count == a.Start {
			startByte = index
		}
		if count == a.End {
			endByte = index
			break
		}
		count++
	}
	if count == a.End && endByte < 0 {
		endByte = len(content)
	}
	return startByte >= 0 && endByte >= startByte && content[startByte:endByte] == a.Quote
}
func (s *Store) Annotations(ctx context.Context, linkID int64) ([]Annotation, error) {
	l, e := s.Get(ctx, linkID)
	if e != nil {
		return nil, e
	}
	rows, e := s.DB.QueryContext(ctx, "SELECT id,link_id,quote,start_offset,end_offset,note,color,created_at FROM annotations WHERE link_id=? ORDER BY start_offset,id", linkID)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []Annotation{}
	for rows.Next() {
		var a Annotation
		if e = rows.Scan(&a.ID, &a.LinkID, &a.Quote, &a.Start, &a.End, &a.Note, &a.Color, &a.CreatedAt); e != nil {
			return nil, e
		}
		a.Stale = !annotationValid(a, l.Content)
		out = append(out, a)
	}
	return out, rows.Err()
}
func (s *Store) SaveAnnotation(ctx context.Context, linkID, id int64, a Annotation) (int64, error) {
	if len(a.Quote) > 16384 || len(a.Note) > 8192 {
		return 0, errors.New("annotation field limit exceeded")
	}
	if a.Color == "" {
		a.Color = "yellow"
	}
	if a.Color != "yellow" && a.Color != "green" && a.Color != "blue" && a.Color != "pink" {
		return 0, errors.New("invalid highlight color")
	}
	tx, e := s.DB.BeginTx(ctx, nil)
	if e != nil {
		return 0, e
	}
	defer tx.Rollback()
	var content string
	if e = tx.QueryRowContext(ctx, "SELECT content FROM links WHERE id=?", linkID).Scan(&content); e != nil {
		return 0, e
	}
	if !annotationValid(a, content) {
		return 0, errors.New("highlight no longer matches captured text")
	}
	var r sql.Result
	if id == 0 {
		var count int
		if e = tx.QueryRowContext(ctx, "SELECT count(*) FROM annotations WHERE link_id=?", linkID).Scan(&count); e != nil {
			return 0, e
		}
		if count >= 200 {
			return 0, errors.New("limit of 200 annotations per page")
		}
		r, e = tx.ExecContext(ctx, "INSERT INTO annotations(link_id,quote,start_offset,end_offset,note,color,created_at) VALUES(?,?,?,?,?,?,?)", linkID, a.Quote, a.Start, a.End, a.Note, a.Color, time.Now().UTC().Format(time.RFC3339Nano))
		if e == nil {
			id, e = r.LastInsertId()
		}
	} else {
		r, e = tx.ExecContext(ctx, "UPDATE annotations SET quote=?,start_offset=?,end_offset=?,note=?,color=? WHERE id=? AND link_id=?", a.Quote, a.Start, a.End, a.Note, a.Color, id, linkID)
		e = affected(r, e)
	}
	if e != nil {
		return 0, e
	}
	return id, tx.Commit()
}
func (s *Store) DeleteAnnotation(ctx context.Context, linkID, id int64) error {
	r, e := s.DB.ExecContext(ctx, "DELETE FROM annotations WHERE id=? AND link_id=?", id, linkID)
	return affected(r, e)
}
