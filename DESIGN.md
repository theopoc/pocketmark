---
name: Pocketmark
description: A precise workspace for a personal bookmark library.
colors:
  ink: "#20232c"
  muted: "#626978"
  paper: "#fff"
  sidebar: "#f6f7f9"
  surface: "#f8f9fb"
  line: "#e3e5eb"
  control-line: "#818896"
  control-line-dark: "#747b92"
  accent: "#4f46e5"
  accent-hover: "#4038c5"
  accent-soft: "#eeedff"
  danger: "#b12e35"
  success: "#23714a"
  focus: "#7067ef"
typography:
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "26px"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "-.7px"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.5
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "14px"
    lineHeight: 1.5
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "12px"
    fontWeight: 550
    lineHeight: 1.5
  reader:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "17px"
    lineHeight: 1.95
rounded:
  small: "4px"
  control: "6px"
  utility: "8px"
  panel: "12px"
spacing:
  compact: "8px"
  row: "12px"
  standard: "16px"
  section: "24px"
  workspace: "32px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.paper}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
    typography: "{typography.label}"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-subtle:
    backgroundColor: "{colors.paper}"
    textColor: "#4b5263"
    rounded: "{rounded.control}"
    padding: "8px 12px"
    typography: "{typography.label}"
  input:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
  bookmark-card:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.panel}"
  tag:
    backgroundColor: "#f0f1f6"
    textColor: "#5b6272"
    rounded: "{rounded.small}"
    padding: "2px 6px"
---

# Design System: Pocketmark

This document is the source of truth for current interface design rules. Dated
UI validation reports preserve historical observations and their testing limits.

## Overview

**Creative North Star: "The Personal Library Workspace"**

A precise technology workspace for a strictly personal library. Cool white content, a slate-tinted navigation drawer and indigo controls keep attention on saved material and practical actions. The interface uses the operating system’s sans serif, authored outline SVG icons and restrained borders.

Density serves finding and organizing; reading deliberately opens into a larger type size and generous measure. The embedded HTML, CSS and JavaScript need no frontend runtime or remote fonts.

**Key Characteristics:**
- Compact library rows with visible actions and labeled capture states.
- Indigo selection and action cues over cool neutral surfaces.
- Responsive navigation and a comfortable reader in the same visual language.

## Colors

The palette is cool and restrained; the frontmatter records the reusable CSS color properties without the legacy green aliases.

### Primary
- **Indigo:** accent identifies primary actions and selected controls; accent-hover darkens interactive emphasis, accent-soft supports selected or hovered surfaces, and focus supplies keyboard outlines. The same accent anchors the bookmark mark and installable app theme.

### Neutral
- **Ink and muted slate:** ink carries titles and body text; muted carries secondary descriptions and metadata.
- **White paper and cool surfaces:** paper is the content canvas, sidebar distinguishes navigation, and surface supports result headers and secondary containers. Line defines quiet dividers.
- **Semantic status:** success marks ready/read states; danger marks failed states and destructive affordances. Pending and processing states use amber text with explicit labels.

**The Action Accent Rule.** Use indigo for primary actions, selection and focus; retain semantic green and red for success and failure.

## Themes

Dark is the default for new browsers. A toggle in the workspace header and on the sign-in screen switches between dark and light; `pocketmark-theme` stores the explicit choice locally. `/theme.js` applies it before the stylesheet loads. Blocked storage falls back to dark without preventing use.

The frontmatter colors describe the light palette. Dark mode overrides the same semantic CSS properties:

| Token | Dark value |
| --- | --- |
| `ink` | `#e8e9ef` |
| `muted` | `#a3a7b6` |
| `paper` | `#15161b` |
| `sidebar` | `#191a21` |
| `surface` | `#1e2029` |
| `line` | `#30323e` |
| `accent` | `#6359ed` |
| `accent-hover` | `#5a50df` |
| `accent-soft` | `#2b2750` |
| `danger` | `#f58a96` |
| `success` | `#80c9a3` |
| `focus` | `#a39aff` |

Dark controls, dialogs, cards, metadata, highlights and selection share the theme; original saved-page layouts keep their source appearance. Primary-button foregrounds remain white in both modes. Native controls follow `color-scheme`; browser theme color follows the selected page ground. Print uses a white reader surface and black text.

## Typography

**Body and interface font:** the system sans stack in the frontmatter. There is no separately loaded display face. Monospace is used for generated credentials, including API keys, authenticator setup keys and recovery codes.

The hierarchy is compact: headline for library headings, title for bookmark names, body for the base interface, and label for buttons and field labels. Secondary metadata commonly uses (11px–13px). Dialog headings use (20px); the reader title uses (22px). The sign-in introduction uses (42px) on desktop and (30px) on phones; this is an entrance-specific treatment, not a general display scale.

**The Reading Measure Rule.** Keep reading text within 70ch and give it more leading than workspace metadata.

## Layout

The main column uses the full workspace width. Navigation opens from the header into a full-height native dialog drawer at every viewport width, up to (320px) wide. The workspace header is (64px) tall; library content has (32px) horizontal padding and a maximum width of (1680px). Between (901px) and (1150px), horizontal padding becomes (24px).

At (900px) and below, header and library padding become (20px). At (600px) and below, search spans its own row, header actions expand, fields use (16px) text, forms become one column, and bookmark actions move beneath metadata. The reader becomes a full-height edge-to-edge dialog. The sign-in split layout stacks on phones.

Library results use one unboxed toolbar beneath search: the result count and selection actions on the left, selection help, Refresh, the labeled sort button and view switch together on the right. Controls wrap into reachable rows on phones; the capture summary remains visible when present. Selecting bookmarks turns the same toolbar into a sticky tinted action bar.

List rows use a 16px title followed by the description, then a shared domain/tag line. All three lines align after the leading favorite star, with 20px vertical and 24px horizontal row padding on desktop. The list has its own rounded outline beneath the toolbar. Rows retain trailing state/actions. Select bookmarks by clicking or tapping a free area, using Shift for a range or dragging a mouse selection rectangle; titles and action buttons retain their actions. Focused bookmark groups support Space and Shift+Space, with Escape to clear. A sticky selection bar shows the count, any selection outside the current results and bulk actions. Its help panel opens on click or keyboard and fits phone widths. Grid uses auto-filled columns with a minimum target of (260px), a (16px) gap and one column on phones. Switching view retains the same bookmark structure and state. Reuse the compact spacing rhythm recorded in the frontmatter rather than introducing spacious promotional sections.

## Elevation & Depth

Borders and tonal layers organize the workspace. The selected view toggle has a small inset surface lift; dialogs, drawer and toast carry ambient shadows. Focus uses an outline, not an elevation effect.

### Shadow Vocabulary
- **Selected view:** `0 1px 3px #20232c20`.
- **Toast:** `0 6px 24px #20232c25`.
- **Dialog:** `0 20px 80px #171a3433`.
- **Navigation drawer:** `12px 0 40px #20232c20`.

**The Flat Workspace Rule.** Separate resting library surfaces with borders and tones; reserve substantial shadows for dialogs and transient feedback.

## Shapes

Controls use restrained rounded corners; smaller tags and action buttons use the small radius, controls the control radius, and grid cards/dialogs the panel radius. Dense list rows have square internal edges within a shared softly rounded results container. Borders are generally (1px). Outline SVG icons use rounded caps and joins with a shared (24 × 24) viewBox and (1.7) stroke width; most visible icons are (15px–18px).

## Components

### Buttons
Compact and direct. Primary actions use indigo and white, subtle actions use white with a cool gray border, and icon actions use transparent backgrounds. Primary and subtle controls use the shared control radius and label type. Hover changes background or border with (160ms ease-out) transitions. Keyboard focus has a (2px) outline and (3px) offset; disabled buttons use (.48) opacity. Phone actions increase their target dimensions where the layout requires it.

Motion preserves context: selected tags settle into their new positions over 180ms, while new tags receive a 150ms entrance. Collection, search and layout changes use a short 180ms content fade; background refreshes stay still. Native dialogs establish depth in 220ms and exit in 140ms, with a matching backdrop; tag suggestions use a 120ms fade. Removed bookmarks exit over 140ms while remaining rows or grid cards settle into place over 200ms; exit layers are inert and hidden from assistive technology. Actions and focus changes never wait for motion. Repeated actions replace in-flight animations. Reduced motion removes spatial transitions and content fades while retaining 80ms control-color feedback. Native overlay transitions progressively enhance the browser's immediate default behavior.

Manual light/dark changes crossfade the complete view over 240ms using native browser snapshots, keeping text and surfaces synchronized. The first render uses the saved theme immediately. Repeated toggles interrupt the fade and preserve the latest choice; reduced motion and browsers without View Transitions switch immediately. The snapshot overlay does not intercept pointer input.

### Chips
Small rectangular tags use neutral fill, short padding and compact type. Hover or active filter states use the soft accent and indigo text. Long labels truncate rather than widening the navigation drawer.

### Capture status

Bookmark capture states use compact rounded badges with a text label and an icon: green Captured, amber Queued / Saving…, red Capture failed, and neutral Not captured. Only Saving… rotates a small ring to indicate active capture. Reduced motion keeps the ring still and preserves the label. Light and dark themes use tinted backgrounds with readable semantic foregrounds; badge placement and card actions remain unchanged.

### Cards / Containers
Grid bookmark cards use the panel radius, white background and a line border; selection changes both fill and border without a checkbox. A softly tinted header groups the domain and the favorite star, with the full saved URL available on hover. The capture state and remaining actions stay in the footer. List mode removes individual card rounding, separates rows with dividers and retains the same selection, tags, capture labels and actions. Do not add permanent card shadows.

### Inputs / Fields
Field boundaries use control-line (#818896) in light mode and #747b92 in dark mode, providing at least 3:1 against their adjacent field surfaces. Quiet separators keep the line token. Fields retain the control radius and (10px 12px) padding. Focus has a (2px) outline and (2px) offset. Search applies its outline around the complete search container. Read-only fields use the surface fill; form errors appear inline in danger text. Bookmark fields validate the server’s UTF-8 size limits before submission and identify the field to correct. Network/session failures give recovery instructions while retaining unsaved work.

Authenticator setup pairs a QR code on white with a labeled, read-only manual key. Recovery codes use selectable, scrollable text in a bordered surface, with a copy action and a manual-selection fallback.

### Navigation
The slate-tinted drawer combines outline icons, sentence-case labels and compact counts. Its Pocketmark mark is a white serif “p.” on an indigo square, shared with the Chrome extension. Active navigation uses pale indigo and stronger text. On desktop with a mouse, the sidebar appears at the left edge on hover or from the header menu; its panel control switches between automatic hiding and a fixed layout, remembered in the browser. Keyboard focus keeps it visible. On smaller screens and touch devices, the header opens a modal drawer; its close button, Escape, backdrop and destination choices dismiss it. Motion respects reduced-motion preferences, and smaller screens give controls more height rather than losing functions.

### Tag directory
Tags has a primary navigation entry. Keep up to 12 most-used tags as quick filters at the bottom of the sidebar, including while browsing the directory. The directory groups names under letter headings in three columns on wide screens, two on medium screens and one on phones. Compact counts sit beside each name. A sticky vertical A–Z rail (plus `#` for other initials) jumps across the paginated directory, disables unavailable letters and moves keyboard focus to the selected heading. Search narrows both the index and available letters. Fetch at most 40 tag rows and 27 group totals per request.

### Navigation, scope and drafts
Bookmark and bulk tag fields show each selected tag in a compact bordered chip with a labeled remove button. The field wraps and grows to keep every selected tag visible, including long names; it has no internal scrolling or truncation. Frequent existing tags appear on focus and the full directory is searched as the user types. Suggestions show bookmark counts, exclude tags already present, and support arrow keys, Enter and Escape. New tags can be committed with Enter, commas or by leaving the field. Backspace in an empty search focuses the last remove button. Results are bounded and suggestion failures leave manual entry available.

Library destination, search, sorting, pagination and tag-directory state are represented in the URL. Back/Forward and reload restore that context; browser history also records the page scroll position. Tag destinations retain the bookmark search and identify the selected tag in the heading. Only the search appears as a removable filter chip. Selection summaries disclose bookmarks outside the current results; bulk dialogs show the selected titles and require a fresh action choice each time.

Bookmark, reader-note and annotation drafts stay in the current tab. A bounded sessionStorage cache restores them after reload; denied storage or quota failures fall back to memory without preventing edits. Reopening a form restores drafts, and reader notes carry into the bookmark editor. Notices name the tab lifetime, discard removes unsaved changes, and leaving/reloading warns while drafts remain. Signing out always opens a confirmation alertdialog, with Cancel focused first and an additional warning when this tab has unsaved drafts. Confirming sign-out clears the cache after the request succeeds; request errors remain in the dialog. Drafts are not stored in localStorage, URLs or on the server. Saving notes retains unrelated unfinished editor changes.

In grid view, Favorite sits at the right of the card header; in list view, it remains immediately before the title. The other four actions stay grouped at the right. Borderless action icons are 18px with 32px desktop targets, theme-matched hover/focus backgrounds and native title tooltips. Selected favorites retain a filled star, and Delete uses danger colors on hover/focus. Mobile bookmark actions retain an accessible Favorite control and disclose the other labeled commands under Actions. Quick favorite/read changes confirm with an Undo action; feedback appears inside any active native dialog so its message is visible and announced. Search-only excerpts highlight matches and display decoded tag names. Near-match scope is visible beside its checkbox: titles, URLs, descriptions and tags only. Task-based Help is searchable from the navigation.

Opening a bookmark shows its title, source URL and Saved formats before any article text. Only available HTML, Screenshot and PDF copies appear as flat rows with authored outline icons and explicit Saved states. A shared message distinguishes checking, failed checks and no saved copies; unavailable format rows are hidden. In-flight and failed file checks stay distinct from absent captures; a local retry stays visible on the bookmark. Screenshot includes uploaded raster images as well as browser captures. Each available format opens the newest attachment in the existing viewer, with earlier copies selectable. When no HTML attachment exists, the basic HTML archive uses the simplified sandboxed reader. Its source download remains under Reading options when attachments exist. Reading options expose text/highlights and formatted reading on demand. Its short toolbar keeps a prominent Open original link and a secondary Notes action visible. Notes opens a companion pane on screens wider than 1000px; narrower windows show the notebook with an explicit Back to bookmark action. The article keeps its own scroll position while the notebook opens or changes sections. Notes and Highlights are local notebook tabs with arrow-key navigation. Attached files are managed directly from Saved formats → Manage files. The notebook starts closed for each new bookmark. Anchored highlights offer Show in text; stale excerpts remain visible without a misleading jump action. An absent captured article is labeled explicitly rather than presenting the bookmark description as article text. Formatted views require a suitable HTML capture or attachment; unavailable modes explain the next step. Text size and highlighting follow the active mode. Highlights and saved-file loading errors remain local to their sections. On phones, row action targets are 44px and a 44px letter picker complements the A–Z rail.

### Settings

Settings is a workspace page. The drawer offers Account & security, its indented API keys destination, Backup & restore, Browser bookmark sync, and Mobile & browser. Account & security brings password, two-factor authentication and browser sessions together. API keys puts existing keys first and reveals the creation form on demand. A query parameter preserves the section across reload and browser history, including older links. Back to library restores filters and scroll position. Authentication changes block departure while pending; displayed recovery codes survive session expiration until explicitly dismissed by returning to the library. Leaving Settings clears credentials held in the page.

Entering Settings settles the workspace 12px from the right over 220ms with a light fade, paired with a 180ms navigation fade. Initial loads and section changes remain still; leaving cancels the entrance. Focus and controls update immediately. Reduced motion skips both effects.

### Reader and dialogs

The bookmark editor offers an unchecked **Save an HTML copy** option for website bookmarks. Capture starts after metadata is saved, reports partial failure without undoing the bookmark, and offers a capture-only retry. Standalone files hide this option. Saved files in the reader focus on attachments and previews; PDF capture stays in the Chrome extension.

Dialogs use theme-matched panels, a dimmed backdrop, labeled headings and separated footer actions. The reader widens to (1200px), keeps its toolbar separate from the scrolling article and constrains text to a (680px) measure. Its optional companion pane is (320px) wide; notes, highlights and file management stay secondary to saved formats and on-demand reading. Highlight excerpts use their saved color; annotation notes and quiet editing actions sit beneath each quote. Highlight colors describe user annotations rather than application status. On phones, the reader becomes an edge-to-edge reading surface.


## Do's and Don'ts

### Do:
- Do preserve visible keyboard focus and text labels for capture states.
- Do use authored outline SVG icons with accessible names on icon-only controls.
- Do reflow rows and keep their actions available on phones.
- Do honor reduced motion, keep transitions brief and leave actions immediately available.

### Don't:
- Don’t add team or public-sharing visual concepts to this personal workspace.
- Don’t add remote fonts, icon packages or frontend runtime dependencies.
- Don’t use color alone to communicate capture status.

## Interface refinement — 31 October 2026

The product choice is saved formats first, not automatic article reading. The formats shown must be available; zero saved copies gets a useful empty state. Text/highlight controls stay secondary and announce an active mode only when that mode is displayed. The companion is labeled Notes and contains notes and highlights. Manage files beside Saved formats opens the attached-file panel and distinguishes attachments from an existing basic HTML capture.

Settings is directly available in the library navigation. Library tools groups import, export and sign-out. Import first explains JSON/browser HTML metadata files and the 8 MiB limit, then leaves a durable result in the library. Sync provides a copyable WebDAV address and ordered instructions; mobile/browser settings explain installation, extension access and the local single-key shortcut preference.

The bookmark editor keeps its heading and save/cancel footer visible around a scrolling form body. URL, title and organization lead; description and notes are disclosed together and open automatically for existing content or drafts. Secondary controls use semantic surface, ink, border and hover tokens in both themes. Phone settings disclosures share 44px targets. Session dates use a definition list, with raw device details disclosed on demand. Existing short, interruptible transitions and reduced-motion feedback remain the motion vocabulary.


## Approved secondary refinements — 1 November 2026

The library reference is the restored interface at `e678b74`. Keep its icon actions, mobile Actions disclosure, sort button/menu, list/grid geometry, palette and density. `style.css` remains unchanged. Secondary refinements belong in `secondary.css`, scoped to login/MFA, settings, help, API documentation, the collection hint and the reader files/notebook. Never broaden those selectors to generic application controls.

Login/MFA, settings, help and API documentation use 13px labels/hints and 14px body copy on desktop; phone fields remain 16px. State colors reuse the existing palette and field boundary tokens. Direct settings headings reserve 16px of scroll space for visible keyboard focus. Notes/files and help disclosures use progressive 160ms opacity feedback with immediate reduced-motion fallback. The existing library and theme timings remain unchanged.

The app, API documentation and extension share an interruption-safe theme controller. The extension supplements its original dark palette with a locally stored light theme, keeping the field order and bottom save action. Collection hints show character count and percentage of the server UTF-8 budget. Shared local theme/name modules are checked by `scripts/sync_ui_assets.py`; no runtime dependency is added.

Historical evidence and validation limits are recorded in the
[UI validation report of 1 November 2026](docs/UI_VALIDATION_2026-11-01.md).
