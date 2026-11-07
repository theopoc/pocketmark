# Frontend development

Pocketmark uses React and locally owned shadcn/ui primitives, built by Vite.
The result is static HTML, JavaScript and CSS embedded by `go:embed`. Private
library data is fetched and rendered in the browser. Production still runs one
Go process, without Node, SSR workers, an asset server or a package registry.

## Build and development

Use Node.js 24 with npm, plus the Go/CGO prerequisites in the contributor guide.
`make build`, `make check` and `make test` install the locked frontend inventory
when needed and compile it before Go accesses embedded files. A direct `go build`
from a fresh checkout must first run `make frontend`.

For interactive development, start a disposable backend:

```sh
make build
bin/pocketmark -data /tmp/pocketmark-development -listen 127.0.0.1:8090 -no-capture
# In another terminal:
npm run dev --prefix frontend
```

Open the loopback address printed by Vite and create disposable credentials.
Vite proxies requests and existing styles to the local backend. Set
`POCKETMARK_DEV_SERVER` to use a different loopback backend address. Native
browser integrations initialize once per document; development uses full reloads
and the existing tab draft cache instead of preserving controllers through HMR.
Verify production behavior with `make build` and the compiled binary.

## Sources and ownership

- `frontend/src/shell.jsx` composes the React page, forms and native dialogs.
  The shell is rendered once; feature controllers own native browser lifetimes.
  Sidebar and toast have separate stable root containers outside the shell.
  Native top-layer/rail positioning moves these containers, retaining React's
  ownership of the nodes inside them. Bootstrap waits for all roots to hydrate.
- `frontend/src/components/ui/` contains the locally editable shadcn primitives.
  Use their variants and existing semantic styles when adding controls.
- `frontend/src/features/library/` renders keyed bookmarks, collection navigation,
  frequent tags, breadcrumbs and filter chips through React.
- `frontend/src/features/settings/` owns account, API-key and MFA settings.
  API-key rows and their rename forms are React views with explicit pending state.
  Reader, bulk actions, selection, tag entry and security have separate modules.
- `frontend/src/features/workspace.js` owns routing, drafts, validation and safe
  bookmark values without depending on React. Tests exercise those same rules.
- `frontend/src/application.js` coordinates features and application commands.
  Browser event subscriptions, observers and timers belong to a lifecycle and
  must be released when its owner is disposed.
- The existing semantic stylesheets remain in `internal/webui/static/`.
  Tailwind utilities are available without preflight, which would reset the
  established design. Reuse DESIGN.md tokens in both themes.
- Classic scripts shared with the extension or standalone API documentation keep
  their canonical source and existing compatibility. Vite imports the same shared
  code through a build adapter; do not maintain divergent copies.

React owns the child structure of its rendered regions. Native integrations may
measure nodes, focus controls and operate native dialogs; do not move or replace
React-owned children. Use cloned nodes for exit animations. Pending buttons must
be restored explicitly: keyed React rows survive successful requests.

## Dependencies

Exact direct versions and the transitive inventory live in
`frontend/package.json` and `frontend/package-lock.json`.

| Dependency | Responsibility |
| --- | --- |
| React / React DOM | Browser rendering, keyed updates and lifecycle |
| Radix Slot | shadcn `asChild` composition without extra DOM wrappers |
| class-variance-authority, clsx, tailwind-merge | Primitive variants and class composition |
| Vite / React plugin | Production compilation and local development |
| Tailwind CSS / Vite plugin | Locally compiled utility styles; no runtime CSS generator |
| ESLint, globals, Prettier | Development-only source checks |

shadcn distributes source rather than a mandatory runtime package. The authored
primitives follow its open-code patterns, using Pocketmark's documented visual
variants rather than replacing the product's appearance. Keep upstream provenance
beside the source. Add dependencies only for concrete behavior, review their
browser cost, and keep build tools out of the runtime image.
The lint toolchain's `minimatch` override selects a patched matcher; review that
override when updating ESLint and rerun the source checks and dependency audit.

## Generated assets and caching

`frontend/build.mjs` compiles hashed assets into
`internal/webui/static/app/`, generates the empty React shell as `index.html`,
and generates `sw.js` from the compiled asset inventory. These outputs are ignored
and must be rebuilt from their sources. The shell contains no account/library
data. Do not hand-edit generated output or commit dependency directories.
The build also includes the shadcn notice and licenses of the actual bundled
packages at `/app/licenses.txt`.

The worker caches only an explicit list of public static assets. Its version
depends on their contents. HTML navigation, API responses, credentials, captures
and attachments stay outside this cache. Keep the existing CSP and sandboxed
preview boundaries; compilation does not authorize inline scripts or evaluation.

## Verification and CI

Run the four contributor Make commands. `make test` includes the existing feature
regressions and React view tests; `make check` also checks frontend source quality.
After building, run the complete journey against a disposable native instance:

```sh
npm ci --prefix e2e --ignore-scripts --no-audit --no-fund
e2e/node_modules/.bin/playwright install chromium
python3 scripts/smoke_frontend.py --binary bin/pocketmark
npm audit --prefix frontend --audit-level=high
```

Quality, Tests, native Build and Go CodeQL extraction all compile frontend assets.
The amd64 Build job exercises its compiled binary in Chromium before it becomes
a release input. Security audits the locked frontend inventory; Dependabot checks
updates separately. Docker builds assets in a Node build stage and copies only
static output into the Go build; releases keep reusing validated binaries.
The nested `frontend/go.mod` keeps Go examples inside npm tooling out of the
application's recursive Go checks; it introduces no Go runtime dependency.

For interface changes, compare matching disposable fixtures at desktop and phone
widths in both themes. Preserve accessibility, draft recovery, history, selection,
undo, account security and sandboxed previews. A source test or green build alone
does not establish functional or visual parity.
