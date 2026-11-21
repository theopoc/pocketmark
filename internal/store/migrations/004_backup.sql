CREATE TABLE backup_settings (
 id integer PRIMARY KEY CHECK (id=1),
 instance uuid NOT NULL DEFAULT gen_random_uuid(),
 revision uuid NOT NULL DEFAULT gen_random_uuid(),
 config jsonb NOT NULL, credentials bytea NOT NULL,
 effective_config jsonb NOT NULL, effective_credentials bytea NOT NULL,
 next_at timestamptz, missed_at timestamptz
);

CREATE TABLE backup_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 trigger text NOT NULL CHECK (trigger IN ('scheduled','manual')),
 status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','retry','cancelled','failed','succeeded','skipped')),
 config jsonb NOT NULL, credentials bytea NOT NULL, instance uuid NOT NULL,
 requested timestamptz NOT NULL DEFAULT clock_timestamp(),
 started timestamptz, deadline timestamptz, finished timestamptz, verified_at timestamptz,
 attempt integer NOT NULL DEFAULT 0, due timestamptz NOT NULL DEFAULT now(),
 cancel boolean NOT NULL DEFAULT false, object_key text NOT NULL DEFAULT '',
 stage text NOT NULL DEFAULT 'queued', bytes bigint NOT NULL DEFAULT 0, total bigint NOT NULL DEFAULT 0,
 diagnostic jsonb NOT NULL DEFAULT '{}', timings jsonb NOT NULL DEFAULT '{}',
 notification text NOT NULL DEFAULT '',
 CHECK (status <> 'succeeded' OR verified_at IS NOT NULL)
);
CREATE UNIQUE INDEX backup_active ON backup_runs(instance) WHERE started IS NOT NULL AND finished IS NULL;
CREATE UNIQUE INDEX backup_manual_queue ON backup_runs(instance) WHERE trigger='manual' AND started IS NULL AND finished IS NULL;
CREATE INDEX backup_recent ON backup_runs((finished IS NULL) DESC,coalesce(finished,requested) DESC,id DESC);

CREATE TABLE backup_objects (
 id uuid PRIMARY KEY, instance uuid NOT NULL, destination text NOT NULL,
 mode text NOT NULL, object_key text NOT NULL, version_id text NOT NULL DEFAULT '', verified timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX backup_object_age ON backup_objects(instance,destination,mode,verified);
CREATE TABLE backup_metrics (name text PRIMARY KEY, value bigint NOT NULL);

CREATE TABLE backup_pending (
 object_key text NOT NULL, instance uuid NOT NULL, destination text NOT NULL, mode text NOT NULL,
 PRIMARY KEY(instance,destination,mode,object_key)
);
CREATE TABLE backup_notifications (
 id uuid PRIMARY KEY REFERENCES backup_runs(id),
 config jsonb NOT NULL, credentials bytea NOT NULL, last_success bigint NOT NULL DEFAULT 0, claimed_at timestamptz
);
