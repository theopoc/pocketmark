package store

import (
	"fmt"
)

// initLibraryTimestamps upgrades databases whose collections and tags did not
// record creation dates. Their original dates cannot be recovered: those rows
// receive the persisted upgrade date exactly once, as does the virtual Inbox.
// Insert triggers cover every writer, including imports and WebDAV sync.
func (s *Store) initLibraryTimestamps() error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`CREATE TABLE IF NOT EXISTS library_metadata(id INTEGER PRIMARY KEY CHECK(id=1),created_at TEXT NOT NULL);
INSERT OR IGNORE INTO library_metadata VALUES(1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
CREATE TABLE IF NOT EXISTS compat_tags(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE);`); err != nil {
		return err
	}
	backfill := false
	for _, table := range []string{"collections", "compat_tags"} {
		var exists int
		if err = tx.QueryRow("SELECT count(*) FROM pragma_table_info(?) WHERE name='created_at'", table).Scan(&exists); err != nil {
			return err
		}
		if exists == 0 {
			backfill = true
			if _, err = tx.Exec("ALTER TABLE " + table + " ADD COLUMN created_at TEXT NOT NULL DEFAULT ''"); err != nil {
				return err
			}
		}
	}
	var hasDescription int
	if err = tx.QueryRow("SELECT count(*) FROM pragma_table_info('collections') WHERE name='description'").Scan(&hasDescription); err != nil {
		return err
	}
	if hasDescription == 0 {
		// Older releases discarded collection descriptions. Existing rows start
		// empty; future writes retain them independently of names and hierarchy.
		if _, err = tx.Exec("ALTER TABLE collections ADD COLUMN description TEXT NOT NULL DEFAULT ''"); err != nil {
			return err
		}
	}
	if backfill {
		if _, err = tx.Exec(`INSERT OR IGNORE INTO compat_tags(name) SELECT DISTINCT value FROM links,json_each(links.tags);
UPDATE collections SET created_at=(SELECT created_at FROM library_metadata WHERE id=1) WHERE created_at='';
UPDATE compat_tags SET created_at=(SELECT created_at FROM library_metadata WHERE id=1) WHERE created_at='';`); err != nil {
			return err
		}
	}
	_, err = tx.Exec(`CREATE TRIGGER IF NOT EXISTS collections_created AFTER INSERT ON collections WHEN new.created_at='' BEGIN
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
	return tx.Commit()
}
