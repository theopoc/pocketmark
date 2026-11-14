# Migrating a Pocketmark library to PostgreSQL

This is a breaking storage change. The server now requires PostgreSQL. New installations can start with Compose. Existing installations need a one-time offline migration to preserve their library, file bytes, search, account, API keys, MFA and Floccus identities. JSON and HTML bookmark exports omit private files and authentication records.

1. Upgrade older SQLite installations to Pocketmark 1.3.4 first and start that version once so it finishes its schema upgrades. Stop incoming writes and stop the old server. Make a private backup of the entire data directory, including any WAL files and the original server secret. Preserve the value separately if the service used POCKETMARK_TOKEN.
2. Create a dedicated empty PostgreSQL 18 database with a UTF-8 encoding. The owner needs permission to create the trusted extensions unaccent and fuzzystrmatch. For Compose, set POCKETMARK_DB_PASSWORD in a private .env as shown in the README. Start only the database with `docker compose up -d --wait postgres`. Keep database ports private.
3. Run the migration from the checked-out new source with Python 3 and PostgreSQL 18 client tools. Supply a stopped, read-only copy of the complete old data directory. For an existing PostgreSQL service, configure libpq authentication and run:

   ```sh
   export PGDATABASE=pocketmark PGUSER=pocketmark PGHOST=your-postgres-host
   python3 scripts/migrate_sqlite.py /path/to/old-data/pocketmark.db
   ```

   For the supplied Compose stack, use `python3 scripts/migrate_sqlite.py --compose /path/to/old-data/pocketmark.db`. This uses the client in the database container without publishing a port. The new Compose file mounts a separate application volume (`pocketmark-state`); keep the old `pocketmark-data` volume for rollback.

   The importer refuses a populated destination, checks source integrity, streams rows including binary chunks, verifies row counts, restores sequence counters and commits in one transaction. It rebuilds search indexes and requeues interrupted captures. On error, retain the original and retry against an empty destination. A native ZIP from the previous version contains a standalone pocketmark.db suitable for this procedure, with the session/MFA restore semantics of that ZIP.
   PostgreSQL text requires UTF-8 without embedded NUL characters. If the importer reports incompatible text, it identifies the source table, column and SQLite rowid. Review and correct that field on a separate copy, then retry. Binary files can contain any byte.
4. Prepare a new private application work directory or volume, writable by UID 10001 in the container. Put the original server-secret (or legacy access-token) there or supply the original POCKETMARK_TOKEN. For Compose, copy the original key from your private backup before first startup:

   ```sh
   docker compose build pocketmark
   docker compose run --rm --no-deps -T --entrypoint sh pocketmark \
     -ec 'umask 077; test ! -e /data/server-secret; cat > /data/server-secret' \
     < /path/to/old-data/server-secret
   ```

   Substitute the original access-token file as the input for older installations using that filename. Keep the old SQLite directory as a separate rollback copy. The new server refuses a work directory containing pocketmark.db.
5. Start Pocketmark against the migrated database, with the same public origin. Verify password and MFA sign-in, library counts, a saved search, an original PDF, attachment checksums, annotations and Floccus IDs before reopening writes. Make a new native backup and test restoration in a separate empty database.
6. To roll back before accepting new writes, stop the PostgreSQL-backed service, restore the old binary and point it at the original untouched SQLite directory and secret. Writes accepted after cutover exist only in PostgreSQL. Reconcile those writes before rolling back.
