#!/usr/bin/env python3
"""Import a stopped Pocketmark 1.3.4 library into an empty PostgreSQL database."""
import argparse
from contextlib import suppress, closing
import os
from pathlib import Path
import sqlite3
import subprocess
import sys


SCHEMA = Path(__file__).resolve().parents[1] / "internal/store/migrations/001_initial.sql"
# Explicit columns preserve application identities while excluding derived search data.
TABLES = {
    "account_setup": "id allowed",
    "account": "id username salt hash",
    "sessions": "id hash expires_at created_at last_used_at confirmed_at idle_minutes device recovery_until",
    "api_tokens": "id name hash created_at active last_used_at profile expires_at",
    "mfa": "id secret generation last_counter restored",
    "mfa_recovery": "hash",
    "library_metadata": "id created_at",
    "collections": "id name parent_id description created_at",
    "compat_tags": "id name created_at",
    "links": "id url title description notes collection_id tags favorite read status error content archive created_at updated_at",
    "annotations": "id link_id quote start_offset end_offset note color created_at",
    "thumbnails": "link_id data",
    "assets": "id link_id name media_type kind size created_at",
    "asset_chunks": "asset_id ordinal data",
    "dav_revision": "id value modified",
    "dav_ids": "id kind local_id position",
    "dav_files": "name size etag modified revision owner",
    "dav_chunks": "name ordinal data",
    "dav_lock": "id owner modified revision",
    "dav_observed": "owner revision",
}
IDENTITIES = ("collections", "compat_tags", "links", "annotations", "assets", "sessions", "api_tokens", "dav_ids")


def copy_field(value):
    if value is None:
        return r"\N"
    if isinstance(value, bytes):
        return r"\\x" + value.hex()
    if isinstance(value, str):
        if "\x00" in value:
            raise ValueError("text contains a NUL")
        value.encode("utf-8")  # PostgreSQL text requires valid UTF-8.
    return str(value).replace("\\", "\\\\").replace("\t", r"\t").replace("\n", r"\n").replace("\r", r"\r")


def import_library(source, output):
    def line(value):
        output.write((value + "\n").encode())

    source.execute("BEGIN")
    source.text_factory = lambda raw: raw.decode("utf-8", "surrogateescape")
    if source.execute("PRAGMA quick_check").fetchone() != ("ok",):
        raise ValueError("SQLite integrity check failed")
    if source.execute("PRAGMA foreign_key_check").fetchone() is not None:
        raise ValueError("SQLite foreign key check failed")
    for table, names in TABLES.items():
        source.execute(f"SELECT {','.join(names.split())} FROM {table} LIMIT 0")
    line("BEGIN;")
    line("SET LOCAL search_path TO public;")
    line("SELECT pg_advisory_xact_lock(1678904017);")
    line("""DO $$ BEGIN IF EXISTS (SELECT FROM pg_class WHERE relnamespace='public'::regnamespace
              AND relkind IN ('r','p','v','m','S','f')) THEN
              RAISE EXCEPTION 'Destination must be empty'; END IF; END $$;""")
    line(SCHEMA.read_text())
    line("CREATE TABLE pocketmark_migrations(version integer PRIMARY KEY);")
    line("INSERT INTO pocketmark_migrations VALUES(1);")
    line("TRUNCATE account_setup,mfa,library_metadata,dav_revision;")
    # Import original tag IDs and DAV revisions; keep FK and search triggers active.
    triggers = {"links": ("record_link_tags", "dav_link_change"), "collections": ("dav_collection_change",)}
    for table, names in triggers.items():
        for name in names:
            line(f"ALTER TABLE {table} DISABLE TRIGGER {name};")
    for table, names in TABLES.items():
        columns = ",".join(names.split())
        line(f"COPY {table} ({columns}) FROM STDIN;")
        count = 0
        for row in source.execute(f"SELECT rowid,{columns} FROM {table}"):
            fields = []
            for column, value in zip(names.split(), row[1:]):
                try:
                    fields.append(copy_field(value))
                except ValueError as exc:
                    raise ValueError(f"Incompatible text at {table}.{column}, SQLite rowid {row[0]}. "
                                     "Correct the field on a backup copy and retry.") from exc
            line("\t".join(fields))
            count += 1
        line(r"\.")
        line(f"DO $$ BEGIN IF (SELECT count(*) FROM {table}) <> {count} THEN RAISE EXCEPTION 'Row count mismatch: {table}'; END IF; END $$;")
    line("SET CONSTRAINTS ALL IMMEDIATE;")
    for table, names in triggers.items():
        for name in names:
            line(f"ALTER TABLE {table} ENABLE TRIGGER {name};")
    for table in IDENTITIES:
        high = source.execute("SELECT seq FROM sqlite_sequence WHERE name=?", (table,)).fetchone()
        floor = int(high[0]) if high else 0
        line(f"SELECT setval(pg_get_serial_sequence('{table}','id'),greatest(1,n),n>0) FROM (SELECT greatest({floor},coalesce(max(id),0)) AS n FROM {table}) s;")
    line("UPDATE links SET status='pending' WHERE status='processing';")
    line("COMMIT;")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Original pocketmark.db (read only)")
    parser.add_argument("--compose", action="store_true", help="Use psql in the Compose postgres service")
    args = parser.parse_args()
    if not args.compose and not os.environ.get("PGDATABASE"):
        parser.error("Set PGDATABASE to a new dedicated empty database and configure libpq authentication")
    client = (["docker", "compose", "exec", "-T", "postgres", "psql", "-U", "pocketmark", "-d", "pocketmark"]
              if args.compose else ["psql"])
    with closing(sqlite3.connect(args.source.resolve().as_uri() + "?mode=ro", uri=True)) as source:
        # Disable psql echo on failure: COPY rows may contain private data.
        with subprocess.Popen(client + ["-X", "-q", "-v", "ON_ERROR_STOP=1"], stdin=subprocess.PIPE,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) as process:
            try:
                import_library(source, process.stdin)
            except BrokenPipeError:
                pass  # psql already reported failure through its exit status.
            finally:
                with suppress(BrokenPipeError):
                    process.stdin.close()
            if process.wait():
                raise RuntimeError("PostgreSQL import failed. Check connectivity, an empty public schema, extension privileges and source compatibility.")
    print("Import committed. Preserve the original server secret before starting Pocketmark.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, sqlite3.Error, ValueError, RuntimeError) as exc:
        sys.exit(str(exc))
