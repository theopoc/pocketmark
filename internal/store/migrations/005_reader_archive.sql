ALTER TABLE links ADD COLUMN reader_archive bytea
    CHECK (reader_archive IS NULL OR (archive IS NOT NULL AND octet_length(reader_archive) BETWEEN 1 AND 2097216));

-- A replica already running schema 4 can still replace or clear the original
-- during a rolling upgrade. Its UPDATE does not know about the reading copy.
CREATE FUNCTION discard_stale_reader_archive() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.reader_archive := NULL;
    RETURN NEW;
END;
$$;
CREATE TRIGGER discard_stale_reader_archive BEFORE UPDATE OF archive, url ON links
    FOR EACH ROW WHEN (NEW.reader_archive IS NOT NULL AND
        (NEW.url IS DISTINCT FROM OLD.url OR NEW.archive IS DISTINCT FROM OLD.archive) AND
        NEW.reader_archive IS NOT DISTINCT FROM OLD.reader_archive)
    EXECUTE FUNCTION discard_stale_reader_archive();
