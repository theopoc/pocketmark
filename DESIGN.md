# Pocketmark interface

Pocketmark is a personal library for retrieving and reading saved material. A document title and its source should be easy to scan before choosing what to open. Collection navigation, search and save stay within reach as the library grows.

## Type, color and controls

Use a locally available book serif for library headings and bookmark titles. Keep navigation, buttons, metadata and forms in the system sans serif. Avoid fetching fonts or images from third parties for interface decoration. Reuse the canonical Pocketmark bookmark mark.

| Role | Light | Dark |
| --- | --- | --- |
| Reading surface | `#faf9f6` | `#1a1b1d` |
| Navigation rail | `#eeede7` | `#202123` |
| Primary text | `#26272a` | `#f1efe8` |
| Secondary text | `#60625e` | `#b8b6ae` |
| Divider | `#d8d7ce` | `#454640` |
| Accent text | `#5749b6` | `#c6bafa` |
| Primary button fill | `#5749b6` | `#6250b2` |

Use subtle rules between rows, a distinct background for the active destination and a visible focus ring. Keep danger, successful saves and retry states distinguishable with text as well as color. Use a filled primary button for the immediate action. Give icon buttons accessible names, keyboard operation and a touch target that works independently of hover. Long titles, tags, filenames and collection names must wrap or expose their full text accessibly.

## Finding and organizing

Place search under the current library heading. Show scope and a way to repeat a scoped query across the library. Preserve filters, sorting and pagination in history. Returning from a bookmark should restore the library location, scroll position and keyboard focus.

Default to a scannable list. Put the title first, group source and metadata under it, and keep favorite and contextual actions at the edge. Let each collection remember its layout. The grid gives more space to visual material. The display menu groups sort and presentation options. Selection exposes checkboxes and a shared action bar. Bulk operations describe what will change and confirm destructive actions.

On narrow screens, retain navigation in the drawer. Keep Add reachable and limit the controls above the first bookmark. Empty states should offer the relevant next action. Keep list updates stable during refreshes and keyboard navigation.

## Saving and reading

Start a new bookmark with its URL and destination. Additional metadata and the HTML capture option are available in the editor. A file can be uploaded from the same dialog. Preserve drafts across dismissal. Successful saves identify their destination. If capture fails after saving, keep the bookmark and provide a retry.

Open a web bookmark on its captured text. Keep a link to the original and show an explanation when text is unavailable. A standalone file opens its preview. Copies exposes saved versions and original downloads. Notes and highlights stay accessible beside the reader on wide screens and as a separate pane on small screens. Preserve the article position when changing panes. Direct links and browser Back must work for bookmarks and files.

## Account and settings

The initial account flow shows three steps covering account details, an authenticator and recovery codes. Keep the QR, code entry and manual setup method usable on a phone. Protect one-time credentials and pending security actions when navigating. Keep password reauthentication, session management and authorization boundaries intact.

Organize settings by user intent. The overview groups account and security, apps and devices, and library and data. Give each section its own address. On narrow screens, show either the index or the selected section with a way back. Keep transfer results, errors and recovery actions close to the operation.

## Extension and API reference

The extension puts the active page and save action first. Tags and optional offline copy formats expand on demand. Show the save result and individual capture failures, with a way to retry retained captures. Connection and theme controls remain available.

The API reference supports finding an operation by method and path, jumping to its details, and inspecting or trying the request. Keep authentication context visible and make real mutations clear. Preserve Swagger's request and response details.

## Interaction and verification

Use motion to communicate a change of state without delaying input. Honor reduced-motion preferences, retain keyboard focus when overlays close, and expose status updates to assistive technology. Place feedback inside open modal dialogs when needed. Escape closes the active layer first.

Exercise both themes, narrow and wide windows, keyboard interaction and reduced motion with disposable data. Check first use, populated lists, no results, capture failure, standalone file preview, forms and account recovery. Refresh the README library image from the rendered product when the library changes.
