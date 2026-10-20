package store

import (
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/mattn/go-sqlite3"
)

func init() {
	sql.Register("pocketmark-sqlite3", &sqlite3.SQLiteDriver{ConnectHook: func(c *sqlite3.SQLiteConn) error {
		return c.RegisterFunc("fuzzy_match", fuzzyMatch, true)
	}})
}

type Store struct{ DB *sql.DB }
type Link struct {
	ID               int64    `json:"id"`
	Type             string   `json:"type"`
	URL              string   `json:"url"`
	Title            string   `json:"title"`
	Description      string   `json:"description"`
	Notes            string   `json:"notes"`
	CollectionID     *int64   `json:"collectionId"`
	Tags             []string `json:"tags"`
	Favorite         bool     `json:"favorite"`
	Read             bool     `json:"read"`
	Status           string   `json:"status"`
	Error            string   `json:"error,omitempty"`
	Content          string   `json:"content,omitempty"`
	ArchiveAvailable bool     `json:"archiveAvailable"`
	CreatedAt        string   `json:"createdAt"`
	UpdatedAt        string   `json:"updatedAt"`
}
type Collection struct {
	ID          int64   `json:"id"`
	Name        string  `json:"name"`
	ParentID    *int64  `json:"parentId"`
	Description *string `json:"description,omitempty"`
}
type Filter struct {
	Query, Collection, Tag, Sort string
	Fuzzy                        bool
	Favorite, Unread             bool
	Page                         int
}
type Page struct {
	Links    []Link `json:"links"`
	Total    int    `json:"total"`
	Page     int    `json:"page"`
	PageSize int    `json:"pageSize"`
}

func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	u := url.URL{Scheme: "file", Path: path}
	db, err := sql.Open("pocketmark-sqlite3", u.String()+"?_journal_mode=WAL&_synchronous=FULL&_foreign_keys=on&_busy_timeout=5000&_cache_size=-2048")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	s := &Store{db}
	_, err = db.Exec(`
PRAGMA mmap_size=0;
PRAGMA temp_store=FILE;
CREATE TABLE IF NOT EXISTS collections(id INTEGER PRIMARY KEY, name TEXT NOT NULL, parent_id INTEGER REFERENCES collections(id) ON DELETE SET NULL, description TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS links(
 id INTEGER PRIMARY KEY, url TEXT NOT NULL UNIQUE, title TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
 collection_id INTEGER REFERENCES collections(id) ON DELETE SET NULL, tags TEXT NOT NULL DEFAULT '[]', favorite INTEGER NOT NULL DEFAULT 0, read INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'pending', error TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '', archive BLOB,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS annotations(id INTEGER PRIMARY KEY, link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE, quote TEXT NOT NULL, start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT 'yellow', created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS annotations_link ON annotations(link_id,id);
CREATE INDEX IF NOT EXISTS links_collection ON links(collection_id,id DESC);
CREATE INDEX IF NOT EXISTS links_status ON links(status,id);
CREATE VIRTUAL TABLE IF NOT EXISTS links_fts USING fts5(title,url,description,notes,tags,content,content='links',content_rowid='id',tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS links_ai AFTER INSERT ON links BEGIN
 INSERT INTO links_fts(rowid,title,url,description,notes,tags,content) VALUES(new.id,new.title,new.url,new.description,new.notes,new.tags,new.content);
END;
CREATE TRIGGER IF NOT EXISTS links_ad AFTER DELETE ON links BEGIN
 INSERT INTO links_fts(links_fts,rowid,title,url,description,notes,tags,content) VALUES('delete',old.id,old.title,old.url,old.description,old.notes,old.tags,old.content);
END;
CREATE TRIGGER IF NOT EXISTS links_au AFTER UPDATE OF title,url,description,notes,tags,content ON links BEGIN
 INSERT INTO links_fts(links_fts,rowid,title,url,description,notes,tags,content) VALUES('delete',old.id,old.title,old.url,old.description,old.notes,old.tags,old.content);
 INSERT INTO links_fts(rowid,title,url,description,notes,tags,content) VALUES(new.id,new.title,new.url,new.description,new.notes,new.tags,new.content);
END;
UPDATE links SET status='pending' WHERE status='processing';
PRAGMA user_version=1;
`)
	if err != nil {
		db.Close()
		return nil, fmt.Errorf("initialize SQLite (build with -tags sqlite_fts5): %w", err)
	}
	if err = s.initLibraryTimestamps(); err != nil {
		db.Close()
		return nil, err
	}
	if err = os.Chmod(path, 0600); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}
func (s *Store) Close() error { return s.DB.Close() }

// IsFileURL recognizes opaque identifiers of local library documents. They are
// never passed to the network capture worker or exported as browser bookmarks.
func IsFileURL(raw string) bool {
	const prefix = "pocketmark-file:"
	if !strings.HasPrefix(raw, prefix) || len(raw) != len(prefix)+64 {
		return false
	}
	token := strings.TrimPrefix(raw, prefix)
	_, e := hex.DecodeString(token)
	return e == nil && token == strings.ToLower(token)
}

// Normalize applies bounded field sizes before records enter the database.
func Normalize(l *Link) error {
	l.URL = strings.TrimSpace(l.URL)
	u, err := url.Parse(l.URL)
	if !IsFileURL(l.URL) && (err != nil || u.Hostname() == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil || len(l.URL) > 4096) {
		return errors.New("URL must be an http(s) address without credentials (maximum 4096 bytes)")
	}
	// A URL used as the automatic title is bounded by the URL limit above.
	// Accept it on edits/import too, so long URLs can round-trip losslessly.
	if (len(l.Title) > 1024 && l.Title != l.URL) || len(l.Description) > 8192 || len(l.Notes) > 65536 || len(l.Tags) > 32 {
		return errors.New("field limit exceeded: title 1 KiB, description 8 KiB, notes 64 KiB, 32 tags")
	}
	l.Type = "url"
	if IsFileURL(l.URL) {
		l.Type = "file"
	}
	l.Title = strings.TrimSpace(l.Title)
	if l.Title == "" {
		l.Title = l.URL
	}
	tags := []string{}
	seen := map[string]bool{}
	for _, t := range l.Tags {
		t = strings.TrimSpace(t)
		if len(t) > 80 {
			return errors.New("tag exceeds 80 bytes")
		}
		if t != "" && !seen[t] {
			seen[t] = true
			tags = append(tags, t)
		}
	}
	l.Tags = tags
	if l.CollectionID != nil && *l.CollectionID <= 0 {
		l.CollectionID = nil
	}
	return nil
}

type executor interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

func Insert(ctx context.Context, ex executor, l Link) (int64, error) {
	if err := Normalize(&l); err != nil {
		return 0, err
	}
	tags, _ := json.Marshal(l.Tags)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	status := "pending"
	if IsFileURL(l.URL) {
		status = "ready"
	}
	r, err := ex.ExecContext(ctx, `INSERT INTO links(url,title,description,notes,collection_id,tags,favorite,read,created_at,updated_at,status) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, l.URL, l.Title, l.Description, l.Notes, l.CollectionID, string(tags), l.Favorite, l.Read, now, now, status)
	if err != nil {
		return 0, err
	}
	return r.LastInsertId()
}
func (s *Store) Create(ctx context.Context, l Link) (int64, error) { return Insert(ctx, s.DB, l) }
func (s *Store) Update(ctx context.Context, id int64, l Link) error {
	var oldURL string
	if e := s.DB.QueryRowContext(ctx, "SELECT url FROM links WHERE id=?", id).Scan(&oldURL); e != nil {
		return e
	}
	if (IsFileURL(oldURL) || IsFileURL(l.URL)) && oldURL != l.URL {
		return errors.New("a file document identifier cannot be changed")
	}

	if err := Normalize(&l); err != nil {
		return err
	}
	tags, _ := json.Marshal(l.Tags)
	r, err := s.DB.ExecContext(ctx, `UPDATE links SET title=?,description=?,notes=?,collection_id=?,tags=?,favorite=?,read=?,updated_at=?,
 status=CASE WHEN url<>? THEN 'pending' ELSE status END,error=CASE WHEN url<>? THEN '' ELSE error END,
 content=CASE WHEN url<>? THEN '' ELSE content END,archive=CASE WHEN url<>? THEN NULL ELSE archive END,url=? WHERE id=?`, l.Title, l.Description, l.Notes, l.CollectionID, string(tags), l.Favorite, l.Read, time.Now().UTC().Format(time.RFC3339Nano), l.URL, l.URL, l.URL, l.URL, l.URL, id)
	return affected(r, err)
}
func affected(r sql.Result, err error) error {
	if err != nil {
		return err
	}
	n, err := r.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return sql.ErrNoRows
	}
	return nil
}
func (s *Store) Delete(ctx context.Context, id int64) error {
	r, e := s.DB.ExecContext(ctx, "DELETE FROM links WHERE id=?", id)
	return affected(r, e)
}

const columns = `l.id,l.url,l.title,l.description,l.notes,l.collection_id,l.tags,l.favorite,l.read,l.status,l.error,l.archive IS NOT NULL,l.created_at,l.updated_at`

type scanner interface{ Scan(...any) error }

func scan(row scanner, withContent bool) (Link, error) {
	var l Link
	var tags string
	dst := []any{&l.ID, &l.URL, &l.Title, &l.Description, &l.Notes, &l.CollectionID, &tags, &l.Favorite, &l.Read, &l.Status, &l.Error, &l.ArchiveAvailable, &l.CreatedAt, &l.UpdatedAt}
	if withContent {
		dst = append(dst, &l.Content)
	}
	err := row.Scan(dst...)
	if err == nil {
		err = json.Unmarshal([]byte(tags), &l.Tags)
	}
	l.Type = "url"
	if IsFileURL(l.URL) {
		l.Type = "file"
	}
	return l, err
}
func (s *Store) Get(ctx context.Context, id int64) (Link, error) {
	return scan(s.DB.QueryRowContext(ctx, "SELECT "+columns+",l.content FROM links l WHERE id=?", id), true)
}
func (s *Store) List(ctx context.Context, f Filter) (Page, error) {
	if f.Page < 1 {
		f.Page = 1
	}
	p := Page{Links: []Link{}, Page: f.Page, PageSize: 40}
	where := " WHERE 1=1"
	args := []any{}
	if len(f.Query) > 512 {
		return p, errors.New("query exceeds 512 bytes")
	}
	if f.Query != "" && f.Fuzzy {
		where += " AND fuzzy_match(?,l.title || ' ' || l.url || ' ' || l.description || ' ' || l.tags)=1"
		args = append(args, f.Query)
	} else if f.Query != "" {
		terms := strings.Fields(f.Query)
		for i, t := range terms {
			terms[i] = `"` + strings.ReplaceAll(t, `"`, `""`) + `"*`
		}
		if len(terms) > 0 {
			where += " AND l.id IN (SELECT rowid FROM links_fts WHERE links_fts MATCH ?)"
			args = append(args, strings.Join(terms, " AND "))
		}
	}
	if f.Collection == "0" {
		where += " AND l.collection_id IS NULL"
	} else if f.Collection != "" {
		where += " AND l.collection_id=?"
		args = append(args, f.Collection)
	}
	if f.Tag != "" {
		where += " AND EXISTS(SELECT 1 FROM json_each(l.tags) WHERE value=?)"
		args = append(args, f.Tag)
	}
	if f.Favorite {
		where += " AND l.favorite=1"
	}
	if f.Unread {
		where += " AND l.read=0"
	}
	if err := s.DB.QueryRowContext(ctx, "SELECT COUNT(*) FROM links l"+where, args...).Scan(&p.Total); err != nil {
		return p, err
	}
	args = append(args, p.PageSize, (f.Page-1)*p.PageSize)
	order := map[string]string{"": "l.id DESC", "newest": "julianday(l.created_at) DESC,l.id DESC", "oldest": "julianday(l.created_at),l.id", "title": "l.title COLLATE NOCASE,l.id", "title_desc": "l.title COLLATE NOCASE DESC,l.id", "updated": "julianday(l.updated_at) DESC,l.id DESC"}[f.Sort]
	if order == "" {
		return p, errors.New("invalid sort")
	}
	rows, err := s.DB.QueryContext(ctx, "SELECT "+columns+" FROM links l"+where+" ORDER BY "+order+" LIMIT ? OFFSET ?", args...)
	if err != nil {
		return p, err
	}
	defer rows.Close()
	for rows.Next() {
		l, err := scan(rows, false)
		if err != nil {
			return p, err
		}
		p.Links = append(p.Links, l)
	}
	return p, rows.Err()
}
func (s *Store) Collections(ctx context.Context) ([]Collection, error) {
	rows, e := s.DB.QueryContext(ctx, "SELECT id,name,parent_id,description FROM collections ORDER BY name COLLATE NOCASE,id")
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []Collection{}
	for rows.Next() {
		var c Collection
		if e := rows.Scan(&c.ID, &c.Name, &c.ParentID, &c.Description); e != nil {
			return nil, e
		}
		out = append(out, c)
	}
	return out, rows.Err()
}
func (s *Store) AddCollection(ctx context.Context, c Collection) (int64, error) {
	c.Name = strings.TrimSpace(c.Name)
	if c.Name == "" || len(c.Name) > 120 {
		return 0, errors.New("collection name must be 1–120 bytes")
	}
	if c.Description != nil && len(*c.Description) > 8192 {
		return 0, errors.New("collection description exceeds 8 KiB")
	}
	r, e := s.DB.ExecContext(ctx, "INSERT INTO collections(name,parent_id,description) VALUES(?,?,COALESCE(?,''))", c.Name, c.ParentID, c.Description)
	if e != nil {
		return 0, e
	}
	return r.LastInsertId()
}
func (s *Store) DeleteCollection(ctx context.Context, id int64) error {
	r, e := s.DB.ExecContext(ctx, "DELETE FROM collections WHERE id=?", id)
	return affected(r, e)
}
func (s *Store) Queue(ctx context.Context, id int64) error {
	r, e := s.DB.ExecContext(ctx, "UPDATE links SET status='pending',error='' WHERE id=? AND status<>'processing' AND url NOT LIKE 'pocketmark-file:%'", id)
	return affected(r, e)
}
func (s *Store) Next(ctx context.Context) (Link, error) {
	// The service runs exactly one worker. This atomic claim also guards accidental second workers.
	return scan(s.DB.QueryRowContext(ctx, `UPDATE links SET status='processing' WHERE id=(SELECT id FROM links WHERE status='pending' AND url NOT LIKE 'pocketmark-file:%' ORDER BY id LIMIT 1) RETURNING id,url,title,description,notes,collection_id,tags,favorite,read,status,error,archive IS NOT NULL,created_at,updated_at`), false)
}
func (s *Store) Finish(ctx context.Context, l Link, title, description, content string, archive []byte, fetchErr error) error {
	if fetchErr != nil {
		_, e := s.DB.ExecContext(ctx, "UPDATE links SET status='failed',error=? WHERE id=? AND url=? AND status='processing'", fetchErr.Error(), l.ID, l.URL)
		return e
	}
	_, e := s.DB.ExecContext(ctx, `UPDATE links SET status='ready',error='',title=CASE WHEN title=url AND ?<>'' THEN ? ELSE title END,description=CASE WHEN description='' THEN ? ELSE description END,content=?,archive=? WHERE id=? AND url=? AND status='processing'`, title, title, description, content, archive, l.ID, l.URL)
	return e
}
