<p>
  <img src="internal/webui/static/icon.svg" alt="Pocketmark logo" width="96" height="96">
</p>

# Pocketmark

A personal bookmark manager built for low RAM usage: one Go process, SQLite and an embedded web interface. No external database or server-side browser.

[![GitHub Actions](https://img.shields.io/badge/GitHub-Actions-2088FF?style=for-the-badge&logo=githubactions&logoColor=white)](https://github.com/theopoc/pocketmark/actions/workflows/ci.yml)
[![Releases](https://img.shields.io/badge/GitHub-Releases-181717?style=for-the-badge&logo=github&logoColor=white)](https://github.com/theopoc/pocketmark/releases)
[![Issues](https://img.shields.io/badge/GitHub-Issues-181717?style=for-the-badge&logo=github&logoColor=white)](https://github.com/theopoc/pocketmark/issues)

![Pocketmark bookmark library with collections, tags and search](docs/pocketmark-features-preview.jpg)

## Features

- Organize bookmarks with nested collections, tags, favorites and notes.
- Search bookmarks and saved page text.
- Save pages for offline reading, attach files and annotate text.
- Import JSON or browser bookmarks; sync with [Floccus](#floccus).
- Save bookmarks with the [Linkwarden extension](#linkwarden-extension).
- Capture rendered pages and screenshots with the [browser extension](extension/README.md).
- Use the mobile web interface or compatible third-party clients ([tested clients and limits](docs/REAL_CLIENTS.md)).

Personal use only: collaboration, public sharing, SSO and automations are outside the supported scope.

## Quick start

Use Docker Compose, or [download a Linux binary](docs/RELEASE_INSTALL.md).

With Git and Docker Compose installed:

```sh
git clone https://github.com/theopoc/pocketmark.git
cd pocketmark
docker compose up --build -d
```

Open [http://127.0.0.1:8090](http://127.0.0.1:8090) and create your personal account. On later visits, sign in with your username and password. Data persists in a Docker volume. Compose sets a 128 MiB memory limit; see [measured RAM usage](docs/BENCHMARK.md) for workload results.

For HTTPS access, set `POCKETMARK_ORIGIN` to your public URL. See the [guide](docs/GUIDE.md#configuration) for configuration.

## Integrations

### Linkwarden extension

1. Install the Linkwarden browser extension.
2. In its connection settings, set the server URL to your Pocketmark origin, such as `https://bookmarks.example.com` (without `/api` or `/dav/`). For local use, enter `http://127.0.0.1:8090`.
3. Sign in with your Pocketmark username and password.
4. Open the extension on a page, choose a collection, optionally add tags and a description, then save.

The unmodified Chrome extension **1.5.6** was tested with password sign-in, collection selection, tags, descriptions, screenshot uploads and detection of previously saved links. Other workflows and versions have not been qualified. Pocketmark also includes its own [browser extension](extension/README.md) for rendered HTML capture and optional advanced PDF/full-page screenshots.

### Floccus

Floccus synchronizes browser bookmarks and nested folders with Pocketmark in both directions, including edits, moves and deletions. Create a separate key for each client: sign in to Pocketmark, open **API keys**, create a named key and copy it immediately; it is shown only once.

Choose one backend in Floccus:

| Setting | Linkwarden backend | WebDAV backend |
| --- | --- | --- |
| Server URL | `https://bookmarks.example.com` | `https://bookmarks.example.com/dav/` |
| Username | Any descriptive username | Any descriptive username |
| Password / access token | Dedicated Pocketmark API key | Dedicated Pocketmark API key |
| Folder / file | Choose a server collection | XBEL file: `bookmarks.xbel` |
| Bookmark order | Not preserved by this backend | Preserved |

1. Add an account in Floccus and select **Linkwarden** or **WebDAV** with the settings above. Use HTTPS outside localhost.
2. Select the local browser bookmark folder to synchronize. For the Linkwarden backend, also choose the server collection. For WebDAV, select **XBEL** and leave file encryption disabled so Pocketmark can read the tree.
3. Back up your library before the first sync, then download/merge the existing server bookmarks. Synchronization propagates deletions too; an incomplete uploaded tree can remove server bookmarks.
4. Run a manual synchronization and check both libraries before enabling automatic synchronization in Floccus.

Use the API key rather than your Pocketmark account password for either Floccus backend. Existing bookmarks retain Pocketmark notes, tags, captures and annotations; standalone uploaded files are excluded from XBEL synchronization and remain in Pocketmark.

Both backends were tested with unmodified **Floccus 5.11.1**, including synchronization after a server restart. See [tested client workflows and limits](docs/REAL_CLIENTS.md) and [Floccus data semantics](docs/FEATURES.md#floccus-setup-and-data-semantics). Synchronization runs in Floccus; Pocketmark adds no background sync process.

## Development

Requires Go (see `go.mod`), a C compiler and Make. Node.js and Python 3 are also required for checks and tests.

Build and run locally:

```sh
make build
./bin/pocketmark
# In another terminal:
cat ./data/access-token
```

Run the checks before contributing:

```sh
make check
make test
make test-extension
```

## Documentation

- [User guide](docs/GUIDE.md) — configuration, migration and full backups.
- [Browser extension](extension/README.md) — installation and capture tools.
- [API](docs/API.md) — endpoints and request limits.
- [Development and CI](docs/CI.md) — checks and releases.
