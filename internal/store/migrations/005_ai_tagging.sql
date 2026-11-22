-- Canonicalize legacy links and binary library restores as well as live writes.
-- pg_c_utf8 uses the same Unicode simple lowercase mapping as Go.
CREATE FUNCTION lowercase_link_tags(raw text) RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT coalesce(jsonb_agg(name ORDER BY first_at), '[]'::jsonb)
    FROM (
        SELECT lower(value COLLATE pg_c_utf8) AS name, min(ord) AS first_at
        FROM jsonb_array_elements_text(raw::jsonb) WITH ORDINALITY AS t(value, ord)
        GROUP BY lower(value COLLATE pg_c_utf8)
    ) AS names
$$;

DELETE FROM compat_tags WHERE id IN (
    SELECT id FROM (SELECT id, row_number() OVER
        (PARTITION BY lower(name COLLATE pg_c_utf8) ORDER BY id) AS seq FROM compat_tags) duplicates
    WHERE seq > 1
);
UPDATE compat_tags SET name=lower(name COLLATE pg_c_utf8) WHERE name<>lower(name COLLATE pg_c_utf8);
UPDATE links SET tags=lowercase_link_tags(tags)::text WHERE tags::jsonb<>lowercase_link_tags(tags);

CREATE FUNCTION canonicalize_link_tags() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF jsonb_typeof(NEW.tags::jsonb)='array' AND NOT EXISTS (
        SELECT FROM jsonb_array_elements(NEW.tags::jsonb) AS item WHERE jsonb_typeof(item)<>'string'
    ) THEN
        NEW.tags := lowercase_link_tags(NEW.tags)::text;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER canonicalize_link_tags BEFORE INSERT OR UPDATE OF tags ON links
FOR EACH ROW EXECUTE FUNCTION canonicalize_link_tags();

-- Custom/legacy backups do not record where displayed metadata came from.
-- Never classify an uploaded document's indexed title, description or body.
ALTER TABLE links ADD COLUMN ai_private_title boolean NOT NULL DEFAULT true,
    ADD COLUMN ai_private_description boolean NOT NULL DEFAULT true,
    ADD COLUMN ai_public_excerpt text CHECK (length(ai_public_excerpt)<=1024),
    ADD COLUMN ai_tag_revision bigint NOT NULL DEFAULT 0,
    ADD COLUMN ai_input_revision bigint NOT NULL DEFAULT 0;

CREATE FUNCTION invalidate_ai_tag_input() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- Older replicas do not annotate metadata filled from a browser upload.
    -- Carry the private default forward until a provenance-aware writer
    -- explicitly supplies a real title or description.
    IF NEW.title='' OR NEW.title=NEW.url THEN NEW.ai_private_title := true; END IF;
    IF NEW.description='' THEN NEW.ai_private_description := true; END IF;
    IF TG_OP='INSERT' THEN RETURN NEW; END IF;
    IF NEW.url <> OLD.url THEN NEW.ai_public_excerpt := NULL; END IF;
    IF (NEW.tags::jsonb,NEW.url) IS DISTINCT FROM (OLD.tags::jsonb,OLD.url) THEN
        NEW.ai_tag_revision := OLD.ai_tag_revision+1;
    END IF;
    IF (NEW.title,NEW.description,NEW.ai_private_title,NEW.ai_private_description,NEW.ai_public_excerpt)
       IS DISTINCT FROM (OLD.title,OLD.description,OLD.ai_private_title,OLD.ai_private_description,OLD.ai_public_excerpt) THEN
        NEW.ai_input_revision := OLD.ai_input_revision+1;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER invalidate_ai_tag_input BEFORE INSERT OR UPDATE OF url,tags,title,description,ai_private_title,ai_private_description,ai_public_excerpt ON links
FOR EACH ROW EXECUTE FUNCTION invalidate_ai_tag_input();

CREATE TABLE ai_tag_credentials (
    id integer PRIMARY KEY CHECK (id=1), envelope bytea NOT NULL
);

CREATE TABLE ai_tag_settings (
    id integer PRIMARY KEY CHECK (id=1),
    enabled boolean NOT NULL DEFAULT false,
    model text NOT NULL DEFAULT '',
    blocked text NOT NULL DEFAULT '' CHECK (blocked IN ('','quota','reconnect','error')),
    resume_at timestamptz,
    scan_total bigint NOT NULL DEFAULT -1
);

CREATE TABLE ai_tag_jobs (
    link_id bigint PRIMARY KEY REFERENCES links ON DELETE CASCADE,
    url_hash bytea NOT NULL,
    manual boolean NOT NULL DEFAULT false,
    queued timestamptz NOT NULL DEFAULT now(),
    lease uuid,
    lease_revision bigint NOT NULL DEFAULT -1,
    lease_until timestamptz
);
CREATE INDEX ai_tag_in_flight ON ai_tag_jobs(lease_until) WHERE lease IS NOT NULL;
CREATE INDEX ai_tag_scan_members ON ai_tag_jobs(link_id) WHERE manual;
