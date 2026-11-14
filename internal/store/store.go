package store

import (
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"pocketmark/internal/fault"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

// Store owns the PostgreSQL connection pool, complete schema and disk-backed work files.
// A successful Open is sufficient for every operation; HTTP construction never
// initializes or migrates persistence.
type Store struct {
	db          *sql.DB
	directory   string
	databaseURL string
}
type Link struct {
	captureAttempt   int64
	HasThumbnail     bool     `json:"hasThumbnail,omitempty"`
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
	SearchSnippet    string   `json:"searchSnippet,omitempty"`
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

func Open(databaseURL, directory string) (*Store, error) {
	if databaseURL == "" {
		return nil, errors.New("POCKETMARK_DATABASE_URL is required")
	}
	u, err := url.Parse(databaseURL)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") {
		return nil, errors.New("expected a PostgreSQL connection URI")
	}
	cfg, err := pgx.ParseConfig(databaseURL)
	if err != nil {
		return nil, errors.New("invalid PostgreSQL connection configuration")
	}
	directory, err = filepath.Abs(directory)
	if err != nil {
		return nil, err
	}
	if err = os.MkdirAll(directory, 0700); err != nil {
		return nil, err
	}
	db := stdlib.OpenDB(*cfg)
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(2)
	s := &Store{db: db, directory: directory, databaseURL: databaseURL}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if err = s.initializeSchema(ctx); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}
func (s *Store) Close() error { return s.db.Close() }

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
		return fault.Invalid("URL must be an http(s) address without credentials (maximum 4096 bytes)")
	}
	// A URL used as the automatic title is bounded by the URL limit above.
	// Accept it on edits/import too, so long URLs can round-trip losslessly.
	if (len(l.Title) > 1024 && l.Title != l.URL) || len(l.Description) > 8192 || len(l.Notes) > 65536 || len(l.Tags) > 32 {
		return fault.Invalid("field limit exceeded: title 1 KiB, description 8 KiB, notes 64 KiB, 32 tags")
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
			return fault.Invalid("tag exceeds 80 bytes")
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
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func Insert(ctx context.Context, ex executor, l Link) (int64, error) {
	return insertLink(ctx, ex, l, false)
}

func insertLink(ctx context.Context, ex executor, l Link, skipDuplicate bool) (int64, error) {
	if err := Normalize(&l); err != nil {
		return 0, err
	}
	tags, _ := json.Marshal(l.Tags)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	status := "pending"
	if IsFileURL(l.URL) {
		status = "ready"
	}
	query := `INSERT INTO links(url,title,description,notes,collection_id,tags,favorite,read,created_at,updated_at,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`
	if skipDuplicate {
		query += " ON CONFLICT (url_digest(url)) DO NOTHING"
	}
	var id int64
	err := ex.QueryRowContext(ctx, query+" RETURNING id", l.URL, l.Title, l.Description, l.Notes, l.CollectionID, string(tags), l.Favorite, l.Read, now, now, status).Scan(&id)
	return id, err
}
func (s *Store) Create(ctx context.Context, l Link) (int64, error) { return Insert(ctx, s.db, l) }
func (s *Store) Update(ctx context.Context, id int64, l Link) error {
	var oldURL string
	if e := s.db.QueryRowContext(ctx, "SELECT url FROM links WHERE id=$1", id).Scan(&oldURL); e != nil {
		return e
	}
	if (IsFileURL(oldURL) || IsFileURL(l.URL)) && oldURL != l.URL {
		return fault.Invalid("a file document identifier cannot be changed")
	}

	if err := Normalize(&l); err != nil {
		return err
	}
	tags, _ := json.Marshal(l.Tags)
	r, err := s.db.ExecContext(ctx, `UPDATE links SET title=$1,description=$2,notes=$3,collection_id=$4,tags=$5,favorite=$6,read=$7,updated_at=$8,
 status=CASE WHEN url<>$9 THEN 'pending' ELSE status END,error=CASE WHEN url<>$10 THEN '' ELSE error END,
 content=CASE WHEN url<>$11 THEN '' ELSE content END,archive=CASE WHEN url<>$12 THEN NULL ELSE archive END,url=$13 WHERE id=$14`, l.Title, l.Description, l.Notes, l.CollectionID, string(tags), l.Favorite, l.Read, time.Now().UTC().Format(time.RFC3339Nano), l.URL, l.URL, l.URL, l.URL, l.URL, id)
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
	r, e := s.db.ExecContext(ctx, "DELETE FROM links WHERE id=$1", id)
	return affected(r, e)
}

const columns = `l.id,l.url,l.title,l.description,l.notes,l.collection_id,l.tags,l.favorite,l.read,l.status,l.error,l.archive IS NOT NULL,l.created_at,l.updated_at`

type scanner interface{ Scan(...any) error }

func scan(row scanner, withContent bool, extra ...any) (Link, error) {
	var l Link
	var tags string
	dst := []any{&l.ID, &l.URL, &l.Title, &l.Description, &l.Notes, &l.CollectionID, &tags, &l.Favorite, &l.Read, &l.Status, &l.Error, &l.ArchiveAvailable, &l.CreatedAt, &l.UpdatedAt}
	if withContent {
		dst = append(dst, &l.Content)
	}
	dst = append(dst, extra...)
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
	return scan(s.db.QueryRowContext(ctx, "SELECT "+columns+",l.content FROM links l WHERE id=$1", id), true)
}
func (s *Store) List(ctx context.Context, f Filter) (Page, error) {
	if f.Page < 1 {
		f.Page = 1
	}
	p := Page{Links: []Link{}, Page: f.Page, PageSize: 40}
	where := " WHERE 1=1"
	args := []any{}
	bind := func(value any) string {
		args = append(args, value)
		return "$" + strconv.Itoa(len(args))
	}
	snippet := ",''"
	if len(f.Query) > 512 {
		return p, fault.Invalid("query exceeds 512 bytes")
	}
	terms := strings.FieldsFunc(f.Query, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) })
	if len(terms) > 0 {
		termsArg := bind(terms)
		q := "to_tsquery('pocketmark_search',lower(unaccent(array_to_string(" + termsArg + "::text[],':* & ')) COLLATE pg_unicode_fast) || ':*')"
		exact := "l.search_vector @@ " + q
		where += " AND (" + exact
		if f.Fuzzy {
			where += " OR near_metadata(" + termsArg + ",concat_ws(' ',l.title,l.url,l.description,l.notes,l.tags))"
		}
		where += ")"
		snippet = ",CASE WHEN " + exact + " THEN search_excerpt(ARRAY[l.title,l.url,l.description,l.notes,l.tags,l.content]," + termsArg + ") ELSE '' END"

	} else if strings.TrimSpace(f.Query) != "" {
		where += " AND false"
	}
	if f.Collection == "0" {
		where += " AND l.collection_id IS NULL"
	} else if f.Collection != "" {
		where += " AND l.collection_id=" + bind(f.Collection)
	}
	if f.Tag != "" {
		where += " AND jsonb_exists(l.tags::jsonb," + bind(f.Tag) + ")"
	}
	if f.Favorite {
		where += " AND l.favorite"
	}
	if f.Unread {
		where += " AND NOT l.read"
	}
	if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM links l"+where, args...).Scan(&p.Total); err != nil {
		return p, err
	}
	limit := bind(p.PageSize)
	offset := bind((f.Page - 1) * p.PageSize)
	order := map[string]string{"": "l.id DESC", "newest": "link_instant(l.created_at) DESC,l.id DESC", "oldest": "link_instant(l.created_at),l.id", "title": "lower(l.title),l.id", "title_desc": "lower(l.title) DESC,l.id", "updated": "link_instant(l.updated_at) DESC,l.id DESC"}[f.Sort]
	if order == "" {
		return p, fault.Invalid("invalid sort")
	}
	rows, err := s.db.QueryContext(ctx, "SELECT "+columns+snippet+",EXISTS(SELECT 1 FROM thumbnails t WHERE t.link_id=l.id) FROM links l"+where+" ORDER BY "+order+" LIMIT "+limit+" OFFSET "+offset, args...)
	if err != nil {
		return p, err
	}
	defer rows.Close()
	for rows.Next() {
		var excerpt string
		var hasThumbnail bool
		l, err := scan(rows, false, &excerpt, &hasThumbnail)
		l.HasThumbnail = hasThumbnail
		if err != nil {
			return p, err
		}
		l.SearchSnippet = excerpt
		p.Links = append(p.Links, l)
	}
	return p, rows.Err()
}
func (s *Store) Collections(ctx context.Context) ([]Collection, error) {
	rows, e := s.db.QueryContext(ctx, "SELECT id,name,parent_id,description FROM collections ORDER BY lower(name),id")
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
		return 0, fault.Invalid("collection name must be 1–120 bytes")
	}
	if c.Description != nil && len(*c.Description) > 8192 {
		return 0, fault.Invalid("collection description exceeds 8 KiB")
	}
	var id int64
	e := s.db.QueryRowContext(ctx, "INSERT INTO collections(name,parent_id,description) VALUES($1,$2,COALESCE($3,'')) RETURNING id", c.Name, c.ParentID, c.Description).Scan(&id)
	return id, e
}
func (s *Store) DeleteCollection(ctx context.Context, id int64) error {
	r, e := s.db.ExecContext(ctx, "DELETE FROM collections WHERE id=$1", id)
	return affected(r, e)
}
func (s *Store) Queue(ctx context.Context, id int64) error {
	r, e := s.db.ExecContext(ctx, "UPDATE links SET status='pending',error='' WHERE id=$1 AND status<>'processing' AND url NOT LIKE 'pocketmark-file:%'", id)
	return affected(r, e)
}
func (s *Store) Next(ctx context.Context) (Link, error) {
	// Expired reservations can be reclaimed after a worker disappears.
	// Incrementing the attempt fences an earlier worker that finishes late.
	var l Link
	var tags string
	err := s.db.QueryRowContext(ctx, `UPDATE links SET status='processing', capture_until=now()+interval '2 minutes',capture_attempt=capture_attempt+1
WHERE id=(SELECT id FROM links WHERE (status='pending' OR (status='processing' AND capture_until <= now()))
AND url NOT LIKE 'pocketmark-file:%' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
RETURNING id,url,title,description,notes,collection_id,tags,favorite,read,status,error,archive IS NOT NULL,created_at,updated_at,capture_attempt`).
		Scan(&l.ID, &l.URL, &l.Title, &l.Description, &l.Notes, &l.CollectionID, &tags, &l.Favorite, &l.Read, &l.Status, &l.Error, &l.ArchiveAvailable, &l.CreatedAt, &l.UpdatedAt, &l.captureAttempt)
	l.Type = "url"
	if err == nil {
		err = json.Unmarshal([]byte(tags), &l.Tags)
	}
	return l, err
}
func (s *Store) Finish(ctx context.Context, l Link, title, description, content string, archive []byte, fetchErr error, thumbnail ...[]byte) error {
	if fetchErr != nil {
		_, e := s.db.ExecContext(ctx, "UPDATE links SET status='failed',error=$1 WHERE id=$2 AND url=$3 AND status='processing' AND capture_attempt=$4", fetchErr.Error(), l.ID, l.URL, l.captureAttempt)
		return e
	}
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	result, e := tx.ExecContext(ctx, `UPDATE links SET status='ready',error='',title=CASE WHEN title=url AND $1<>'' THEN $2 ELSE title END,description=CASE WHEN description='' THEN $3 ELSE description END,content=$4,archive=$5 WHERE id=$6 AND url=$7 AND status='processing' AND capture_attempt=$8`, title, title, description, content, archive, l.ID, l.URL, l.captureAttempt)
	if e != nil {
		return e
	}
	changed, e := result.RowsAffected()
	if e != nil {
		return e
	}
	if changed > 0 && len(thumbnail) > 0 {
		if len(thumbnail[0]) > 512<<10 {
			return errors.New("thumbnail exceeds 512 KiB")
		}
		if _, e = tx.ExecContext(ctx, "DELETE FROM thumbnails WHERE link_id=$1", l.ID); e != nil {
			return e
		}
		if len(thumbnail[0]) > 0 {
			if _, e = tx.ExecContext(ctx, "INSERT INTO thumbnails(link_id,data) VALUES($1,$2)", l.ID, thumbnail[0]); e != nil {
				return e
			}
		}
	}
	return tx.Commit()
}
