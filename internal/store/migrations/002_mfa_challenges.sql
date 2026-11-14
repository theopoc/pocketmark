CREATE TABLE mfa_challenges (
    digest text PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('verify','enroll','replace')),
    salt text NOT NULL, username text NOT NULL, generation bigint NOT NULL,
    secret bytea, session_hash text NOT NULL, recovery_grant boolean NOT NULL,
    expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '5 minutes'),
    attempts integer NOT NULL DEFAULT 0, window_start timestamptz NOT NULL DEFAULT '-infinity'
);
ALTER TABLE mfa ADD COLUMN attempts integer NOT NULL DEFAULT 0,
                ADD COLUMN window_start timestamptz NOT NULL DEFAULT '-infinity';
