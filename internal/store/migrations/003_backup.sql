CREATE TABLE backup_settings (
 id integer PRIMARY KEY CHECK (id=1), instance uuid NOT NULL DEFAULT gen_random_uuid(),
 config jsonb NOT NULL, credentials bytea NOT NULL, next_at timestamptz
);
CREATE TABLE backup_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), trigger text NOT NULL,
 status text NOT NULL DEFAULT 'queued', config jsonb NOT NULL, credentials bytea NOT NULL,
 instance uuid NOT NULL, started timestamptz NOT NULL DEFAULT now(), finished timestamptz,
 attempt integer NOT NULL DEFAULT 0, due timestamptz NOT NULL DEFAULT now(), cancel boolean NOT NULL DEFAULT false,
 retry_allowed boolean NOT NULL DEFAULT true, object_key text NOT NULL DEFAULT '',
 stage text NOT NULL DEFAULT 'queued', bytes bigint NOT NULL DEFAULT 0, total bigint NOT NULL DEFAULT 0,
 diagnostic jsonb NOT NULL DEFAULT '{}', timings jsonb NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX backup_active ON backup_runs ((true)) WHERE finished IS NULL;
CREATE TABLE backup_objects (
 id uuid PRIMARY KEY, instance uuid NOT NULL, destination text NOT NULL, object_key text NOT NULL,
 verified timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX backup_object_age ON backup_objects(instance,destination,verified DESC);
CREATE TABLE backup_metrics (name text PRIMARY KEY, value bigint NOT NULL);

CREATE TABLE backup_pending (
 object_key text NOT NULL, instance uuid NOT NULL, destination text NOT NULL,
 PRIMARY KEY(instance,destination,object_key)
);
