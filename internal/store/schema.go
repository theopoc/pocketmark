package store

import (
	"context"
	"database/sql"
	"fmt"
)

// Open owns the entire schema lifecycle. Commit eligibility and feature schemas
// together so a failed upgrade cannot leave a partly initialized installation.
func (s *Store) initializeSchema(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx, "PRAGMA mmap_size=0; PRAGMA temp_store=FILE;"); err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(ctx, `
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
		return fmt.Errorf("initialize SQLite (build with -tags sqlite_fts5): %w", err)
	}
	// Check legacy eligibility before creating account or token tables.
	if _, err = tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS account_setup(id INTEGER PRIMARY KEY CHECK(id=1), allowed INTEGER NOT NULL);
 INSERT INTO account_setup(id,allowed) SELECT 1,
 NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('account','api_tokens'))
 AND NOT EXISTS(SELECT 1 FROM links) AND NOT EXISTS(SELECT 1 FROM collections)
 WHERE NOT EXISTS(SELECT 1 FROM account_setup);
 CREATE TABLE IF NOT EXISTS account(id INTEGER PRIMARY KEY CHECK(id=1),username TEXT NOT NULL,salt TEXT NOT NULL,hash TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS api_tokens(id INTEGER PRIMARY KEY,name TEXT NOT NULL,hash TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL);`); err != nil {
		return fmt.Errorf("initialize account schema: %w", err)
	}
	if err = initLibraryTimestamps(ctx, tx); err != nil {
		return err
	}
	if err = initAssets(ctx, tx); err != nil {
		return fmt.Errorf("initialize attachments: %w", err)
	}
	if err = initDAV(ctx, tx); err != nil {
		return fmt.Errorf("initialize WebDAV: %w", err)
	}
	return tx.Commit()
}

// initLibraryTimestamps upgrades databases whose collections and tags did not
// record creation dates. Their original dates cannot be recovered: those rows
// receive the persisted upgrade date exactly once, as does the virtual Inbox.
// Insert triggers cover every writer, including imports and WebDAV sync.
func initLibraryTimestamps(ctx context.Context, tx *sql.Tx) error {
	var err error
	if _, err = tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS library_metadata(id INTEGER PRIMARY KEY CHECK(id=1),created_at TEXT NOT NULL);
INSERT OR IGNORE INTO library_metadata VALUES(1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
CREATE TABLE IF NOT EXISTS compat_tags(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE);`); err != nil {
		return err
	}
	backfill := false
	for _, table := range []string{"collections", "compat_tags"} {
		var exists int
		if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM pragma_table_info(?) WHERE name='created_at'", table).Scan(&exists); err != nil {
			return err
		}
		if exists == 0 {
			backfill = true
			if _, err = tx.ExecContext(ctx, "ALTER TABLE "+table+" ADD COLUMN created_at TEXT NOT NULL DEFAULT ''"); err != nil {
				return err
			}
		}
	}
	var hasDescription int
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM pragma_table_info('collections') WHERE name='description'").Scan(&hasDescription); err != nil {
		return err
	}
	if hasDescription == 0 {
		// Older releases discarded collection descriptions. Existing rows start
		// empty; future writes retain them independently of names and hierarchy.
		if _, err = tx.ExecContext(ctx, "ALTER TABLE collections ADD COLUMN description TEXT NOT NULL DEFAULT ''"); err != nil {
			return err
		}
	}
	if backfill {
		if _, err = tx.ExecContext(ctx, `INSERT OR IGNORE INTO compat_tags(name) SELECT DISTINCT value FROM links,json_each(links.tags);
UPDATE collections SET created_at=(SELECT created_at FROM library_metadata WHERE id=1) WHERE created_at='';
UPDATE compat_tags SET created_at=(SELECT created_at FROM library_metadata WHERE id=1) WHERE created_at='';`); err != nil {
			return err
		}
	}
	_, err = tx.ExecContext(ctx, `CREATE TRIGGER IF NOT EXISTS collections_created AFTER INSERT ON collections WHEN new.created_at='' BEGIN
 UPDATE collections SET created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=new.id;
END;
CREATE TRIGGER IF NOT EXISTS compat_tags_created AFTER INSERT ON compat_tags WHEN new.created_at='' BEGIN
 UPDATE compat_tags SET created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=new.id;
END;
CREATE TRIGGER IF NOT EXISTS link_tags_created AFTER INSERT ON links BEGIN
 INSERT OR IGNORE INTO compat_tags(name) SELECT value FROM json_each(new.tags);
END;
CREATE TRIGGER IF NOT EXISTS link_tags_updated AFTER UPDATE OF tags ON links BEGIN
 INSERT OR IGNORE INTO compat_tags(name) SELECT value FROM json_each(new.tags);
END;`)
	if err != nil {
		return fmt.Errorf("initialize library creation timestamps: %w", err)
	}
	return nil
}

func initAssets(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS assets(
id INTEGER PRIMARY KEY, link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
name TEXT NOT NULL, media_type TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS assets_link ON assets(link_id,id);
CREATE TABLE IF NOT EXISTS asset_chunks(asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(asset_id,ordinal));`)
	return err
}

func initDAV(ctx context.Context, tx *sql.Tx) error {
	_, e := tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS dav_revision(id INTEGER PRIMARY KEY CHECK(id=1),value INTEGER NOT NULL,modified INTEGER NOT NULL);
INSERT OR IGNORE INTO dav_revision VALUES(1,0,unixepoch());
CREATE TABLE IF NOT EXISTS dav_ids(id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,local_id INTEGER NOT NULL,position INTEGER NOT NULL DEFAULT 2147483647,UNIQUE(kind,local_id));
CREATE TABLE IF NOT EXISTS dav_files(name TEXT PRIMARY KEY,size INTEGER NOT NULL,etag TEXT NOT NULL,modified INTEGER NOT NULL,revision INTEGER NOT NULL,owner TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS dav_chunks(name TEXT NOT NULL REFERENCES dav_files(name) ON DELETE CASCADE,ordinal INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(name,ordinal));
CREATE TABLE IF NOT EXISTS dav_lock(id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT NOT NULL,modified INTEGER NOT NULL,revision INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS dav_observed(owner TEXT PRIMARY KEY,revision INTEGER NOT NULL);
CREATE TRIGGER IF NOT EXISTS dav_li AFTER INSERT ON links BEGIN UPDATE dav_revision SET value=value+1,modified=unixepoch() WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS dav_lu AFTER UPDATE OF url,title,description,collection_id ON links WHEN NEW.url IS NOT OLD.url OR NEW.title IS NOT OLD.title OR NEW.description IS NOT OLD.description OR NEW.collection_id IS NOT OLD.collection_id BEGIN UPDATE dav_revision SET value=value+1,modified=unixepoch() WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS dav_ld AFTER DELETE ON links BEGIN DELETE FROM dav_ids WHERE kind='bookmark' AND local_id=OLD.id;UPDATE dav_revision SET value=value+1,modified=unixepoch() WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS dav_ci AFTER INSERT ON collections BEGIN UPDATE dav_revision SET value=value+1,modified=unixepoch() WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS dav_cu AFTER UPDATE OF name,parent_id ON collections WHEN NEW.name IS NOT OLD.name OR NEW.parent_id IS NOT OLD.parent_id BEGIN UPDATE dav_revision SET value=value+1,modified=unixepoch() WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS dav_cd AFTER DELETE ON collections BEGIN DELETE FROM dav_ids WHERE kind='folder' AND local_id=OLD.id;UPDATE dav_revision SET value=value+1,modified=unixepoch() WHERE id=1; END;`)
	return e
}
