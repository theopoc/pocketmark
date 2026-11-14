# Pocketmark Linux binary

Verify the downloaded archive against `SHA256SUMS` from the same GitHub release, then extract it and run `./pocketmark`. Linux AMD64 and ARM64 packages contain a static executable with an embedded web interface. Provide PostgreSQL 18, the unaccent and fuzzystrmatch extensions, and a PostgreSQL client installation with pg_dump. Set POCKETMARK_DATABASE_URL to the dedicated database URI before starting. Existing SQLite users must migrate the library before upgrading (docs/MIGRATION_POSTGRESQL.md in the source repository).

By default, Pocketmark listens on `127.0.0.1:8090` and creates `./data`. On an empty installation, create your username and password, enroll an authenticator and save the recovery codes before exposing the server. The automatically generated `data/server-secret` protects TOTP and sessions. Keep it and the database private. Stop with Ctrl+C. For a different location or address, use `-data /your/data` and `-listen 127.0.0.1:8090`; see `./pocketmark -h`.

Remote access should use an HTTPS reverse proxy and the exact `POCKETMARK_ORIGIN`. Keep the default 32 MiB Go soft budget; it is not a total process-memory limit. For a hard 128 MiB container limit and full configuration/backup instructions, consult the repository's README and Compose file. Back up PostgreSQL and preserve the original server secret.

The single `pocketmark-extension.zip` contains the personal Chrome extension. Extract it, enable Developer mode at `chrome://extensions` and choose **Load unpacked** with the extracted folder. It declares Chrome's debugger permission for on-demand captures; connect it with your server address and a dedicated API key. It is never installed automatically.

Existing installations retain their original secret to preserve MFA; the former administrator bearer is no longer accepted. Replace any integration using it with a dedicated API key.
