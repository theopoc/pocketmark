package store

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/stdlib"
	"pocketmark/internal/backup"
	"pocketmark/internal/fault"
)

type Manifest struct {
	Format                string
	Version               int
	Mode                  string
	Text, Archives, Files bool
}
type section struct{ name, cols, query string }

func sections(m Manifest) []section {
	text, archive := "''::text", "NULL::bytea"
	if m.Text {
		text = "content"
	}
	if m.Archives {
		archive = "archive"
	}
	const webHTML = "(kind IN ('html','offline') AND EXISTS(SELECT FROM links WHERE links.id=assets.link_id AND url NOT LIKE 'pocketmark-file:%'))"
	filter := "TRUE"
	if !m.Files && !m.Archives {
		filter = "false"
	} else if !m.Files {
		filter = webHTML
	} else if !m.Archives {
		filter = "NOT " + webHTML
	}
	const lc = "id,url,title,description,notes,collection_id,tags,favorite,read,status,created_at,updated_at"
	const ac = "id,link_id,name,media_type,kind,size,created_at"
	linkColumns := lc + ",content,archive"
	linkValues := strings.Replace(lc, ",status,", ",CASE WHEN status='processing' THEN 'pending' ELSE status END,", 1) + "," + text + "," + archive
	if m.Version >= 2 {
		linkColumns += ",ai_private_title,ai_private_description,ai_public_excerpt"
		excerpt := "NULL::text"
		if m.Text {
			excerpt = "ai_public_excerpt"
		}
		linkValues += ",ai_private_title,ai_private_description," + excerpt
	}
	if m.Version == 3 && m.Archives {
		linkColumns += ",reader_archive"
		linkValues += ",reader_archive"
	}
	list := []section{{"collections", "id,name,parent_id,description,created_at", ""}, {"links", linkColumns, "SELECT " + linkValues + " FROM links"}, {"annotations", "id,link_id,quote,start_offset,end_offset,note,color,created_at", ""}}
	if m.Archives || m.Files {
		list = append(list, section{"assets", ac, "SELECT " + ac + " FROM assets WHERE " + filter}, section{"asset_chunks", "asset_id,ordinal,data", "SELECT asset_id,ordinal,data FROM asset_chunks JOIN assets ON id=asset_id WHERE " + filter})
	}
	if m.Files {
		list = append(list, section{"thumbnails", "link_id,data", ""})
	}
	return list
}
func (s *Store) libraryTx(ctx context.Context, opts pgx.TxOptions, fn func(pgx.Tx) error) error {
	c, e := s.db.Conn(ctx)
	if e != nil {
		return e
	}
	defer c.Close()
	return c.Raw(func(driver any) error { return pgx.BeginTxFunc(ctx, driver.(*stdlib.Conn).Conn(), opts, fn) })
}
func (s *Store) LibraryBackup(ctx context.Context, z *zip.Writer, c backup.Config) error {
	m := Manifest{"pocketmark-library", 2, "library", c.Text, c.Archives, c.Files}
	if c.Archives {
		m.Version = 3
	}
	w, e := z.Create("manifest.json")
	if e != nil {
		return e
	}
	if e = json.NewEncoder(w).Encode(m); e != nil {
		return e
	}
	return s.libraryTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}, func(tx pgx.Tx) error {
		for _, part := range sections(m) {
			query := part.query
			if query == "" {
				query = "SELECT " + part.cols + " FROM " + part.name
			}
			w, e := z.CreateHeader(&zip.FileHeader{Name: part.name + ".bin", Method: zip.Store})
			if e != nil {
				return e
			}
			if _, e = tx.Conn().PgConn().CopyTo(ctx, w, "COPY ("+query+") TO STDOUT (FORMAT binary)"); e != nil {
				return e
			}
		}
		return nil
	})
}

// Pocketmark writes a single-disk ZIP without a comment. Bound the central
// directory before archive/zip allocates one File per entry, including ZIP64.
func OpenLibraryZip(r io.ReaderAt, size int64) (*zip.Reader, error) {
	invalid := errors.New("invalid library ZIP directory")
	if size < 22 {
		return nil, invalid
	}
	end := make([]byte, 22)
	if _, e := r.ReadAt(end, size-22); e != nil {
		return nil, e
	}
	le := binary.LittleEndian
	if le.Uint32(end) != 0x06054b50 || le.Uint32(end[4:]) != 0 || le.Uint16(end[20:]) != 0 {
		return nil, invalid
	}
	count := uint64(le.Uint16(end[10:]))
	length := uint64(le.Uint32(end[12:]))
	offset := uint64(le.Uint32(end[16:]))
	limit := uint64(size - 22)
	if offset == 0xffffffff || length == 0xffffffff || count == 65535 {
		if size < 98 {
			return nil, invalid
		}
		footer := make([]byte, 76)
		if _, e := r.ReadAt(footer, size-98); e != nil {
			return nil, e
		}
		if le.Uint32(footer) != 0x06064b50 || le.Uint64(footer[4:]) != 44 || le.Uint32(footer[56:]) != 0x07064b50 || le.Uint64(footer[64:]) != uint64(size-98) {
			return nil, invalid
		}
		count = le.Uint64(footer[32:])
		length = le.Uint64(footer[40:])
		offset = le.Uint64(footer[48:])
		limit = uint64(size - 98)
	}
	if count > 10 || length > 65536 || offset > limit || length != limit-offset {
		return nil, invalid
	}
	return zip.NewReader(r, size)
}
func ReadManifest(z *zip.Reader) (Manifest, error) {
	var m Manifest
	if len(z.File) > 10 {
		return m, errors.New("unexpected archive entries")
	}
	f, e := z.Open("manifest.json")
	if e != nil {
		return m, errors.New("missing library manifest")
	}
	defer f.Close()
	raw, e := io.ReadAll(io.LimitReader(f, 4097))
	if e != nil || len(raw) > 4096 {
		return m, errors.New("invalid manifest size")
	}
	e = json.Unmarshal(raw, &m)
	if e != nil || m.Format != "pocketmark-library" || m.Version < 1 || m.Version > 3 || m.Mode != "library" {
		return m, errors.New("unsupported library archive")
	}
	files := map[string]bool{"manifest.json": true}
	for _, s := range sections(m) {
		files[s.name+".bin"] = true
	}
	for _, part := range z.File {
		if !files[part.Name] || part.UncompressedSize64 > backup.MaxLibraryZIP || part.Name != "manifest.json" && part.Method != zip.Store {
			return m, errors.New("invalid archive entry")
		}
		delete(files, part.Name)
	}
	if len(files) > 0 {
		return m, errors.New("incomplete archive")
	}
	return m, nil
}

// Validate PostgreSQL binary COPY frames in a bounded, streaming pass before
// handing them to the database. The writer emits no header flags or extension.
func validateSection(z *zip.Reader, part section) error {
	f, e := z.Open(part.name + ".bin")
	if e != nil {
		return e
	}
	defer f.Close()
	r := bufio.NewReader(f)
	var header [19]byte
	if _, e = io.ReadFull(r, header[:]); e != nil || !bytes.Equal(header[:], []byte("PGCOPY\n\xff\r\n\x00\x00\x00\x00\x00\x00\x00\x00\x00")) {
		return errors.New("invalid section header")
	}
	cols := strings.Split(part.cols, ",")
	var raw [4]byte
	for {
		if _, e = io.ReadFull(r, raw[:2]); e != nil {
			return e
		}
		n := int(binary.BigEndian.Uint16(raw[:2]))
		if n == 65535 {
			if _, e = r.ReadByte(); e == io.EOF {
				return nil
			}
			return errors.New("invalid section trailer")
		}
		if n != len(cols) {
			return errors.New("invalid section columns")
		}
		for _, col := range cols {
			if _, e = io.ReadFull(r, raw[:]); e != nil {
				return e
			}
			n := int32(binary.BigEndian.Uint32(raw[:]))
			if n == -1 {
				continue
			}
			limit := 65536
			switch col {
			case "archive":
				limit = 20 << 20
			case "reader_archive":
				limit = (2 << 20) + 64 // Article HTML plus its optional charset declaration.
			case "ai_public_excerpt":
				limit = 4096
			case "content":
				limit = 256 << 10
			case "data":
				if part.name == "thumbnails" {
					limit = 512 << 10
				}
			}
			if n < 0 || int64(n) > int64(limit) {
				return errors.New("backup field exceeds size limit")
			}
			if _, e = io.CopyN(io.Discard, r, int64(n)); e != nil {
				return e
			}
		}
	}
}

func validateRestoredLibrary(ctx context.Context, tx pgx.Tx) error {
	rows, e := tx.Query(ctx, `SELECT url,title,description,notes,tags FROM links`)
	if e != nil {
		return e
	}
	for rows.Next() {
		var l Link
		var tags string
		if e = rows.Scan(&l.URL, &l.Title, &l.Description, &l.Notes, &tags); e != nil {
			rows.Close()
			return e
		}
		if e = json.Unmarshal([]byte(tags), &l.Tags); e == nil {
			e = Normalize(&l)
		}
		if e != nil {
			rows.Close()
			return e
		}
	}
	rows.Close()
	if e = rows.Err(); e != nil {
		return e
	}
	var invalid bool
	e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT FROM assets a LEFT JOIN LATERAL
 (SELECT sum(octet_length(data)) AS size,min(ordinal) AS first,max(ordinal) AS last,count(*) AS chunks FROM asset_chunks WHERE asset_id=a.id) c ON true
 WHERE a.size NOT BETWEEN 1 AND $1 OR c.size IS DISTINCT FROM a.size OR c.first<>0 OR c.last<>c.chunks-1
 OR a.name='' OR octet_length(a.name)>240 OR strpos(a.name,chr(13))>0 OR strpos(a.name,chr(10))>0 OR strpos(a.name,'/')>0 OR strpos(a.name,chr(92))>0
 OR a.media_type NOT IN ('text/html','application/pdf','image/png','image/jpeg','image/gif','image/webp'))
 OR EXISTS(SELECT FROM assets GROUP BY link_id HAVING count(*)>32)
 OR EXISTS(SELECT FROM collections WHERE octet_length(name) NOT BETWEEN 1 AND 120 OR octet_length(description)>8192)
 OR (WITH RECURSIVE tree(id) AS (SELECT id FROM collections WHERE parent_id IS NULL UNION ALL
 SELECT c.id FROM collections c JOIN tree t ON c.parent_id=t.id) SELECT count(*) FROM tree)<>(SELECT count(*) FROM collections)`, MaxAssetSize).Scan(&invalid)
	if e == nil && invalid {
		return fault.Invalid("Invalid library hierarchy or attachment metadata")
	}
	return e
}

var ErrLibraryNotEmpty = errors.New("restore requires an empty library")

func (s *Store) RestoreLibrary(ctx context.Context, z *zip.Reader, m Manifest) error {
	for _, part := range sections(m) {
		if e := validateSection(z, part); e != nil {
			var fsErr *os.PathError
			if errors.As(e, &fsErr) {
				return e
			}
			return fault.Invalid("Invalid library section: " + part.name)
		}
	}
	return s.libraryTx(ctx, pgx.TxOptions{}, func(tx pgx.Tx) error {
		if _, e := tx.Exec(ctx, "LOCK TABLE collections, links IN ACCESS EXCLUSIVE MODE"); e != nil {
			return e
		}
		var occupied bool
		if e := tx.QueryRow(ctx, "SELECT EXISTS(SELECT FROM links) OR EXISTS(SELECT FROM collections)").Scan(&occupied); e != nil {
			return e
		}
		if occupied {
			return ErrLibraryNotEmpty
		}
		for _, part := range sections(m) {
			r, e := z.Open(part.name + ".bin")
			if e != nil {
				return e
			}
			_, e = tx.Conn().PgConn().CopyFrom(ctx, r, "COPY "+part.name+"("+part.cols+") FROM STDIN (FORMAT binary)")
			r.Close()
			if e != nil {
				var pgErr *pgconn.PgError
				if errors.As(e, &pgErr) && strings.HasPrefix(pgErr.Code, "22") {
					return fault.Invalid("Invalid library records in " + part.name)
				}
				return e
			}
			if strings.HasPrefix(part.cols, "id,") {
				var next int64
				if e = tx.QueryRow(ctx, "SELECT greatest(coalesce(max(id),0)+1,1) FROM "+part.name).Scan(&next); e != nil {
					return e
				}
				_, e = tx.Exec(ctx, fmt.Sprintf("ALTER TABLE %s ALTER COLUMN id RESTART WITH %d", part.name, next))
				if e != nil {
					return e
				}
			}
		}
		return validateRestoredLibrary(ctx, tx)
	})
}
