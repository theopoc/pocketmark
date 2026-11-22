# Pocketmark guide

A personal bookmark manager built for low RAM usage: one Go executable, PostgreSQL and a small embedded web interface. Save links, organize collections and tags, search captured text, and import an existing bookmark library.

PostgreSQL stores the library. The Go process serves requests and handles capture. Public HTML capture runs on the server; JavaScript-rendered capture and screenshots run in your existing browser through the included extension. The personal Chrome extension uses the native API; Floccus synchronizes through WebDAV.

## Start locally

Requirements include Go from `go.mod`, Node.js 24, npm and Make. Start PostgreSQL 18 with a dedicated empty database owned by the application role. Its installation must provide the trusted extensions `unaccent` and `fuzzystrmatch`. Install PostgreSQL 18 client tools for native backup and restore. For the packaged database and client use the Compose quick start in the README.

```sh
export POCKETMARK_DATABASE_URL='postgresql://pocketmark@localhost/pocketmark'
# Configure the password in a private libpq password file.
make run
```

Open [http://127.0.0.1:8090](http://127.0.0.1:8090) and create your personal account. Register an authenticator app with the local QR code or setup key, verify a code and save the single-use recovery codes. On later visits, sign in with your username, password and an authentication or recovery code. In **Settings → API keys**, create an **Editor** key for the Pocketmark extension or a **Sync** key for Floccus. To revoke a key permanently, turn off its access switch and choose **Revoke**.

Existing installations keep their credentials and keys. Existing MFA and browser sessions remain valid when the original server secret is preserved. Legacy administrator bearer access is removed; create named API keys and update integrations before upgrading to avoid interruption. If no password was configured before upgrading, follow [account recovery](API.md#existing-installations-and-account-recovery); public account creation cannot claim an existing library.

Pocketmark uses the server secret to protect TOTP and session digests. It first reads `POCKETMARK_SERVER_SECRET`, then the legacy `POCKETMARK_TOKEN` if the preferred variable is empty. With both variables empty, it reads `server-secret` or the legacy `access-token` from the data directory (default `./data`). A new installation generates a private `server-secret` file (mode `0600`) when neither file exists. Keep the active secret separately from the database backup. Use the original value when changing how you supply it. Use named API keys for integrations.

Restrict access to an empty instance until account and MFA setup are complete. Stop with Ctrl+C. To run without fetching bookmarked pages:

```sh
./bin/pocketmark -no-capture
```

## Docker Compose

Set the database password as described in the [quick start](../README.md#quick-start).

```sh
docker compose up --build -d
```

Open the same local URL. Compose uses separate named volumes for PostgreSQL and the application work directory and publishes port 8090 on host loopback only. The image runs as UID/GID `10001:10001`; a custom bind-mounted data directory must be writable by that user.

Tagged releases also publish a private multiarchitecture image at `ghcr.io/theopoc/pocketmark:vMAJOR.MINOR.PATCH` for Linux AMD64/ARM64. After authenticating Docker with read access to the package, use that image in place of `build: .` in your Compose configuration. Keep the same volume, port binding and resource/security settings. See [GHCR publication and verification](RELEASE.md#ghcr-images).

The supplied Compose configuration sets a **128 MiB application container memory limit** and one CPU. This is a deployment limit, not a guarantee that every workload completes within it. See [memory measurement methodology](BENCHMARK.md) for workload boundaries.

PostgreSQL provides shared durable storage. Replicas using the same database and server secret can finish each other’s pending MFA sign-ins without session affinity. Configure readiness on `/healthz`; for an application rolling update, use at least two replicas and `maxUnavailable: 0`. Password and HTTP request limits remain per process; enforce ingress limits across replicas if needed.

On the first upgrade from schema 1, challenges already issued by the older binary exist only in its memory. Older pods also cannot verify a challenge issued by a new pod. While versions are mixed, a sign-in may need to restart; cross-pod verification works once all serving pods use the new version. The migration is additive, but the older binary cannot start against schema 2. Take a backup before upgrading.

Schema 3 adds an optional sign-in IP address to browser sessions. Existing sessions remain valid with an unknown address. A schema 2 binary cannot restart against schema 3. Finish upgrading all serving replicas to enforce the disable-before-revoke rule on every API key request.

Schema 6 adds an optional illustrated reading copy to automatic captures.
Original HTML, notes and existing attachments stay available. Recapturing a
bookmark can populate its reading copy. An older binary cannot reopen schema 6.
Schema 6 workers write format 3 library backups when archives are included and
format 2 otherwise. An already-running schema 5 worker can still claim a
scheduled backup and write format 2 with the original HTML. Once all older
workers have stopped, take a new backup to include both copies. Restore also
accepts formats 1 and 2.

### Route backups during a Kubernetes rollout

The first schema 5 startup lowercases existing tags and merges case variants. Take a backup before upgrading if you need the original spellings. Wait for all schema 4 pods and their scheduled backup workers to stop before connecting a ChatGPT account. Backup workers running schema 5 or later exclude AI credentials, settings and queued work from full backups.

Install the [backup Service, Ingress paths and NetworkPolicy](../deploy/kubernetes/backup-routing.yaml) **before** starting pods that migrate the schema. The exact path `/api/backup` and prefix `/api/backups` select only ready pods bearing the target revision label. The ordinary `pocketmark` ClusterIP Service continues to select all application pods for other requests.

Adapt the example to your namespace, existing host, TLS secret, Service port and controller labels. Merge the paths into the existing Ingress for that host and preserve its authentication and TLS settings. For Traefik, enable `providers.kubernetesIngress.allowEmptyServices=true` so that the exact path returns 503 while its Service is empty. With a controller that drops empty backends, the catch-all path could otherwise send the request to an old pod. Use a CNI enforcing NetworkPolicy, allow only the trusted ingress controller to reach the app port, and remove other access paths or additive policies that allow clients to reach the pods directly.

1. Set the backup Service selector to the incoming revision (`backup-schema-6` in the example). Keep this label off the running pods. Before the image rollout, verify that the backup Service has no ready endpoints. Check every serving ingress-controller replica individually with the production Host and TLS server name: an authenticated backup request must return 503 and an authenticated library read must succeed on each. Recheck any controller that joins during this step. Once the routing change has converged, let any backup requests already accepted by old pods finish.
2. Change the pinned image and the revision label **together** in the Deployment pod template. For example, with the verified image reference in `POCKETMARK_IMAGE` and a container named `pocketmark`:

   ```sh
   kubectl patch deployment pocketmark --type=strategic --patch-file=/dev/stdin <<EOF
   spec:
     template:
       metadata:
         labels:
           pocketmark-backup-revision: backup-schema-6
       spec:
         containers:
           - name: pocketmark
             image: "${POCKETMARK_IMAGE:?set the pinned new image}"
   EOF
   ```

3. As the first new pod passes its HTTP readiness probe, the backup Service begins serving exports. Check its EndpointSlices during rollout and download a backup through the configured host. For subsequent rollouts use a fresh revision value in both the Service selector and the pod template. If the rollout stalls or rolls back, keep the backup selector off images that cannot exclude pending challenges and backup credentials.

## What is included

- Bookmarks with descriptions, personal notes, favorite/read flags and tags.
- Nested collections, an inbox, filtering and 40-item paginated lists.
- Click a tag on a bookmark to filter the current view. Selecting more tags shows bookmarks that carry all of them. Use the × beside a tag above the results to remove that filter while keeping the others.
- PostgreSQL full-text search across title, URL, description, notes, tags and captured text. Search terms are combined with AND and match token prefixes; matching ignores case and common diacritics.
- A persistent, sequential capture queue; failed captures can be retried. Interrupted jobs resume after restart.
- Plain-text reading and downloadable original HTML for public HTML pages.
- Legacy JSON import, Pocketmark JSON export/import and an authenticated [HTTP API](API.md).
- Rename/move collections, atomic bulk actions, sorting and automatic typo-tolerant metadata matches alongside full-text search.
- Anchored highlights and annotations, with stale highlights identified after a page changes; a separate structural reader preserves headings, lists, code and tables.
- Browser bookmarks HTML import/export and WebDAV/XBEL synchronization for Floccus.
- PDF, image and SingleFile/HTML files (standalone or attached) streamed in 64 KiB PostgreSQL chunks; manual offline snapshots with embedded resources.
- Personal password and TOTP login, named revocable API keys and an owner-only full ZIP backup while the app runs.
- Installable mobile web interface, share target, and a small [browser extension](../extension/README.md). The Linkwarden compatibility API and third-party extension/mobile integration have been removed.

Default capture fetches one HTML response, with a 20-second timeout, at most five redirects, a 2 MiB response/decompressed-body limit and up to 256 KiB of extracted text. When adding or editing a bookmark, select **Save an HTML copy** for bounded resource embedding, or use the extension for an already-rendered page and a visible-tab PNG screenshot. The same Chrome extension generates PDF and full-page screenshots on demand, using an explicit debugger permission; [installation and limits](../extension/README.md). Select a bookmark to read its article. The HTML, screenshot and PDF icons open the corresponding saved copies. **Aa** changes the text size, and the fit-to-page icon expands the reader within the tab. Existing files can also be attached using the bookmark assets API. No Chromium instance runs on the server. Private, loopback and reserved network destinations can be bookmarked, but server capture refuses them. See [archive limits](ARCHIVES.md).

Collaboration/public sharing, SSO/OIDC, RSS and scheduled recapture are intentionally excluded. Screenshots and PDF rendering consume memory in the user's browser; their memory is not included in server measurements. See [client compatibility and verification](REAL_CLIENTS.md) for observed workflows and qualification limits. The supported integration paths are the Pocketmark Chrome extension and Floccus WebDAV; older Linkwarden client observations do not qualify the new extension.

## AI tagging

Open **Settings → AI tagging** on your personal instance. Connect your ChatGPT plan, complete consent on OpenAI's page, then copy the complete loopback return address from the browser back into Pocketmark. On a NAS the browser may report that the local page cannot be reached. The address still contains the authorization result. Paste it only into your Pocketmark settings. Choose a model from your account, test with the fictional example, then enable tagging. Usage counts against your connected ChatGPT plan.

New untagged website bookmarks saved from the web, browser extension or API are classified after saving. Pocketmark applies up to three lowercase English tags, regardless of the article’s language. It reuses relevant English tags, including technical names such as `kubernetes` and `c++`. If none fit, or the library has no tags yet, it can create new English tags from the article’s subject. Those tags become available for later bookmarks. Settings shows the eligible count before you scan the library, including imported and synced links. Removing the last tag makes a bookmark eligible for a future manual scan. Standalone files are excluded. Tags throughout the library use lowercase. Existing `AWS` and `aws` merge on upgrade. Spaces inside names are preserved.

Classification sends the domain, available bookmark title and description, a short excerpt from a public server capture when available, and candidate tag names. The worker waits up to 30 seconds for a pending capture, then uses the available metadata. A bare domain is insufficient. Each request includes at most 1,024 characters of captured text and 256 tag names. Pocketmark checks names mentioned in the bookmark and frequently used tags first. For larger libraries, it checks the remaining names in batches before creating a tag. These extra requests count against the connected plan. Personal notes, URL parameters, uploaded HTML text and attachments stay on the instance. For older bookmarks with uncertain capture provenance, Pocketmark uses identifiable public content or leaves the bookmark untagged.

Pause keeps the connection and work queue. A quota interruption preserves progress. When the provider supplies a retry time the worker resumes automatically. Otherwise, use **Resume**. Disconnect removes local credentials. Pocketmark encrypts the ChatGPT session with the server secret and stores it in PostgreSQL so replicas share the same connection. Pocketmark backups exclude the session. After restoring a backup, reconnect, choose a model and enable tagging again.

## Configuration

| Setting | Default | Purpose |
| --- | --- | --- |
| `POCKETMARK_DATABASE_URL` | Required | PostgreSQL connection URI for a dedicated database. |
| `POCKETMARK_DATA` / `-data` | `./data` | Private work and server secret directory. |
| `POCKETMARK_LISTEN` / `-listen` | `127.0.0.1:8090` | HTTP bind address; Docker uses `0.0.0.0:8090` internally. |
| `POCKETMARK_SERVER_SECRET` | Unset | Internal TOTP/session secret, at least 24 characters. Compose accepts it from the shell or a private `.env`. Use a cryptographically random value for a new installation. |
| `POCKETMARK_TOKEN` | Unset | Legacy alias, used when `POCKETMARK_SERVER_SECRET` is empty. |
| `POCKETMARK_ORIGIN` | Request origin | Public origin such as `https://bookmarks.example.com`, without a path. |
| `POCKETMARK_TRUSTED_PROXIES` | Empty | Comma-separated trusted proxy CIDRs for HTTP and login client limits; see [HTTPS deployment](API.md#public-https-deployment). |
| `POCKETMARK_RATE_LIMIT` | `10` | HTTP requests per second per client IP (1–1000); [rate limiting](API.md#http-rate-limiting). |
| `POCKETMARK_RATE_BURST` | `100` | Per-client HTTP burst capacity (1–10000). Zero and invalid values prevent startup. |
| `POCKETMARK_SECURE_COOKIE` | `false` | Set `true` for HTTPS session cookies; an HTTPS origin enables this automatically. |
| `POCKETMARK_CAPTURE` / `-no-capture` | Capture enabled | Set the environment variable to `false`, or pass the flag, to disable capture. |
| `GOMEMLIMIT` | `32MiB` | Soft Go runtime memory budget; PostgreSQL memory and total process RSS are outside this budget. |

Explicit flags override their environment defaults. For access through an HTTPS reverse proxy, configure `POCKETMARK_ORIGIN` to the exact public origin. Forward requests to the HTTP listener; browser mutation requests are checked against the configured origin. The app does not terminate TLS itself.

## Import a bookmark library

1. Export your existing library as a supported JSON file, such as `backup.json`.
2. In Pocketmark, choose **Import** and select that JSON file, or use the [import API](API.md#import-and-export).
3. Check the imported/skipped counts. Captures run afterward unless disabled.

The importer accepts the legacy JSON export object, including flat collections with `parentId`, tag objects and pinned links. It retains bookmark names, URLs, descriptions, collection hierarchy, tag names and pins. Pocketmark exports additionally retain personal notes and read flags. Valid source RFC3339 timestamps are preserved; absent timestamps use the import time. Browser HTML bookmark files can also be selected with **Import**.

Imports are limited to **8 MiB**, **10,000 links** and **2,000 collections** per file. Existing duplicate URLs and unsupported uploaded-file record types are skipped. Invalid URL records, broken collection references or cyclic hierarchies roll back the entire import. Existing collections with the same name and parent are reused on repeat imports. Transfer original uploaded files separately through the attachment upload.

JSON import/export does not include captured HTML, extracted text or other archived assets. Source accounts, permissions, RSS subscriptions, highlights and settings are not migrated. Pocketmark's export uses its own versioned JSON format.

## Back up everything

Choose **Settings → Backup & restore → Download & restore → Download full backup**. Pocketmark uses `pg_dump` to write a consistent snapshot to its private work directory and streams it as a ZIP. Provision enough space for the logical SQL dump, which encodes binary data. Store the ZIP and original server secret securely in separate places.

### Restore a full ZIP after losing the server

1. Retrieve the full backup ZIP and the server secret that was active when you made it. If you stored the ZIP in S3 or Garage, download the object to a private working directory. In that directory, extract the dump and the instructions included with that backup:

   ```sh
   unzip pocketmark-backup.zip pocketmark.sql RESTORE.txt
   ```

2. Start PostgreSQL 18 and create a **new, empty database** owned by the Pocketmark application role. Point `POCKETMARK_DATABASE_URL` at that database. Keep every Pocketmark replica stopped until the restore completes.
3. From the directory containing `pocketmark.sql`, run the restore as the application role. The command rolls back the transaction on a SQL error. Continue only after it succeeds.

   ```sh
   psql -X --single-transaction -v ON_ERROR_STOP=1 -d "$POCKETMARK_DATABASE_URL" -f pocketmark.sql
   ```

4. Configure the original server secret through `POCKETMARK_SERVER_SECRET` or the private `server-secret` file in the data directory. Start Pocketmark with the restored database. Sign in with your password and authenticator. Sessions, pending MFA challenges and recovery codes are excluded from the backup. Generate new recovery codes and review named API keys, since restoring an older snapshot can bring back a key you revoked later.
5. Check a known bookmark and open one of its saved attachments or archived pages. Follow `RESTORE.txt` for MFA recovery if your authenticator is unavailable.

For a SQLite library, follow the [migration procedure](MIGRATION_POSTGRESQL.md).

## Development and verification

Use the [contributor checklist](../AGENTS.md#verification-and-delivery) for local checks and the [architecture map](ARCHITECTURE.md) to find the implementation and its tests. Native CI runs race tests and builds Linux AMD64 and ARM64 binaries. The [release workflow](RELEASE.md#ghcr-images) qualifies the container images. For optional RAM measurements, use the [benchmark workloads](BENCHMARK.md).

## Further reading

- [Architecture and module ownership](ARCHITECTURE.md)

- [Release installation](RELEASE_INSTALL.md) · [Container images](RELEASE.md#ghcr-images)
- [Archive limits](ARCHIVES.md) · [Feature coverage](FEATURES.md)
- [Client compatibility](REAL_CLIENTS.md)

## Scheduled remote backups

Open **Settings → Backup & restore → Configure**. Choose a full database backup for disaster recovery or a custom library backup to move bookmarks and selected captures or files to an empty library. Full backups include account data. Both remote formats use the server secret for encryption. Keep the original secret separately, including previous values while their backups remain in storage.

1. Create a bucket on S3 or Garage. Enter its API endpoint, region, bucket and prefix, then the access key and secret. Grant read, write and delete permission on the backup prefix. On AWS also allow s3:ListBucket so recovery can distinguish an interrupted upload that created no object from a denied read. For versioned S3 buckets, also grant GetObjectVersion and DeleteObjectVersion. Pocketmark reads and deletes the specific version it uploaded. Object Lock or a denied deletion can leave a verified copy with a failed retention status. For Garage use the region configured by the operator. Use **Test connection** to write, read and delete a small probe.
2. Enter a five-field cron expression and IANA time zone. Review the next three occurrences and enable scheduling. The initial expression runs daily at 03:00 in the selected zone. The default execution window is two hours, including retries. Missed schedules during downtime are skipped. A manual request made during a run waits for completion. Further clicks return the same waiting request.
3. Keep the default **7 days** or choose another duration. Each newly verified backup triggers removal of older copies of the same format at the same destination. If removal fails permanently, the run shows **Failed** at **Retention** and keeps the newly verified copy. Open its Backup ID for the verification time and failure details. The history shows the latest 20 runs.
4. To receive failures in Telegram, create a bot with BotFather, start a conversation with it (or add it to the intended group), and enter the bot token and numeric chat ID. Send a test message and save the settings. Run details show alert delivery separately from the backup result.

A nonempty environment value overrides its corresponding field and locks it in Settings. Other fields stay editable. The [environment table](adr/0001-verify-remote-backups.md#environment-variables) lists all fourteen names, defaults and units. Apply the same configuration and server secret to each replica. Disk space in Pocketmark's data directory must accommodate the snapshot and encrypted archive during a full run. Check [backup metrics and logs](OBSERVABILITY.md#scheduled-backup-signals) for failures and freshness.

## Recover a remote backup

1. On the recovery host, locate the object key in the backup run details or under the instance prefix in your bucket. Download the encrypted file through your storage console or an already authenticated S3 client. For example, substitute your own endpoint, region, bucket and key:

   ```sh
   aws --endpoint-url "$S3_ENDPOINT" --region "$S3_REGION" s3 cp "s3://$S3_BUCKET/$OBJECT_KEY" backup.zip.age
   ```

2. Use a Pocketmark binary with remote backup support. Place the **original** server secret in a private directory as `server-secret` with mode 0600, or supply it via `POCKETMARK_SERVER_SECRET`. Decrypt offline to a new path. This command needs neither PostgreSQL nor a running Pocketmark server.

   ```sh
   pocketmark -data ./recovery-secrets -decrypt-backup backup.zip.age -output recovered.zip
   unzip -l recovered.zip
   ```

3. A full ZIP contains `pocketmark.sql` and `RESTORE.txt`. Follow [Restore a full ZIP after losing the server](#restore-a-full-zip-after-losing-the-server) with an empty database and the original server secret. A custom library ZIP contains `manifest.json`. Sign in to an empty Pocketmark library, open **Backup & restore → Download & restore**, select the decrypted ZIP, review its contents and confirm. Custom backups restore library data and the content selected when the archive was created. Custom ZIPs support up to 64 GiB. Choose a full backup for larger libraries.
4. Open a known bookmark and an included attachment or capture. For a restored instance, set the remote destination and Telegram credentials again, check the schedule, and run a manual remote backup. Store the decrypted ZIP as private account or library data.
