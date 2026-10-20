# Pocketmark Linux binary

Verify the downloaded archive against `SHA256SUMS` from the same GitHub release, then extract it and run `./pocketmark`. Linux AMD64 and ARM64 packages contain a static executable with SQLite/FTS5 embedded; Go, Node.js and an external database are not required at runtime.

By default, Pocketmark listens on `127.0.0.1:8090` and creates `./data`. Read `data/access-token` locally and paste it into the sign-in screen. Keep that file and the database private. Stop with Ctrl+C. For a different location or address, use `-data /your/data` and `-listen 127.0.0.1:8090`; see `./pocketmark -h`.

Remote access should use an HTTPS reverse proxy and the exact `POCKETMARK_ORIGIN`. Keep the default 32 MiB Go soft budget; it is not a total process-memory limit. For a hard 128 MiB container limit and full configuration/backup instructions, consult the repository's README and Compose file. Preserve the complete data directory when backing up a stopped server.

The ordinary and advanced extension ZIPs are separate release assets. Load an unpacked package manually. The advanced variant declares Chromium's debugger permission for PDF/full-page capture; install it only if you need and accept that access. Neither variant is installed automatically.
