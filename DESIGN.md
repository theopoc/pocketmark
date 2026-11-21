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

This document is the source of truth for current interface design rules.
Record validation evidence and its testing limits in the PR; keep generated
artifacts outside version control as described in [AGENTS.md](AGENTS.md).

## Overview

**Creative North Star: "The Personal Library Workspace"**

A precise technology workspace for a strictly personal library. Cool white content, a slate-tinted navigation drawer and indigo controls keep attention on saved material and practical actions. The interface uses the operating system’s sans serif, authored outline SVG icons and restrained borders.

Density serves finding and organizing; reading deliberately opens into a larger type size and generous measure. The React interface uses locally compiled shadcn/ui primitives styled with Pocketmark’s semantic CSS tokens. Assets remain embedded in Go; fonts remain local to the operating system.

**Key Characteristics:**
- Compact library rows with visible actions and labeled capture states.
- Indigo selection and action cues over cool neutral surfaces.
- Responsive navigation and a comfortable reader in the same visual language.

## Component consistency and identity

Each component type keeps its own visual identity within the shared palette,
typography, spacing rhythm and icon system. Toasts, popovers, menus, dialogs,
buttons and fields remain recognizable as distinct components. Every instance
of the same component and documented variant follows one canonical treatment
throughout the application, including inside other components and overlays.

Before adding or changing an instance, identify its existing implementation,
owning styles and component rules below. Reuse its shared primitive and base
styles. Preserve its identity across screens:

- **Color:** semantic roles for surfaces, text, icons, borders, accents and status.
- **Shape:** corner radii, border treatment, shadow and component proportions.
- **Typography:** font family, size, weight, line height and text hierarchy.
- **Composition:** padding, gaps, icon sizing and alignment, content hierarchy
  and placement of actions.
- **Interaction:** hover, active, focus, disabled and loading treatments, plus
  the component's motion and dismissal behavior where applicable.

Light and dark themes express the same identity with their respective semantic
tokens. Responsive layouts may wrap, resize or reposition content while keeping
the component's visual signature and reachable controls. Existing documented
variants, such as primary/subtle buttons or status icons, retain their explicit
differences. A screen, feature or nesting context alone does not create a new
variant. For example, every toast uses the shared toast panel and action styling;
every instance of a given popover uses its established popover treatment.

Keep common rules in the owning component or shared stylesheet. Scope secondary
surface refinements as defined under Layout; local overrides must preserve the
base component identity. When a new variant or a deliberate identity change is
needed, document its purpose, defining properties and allowed differences here,
then update all affected instances and states together.

For interface changes, compare the affected component with existing instances
of the same type and variant across its relevant screens and nesting contexts.
Check desktop and phone layouts, both themes, theme switching while visible and
the affected interaction/status states. Assess visual consistency, palette
conformity and accessibility separately; record coverage and limits in the PR
as required by the design review policy.

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

The frontmatter colors describe the light palette. [The semantic stylesheet](internal/webui/static/style.css) defines the light and dark token values used by the interface.

Dark controls, dialogs, cards, metadata, highlights and selection share the theme; original saved-page layouts keep their source appearance. Primary-button foregrounds remain white in both modes. Native controls follow `color-scheme`; browser theme color follows the selected page ground. Print uses a white reader surface and black text.

Every added or modified component must match both the design system and the active theme's palette. Use semantic tokens for surfaces, text, icons, borders, hover, focus and status; resolve their light and dark values independently. A matching layout or readable contrast alone does not establish theme conformity. Check the rendered component in both themes, including its interactive states, before delivery. Approved accent surfaces retain their accent treatment in both themes, with foreground colors chosen for that surface rather than the page ground.

Entered search text uses `ink`; mobile action labels use the readable `muted` token rather than the desktop icon gray. The sign-in theme toggle keeps a translucent hover surface over its violet introduction panel. Programmatically focused Settings headings use the same indigo outline as other keyboard targets. Quiet Delete actions in files and annotations use `danger` on hover and focus, independently of their position among other actions.

API documentation applies theme tokens to expanded response headers, examples and SVG paths as well as the collapsed overview; forced colors retain system icon colors. Operation permalinks are separate, labeled keyboard targets beside the summary buttons. Generated parameter fields have accessible names, and scrollable code examples can receive keyboard focus.

<a id="approved-secondary-refinements--1-november-2026"></a>

The app, API documentation and extension share an interruption-safe theme controller. The extension supplements its original dark palette with a locally stored light theme, keeping the field order and bottom save action. Shared local theme/name modules are checked by `scripts/sync_ui_assets.py`; no runtime dependency is added.

Secondary surfaces use the existing palette and field boundary tokens.

### Floating selection bar

The selection bar uses an opaque violet background derived from the active theme's `accent` (75% accent mixed with black), white labels and outline icons, and light red (`#ffb4b8`) for both the Delete label and trash icon. Hover darkens the violet; keyboard focus uses a white outline. Desktop exposes Select all, Move, Tags, Favorites, Read/Unread and Refresh captures followed by Delete and the clear-selection icon. There is no More menu. The bar wraps only when space requires it, without hiding actions. Read uses the circle-check icon whenever at least one selected bookmark is unread; Unread uses the clock icon when every selected bookmark is read, including selections outside the current results.

Action panels use the active theme's `paper`, `ink`, `line`, `control-line` and `accent-soft` tokens. They open above their desktop trigger with protected keyboard focus. Move offers a searchable collection list and Move here; Tags retains the wrapping tag picker and explicitly replaces existing tags. Favorites and reading status offer two explicit commands without an extra apply step. Capture requests have a queue confirmation, and deletion has one destructive confirmation with Cancel focused first. Bulk actions preserve the full frozen selection. Status changes offer Undo, preserving newer metadata and status changes.

On phones, a compact selection count, Actions launcher and clear-selection control leave room to select more bookmarks. Actions opens a bottom sheet with labeled full-width rows. Choosing an action replaces the sheet contents; Back returns to the action list without stacking dialogs. Controls have at least 44px targets, the sheet scrolls on short screens and its footer remains reachable. Both themes retain the indigo launcher and theme-matched sheet.

## Typography

**Body and interface font:** the system sans stack in the frontmatter. There is no separately loaded display face. Monospace is used for generated credentials, including API keys, authenticator setup keys and recovery codes.

The hierarchy is compact: headline for library headings, title for bookmark names, body for the base interface, and label for buttons and field labels. Secondary metadata commonly uses (11px–13px). Dialog headings use 20px. The article reader title scales from 28px to 41px on desktop and from 27px to 34px on compact screens. The sign-in introduction uses (42px) on desktop and (30px) on phones; this is an entrance-specific treatment, not a general display scale.

Login/MFA, settings, help and API documentation use 13px labels/hints and 14px body copy on desktop. Phone fields use 16px.

**The Reading Measure Rule.** Keep reading text within 70ch and give it more leading than workspace metadata.

## Layout

The main column uses the full workspace width unless navigation is pinned. Desktop navigation uses a 280px panel. On smaller screens and touch devices, navigation opens in a full-height native dialog drawer up to 320px wide. The workspace header is (64px) tall; library content has (32px) horizontal padding and a maximum width of (1680px). Between (901px) and (1150px), horizontal padding becomes (24px).

At (900px) and below, header and library padding become (20px). At (600px) and below, search spans its own row, header actions expand, fields use (16px) text, forms become one column, and bookmark actions move beneath metadata. The reader becomes a full-height edge-to-edge dialog. The sign-in split layout stacks on phones.

Library results use one unboxed toolbar beneath search: the result count on the left, selection help, Refresh, the labeled sort button and view switch together on the right. Controls wrap into reachable rows on phones. Capture status appears on each bookmark, without a library-wide capture summary. Selection leaves these controls in place and opens a floating action bar near the bottom of the viewport.

Desktop list rows place the favorite star and a site icon (or neutral bookmark icon when unavailable) before the title and description, with domain and tags in separate columns. Narrow screens retain the stacked metadata layout. The list has its own rounded outline beneath the toolbar. Rows retain trailing state/actions. Select bookmarks by clicking or tapping a free area, using Shift for a range or dragging a mouse selection rectangle; titles and action buttons retain their actions. Focused bookmark groups support Space and Shift+Space, with Escape to clear. A floating selection bar shows the total selection count, with every action exposed on desktop and a labeled clear-selection icon. Phones open the action list and its dedicated forms in a bottom sheet; page padding and toast placement follow its measured height. Its help panel opens on click or keyboard and fits phone widths. Grid uses auto-filled columns with a minimum target of (260px), a (16px) gap and one column on phones. Switching view retains the same bookmark structure and state. Reuse the compact spacing rhythm recorded in the frontmatter rather than introducing spacious promotional sections.

The library reference is the restored interface at `e678b74`. Keep its icon actions, mobile Actions disclosure, sort button/menu, grid geometry, palette and density, with the desktop list-row layout described above and the approved selection bar, search text and mobile action label colors defined under Themes. These library rules belong in `style.css`; preserve its unrelated rules. Secondary refinements belong in `secondary.css`, scoped to login/MFA, settings, help, API documentation, the collection hint and the reader notebook. The settings desk and remote backup panel keep their component-specific rules in `frontend/src/features/settings/desk.css` and `backups.css`. The article panel, capture states and reconstructed article use the locally scoped `reader.css`, `reader-state.css` and `reader-article.css`. Never broaden those selectors to generic application controls.

## Focus and motion

Keep visible keyboard focus and reachable actions in both themes at desktop and phone widths.

Motion preserves context: selected tags settle into their new positions over 180ms, while new tags receive a 150ms entrance. Collection, search and layout changes use a short 180ms content fade; background refreshes stay still. Native dialogs establish depth in 220ms and exit in 140ms, with a matching backdrop; tag suggestions use a 120ms fade. Removed bookmarks exit over 140ms while remaining rows or grid cards settle into place over 200ms; exit layers are inert and hidden from assistive technology. Actions and focus changes never wait for motion. Repeated actions replace in-flight animations. Reduced motion removes spatial transitions and content fades while retaining 80ms control-color feedback. Native overlay transitions progressively enhance the browser's immediate default behavior.

Notes/files and help disclosures use 160ms opacity feedback with immediate reduced-motion fallback.

Manual light/dark changes crossfade the complete view over 240ms using native browser snapshots, keeping text and surfaces synchronized. The first render uses the saved theme immediately. Repeated toggles interrupt the fade and preserve the latest choice; reduced motion and browsers without View Transitions switch immediately. The snapshot overlay does not intercept pointer input.

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
Center button text horizontally and vertically within the control. When an icon
accompanies a label, center the icon and label together as one group. Navigation
and menu rows retain their documented left-aligned layout.

Compact and direct. Primary actions use indigo and white, subtle actions use the active theme’s neutral control surface and border, and icon actions use transparent backgrounds. Primary and subtle controls use the shared control radius and label type. Hover changes background or border with (160ms ease-out) transitions. Keyboard focus has a (2px) outline and (3px) offset; disabled buttons use (.48) opacity. Phone actions increase their target dimensions where the layout requires it.

Use the primary button to start or submit a panel’s main task, or to recover from an empty view. “Create API key” opens the form with an indigo background and white text in both themes. When it is open, the submit button takes the primary treatment and “Cancel” uses the neutral treatment. Navigation, informational disclosures and alternative actions stay quiet. Destructive confirmations use the danger treatment; quiet discard controls signal danger on hover and keyboard focus. Selection and focus keep their own cues without promoting a control to primary.

### Chips
Small rectangular tags use neutral fill, short padding and compact type. Hover or active filter states use the soft accent and indigo text. Long labels truncate rather than widening the navigation drawer.

### Segmented control

Quick filters beneath library search sit on a single recessed track. A raised white thumb in light mode and a pale lavender thumb in dark mode mark the current destination. Fine dividers separate neighboring inactive segments. Center each label with its navigation icon and drop the icons when the track is too narrow. Keep the four labels on one line with 44px minimum targets on phones.

Tab enters the native radio group. Arrow keys switch destinations and slide the thumb into place over 180ms. Reduced motion makes the change immediate. Tag filters stay active when switching segments. A named collection leaves the four global destinations unselected.

### Capture status

Bookmark capture states use compact rounded badges with a text label and an icon: green Captured, amber Queued / Saving…, red Capture failed, and neutral Not captured. Only Saving… rotates a small ring to indicate active capture. Reduced motion keeps the ring still and preserves the label. Light and dark themes use tinted backgrounds with readable semantic foregrounds; badge placement and card actions remain unchanged.

### Toasts

All application feedback shares one toast treatment in `style.css`, including
the library, reader, settings and native dialogs. Use the active theme's
`surface`, `ink` and `line`, a 12px radius, the toast shadow, 13px text and a
20px outline icon. Keep a 60px minimum height, 12px gaps and wrapping messages
within 560px or the viewport minus 32px. The centered bottom position respects
the safe area and moves above the library selection bar.

Informational feedback uses the info icon in `muted`; errors use the warning
icon in `danger` on the same surface. Favorite feedback retains its star, filled
when added, using `accent` in light mode and `focus` in dark mode. Every toast
action uses the same 44px minimum target, 6px radius, `accent-soft` background
and `accent` foreground (`focus` in dark mode), with `control-hover` on hover
and a visible `focus` outline. Preserve the existing durations, focus pause,
Undo and HTML retry behavior.

The Chrome extension uses a check in its success color for a confirmed save
and a warning icon for a failed or partial save. Confirmation appears below the
popup header for 3.5 seconds after success or 8 seconds after failure. Keyboard
or pointer interaction keeps the popup open. The source page retains its own
bottom toast. Both use the extension theme, enter and leave with a short fade
and slide, and appear without motion when reduced motion is requested.
In Chrome’s toolbar, a white
check on the fixed success-green badge marks a saved URL beside the app mark.

### Cards / Containers
Grid bookmark cards use the panel radius, white background and a line border; selection changes both fill and border without a checkbox. A softly tinted header groups the domain and the favorite star, with the full saved URL available on hover. The capture state and remaining actions stay in the footer. List mode removes individual card rounding, separates rows with dividers and retains the same selection, tags, capture labels and actions. Do not add permanent card shadows.

### Inputs / Fields
Field boundaries use control-line (#818896) in light mode and #747b92 in dark mode, providing at least 3:1 against their adjacent field surfaces. Quiet separators keep the line token. Fields retain the control radius and (10px 12px) padding. Focus has a (2px) outline and (2px) offset. Search applies its outline around the complete search container. Read-only fields use the surface fill; form errors appear inline in danger text. Bookmark fields validate the server’s UTF-8 size limits before submission and identify the field to correct. Network/session failures give recovery instructions while retaining unsaved work.

Collection name fields show a red message only when the server UTF-8 limit is exceeded.

Single-choice selectors use the same field boundary and an authored chevron. Their option panels use the active theme's paper, ink, line and accent-soft tokens, a compact radius and a restrained shadow. The current choice is identified by an indigo check and selection treatment; focus is visible independently. Collection choices retain their hierarchy, and long lists scroll within the available space. Menus stay reachable within dialogs, the extension popup and phone viewports, with at least 44px option targets on phones. Keyboard and assistive-technology users can identify, open, navigate and dismiss each selector. The extension's tag suggestions follow the same theme-matched menu vocabulary while retaining free-form tag entry.

Authenticator setup pairs a QR code on white with a labeled, read-only manual key. Recovery codes use selectable, scrollable text in a bordered surface, with a copy action and a manual-selection fallback.

### Navigation
The slate-tinted drawer combines outline icons, sentence-case labels and compact counts. Its Pocketmark mark is the canonical `internal/webui/static/icon.svg`: a white serif “p.” on an indigo square, with the same fixed brand colors in both themes. Initialization, sign-in/MFA, navigation, settings, API documentation, favicon/installable app, the Chrome extension and README reuse this asset. Preserve each surface’s existing mark dimensions and use empty alternative text beside the Pocketmark name. Active navigation uses pale indigo and stronger text.

On desktop, resting the pointer at the left edge for 160ms opens navigation over the library. Leaving gives the pointer 320ms to return before the panel starts closing. The header menu opens it immediately, keyboard focus keeps it visible and Escape dismisses it. Pinning the panel reserves its width and persists in the browser. On smaller screens and touch devices, the header opens a modal drawer. Its close button, Escape, backdrop and destination choices dismiss it. The panel eases into view over 320ms and out over 260ms. Reduced motion skips the slide. Smaller screens give controls more height.

The header breadcrumb links to the library and every collection ancestor. It scrolls horizontally on narrow screens, initially showing the current location; earlier levels remain reachable by scrolling or keyboard. Breadcrumb controls retain visible focus outlines and 44px phone targets.

### Tag directory
Tags has a primary navigation entry. Keep up to 12 most-used tags as quick filters at the bottom of the sidebar, including while browsing the directory. The directory groups names under letter headings in three columns on wide screens, two on medium screens and one on phones. Compact counts sit beside each name. A sticky vertical A–Z rail (plus `#` for other initials) jumps across the paginated directory, disables unavailable letters and moves keyboard focus to the selected heading. Search narrows both the index and available letters. Fetch at most 40 tag rows and 27 group totals per request.

### Navigation, scope and drafts
Bookmark and bulk tag fields show each selected tag in a compact bordered chip with a labeled remove button. The field wraps and grows to keep every selected tag visible, including long names; it has no internal scrolling or truncation. Frequent existing tags appear on focus and the full directory is searched as the user types. Suggestions show bookmark counts, exclude tags already present, and support arrow keys, Enter and Escape. New tags can be committed with Enter, commas or by leaving the field. Backspace in an empty search focuses the last remove button. Results are bounded and suggestion failures leave manual entry available.

The library URL preserves the destination, search, selected tags, sorting, pagination and tag-directory state. Back/Forward and reload restore that context, including scroll position from browser history. The heading and breadcrumb name the current destination. Selecting a tag narrows its results to bookmarks matching every selected tag. Bookmark tags, frequent tags and directory entries show selected tags with a check and a soft indigo background.

Show active filters between the quick filters and the results toolbar, including when the result list is empty. Give each selected tag an indigo chip with its full name and a close icon. A neutral chip identifies the active search. Each chip is one removal button. Chips wrap on narrow screens and provide 44px phone targets. Removing a tag focuses the next chip, the previous chip, or the library heading when all filters are gone.

Selection summaries show the total selected count. Bulk panels initialize a fresh form for the action chosen in the floating bar or phone sheet.

Bookmark, reader-note and annotation drafts stay in the current tab. A bounded sessionStorage cache restores them after reload; denied storage or quota failures fall back to memory without preventing edits. Reopening a form restores drafts, and reader notes carry into the bookmark editor. Notices name the tab lifetime, discard removes unsaved changes, and leaving/reloading warns while drafts remain. Signing out always opens a confirmation alertdialog, with Cancel focused first and an additional warning when this tab has unsaved drafts. Confirming sign-out clears the cache after the request succeeds; request errors remain in the dialog. Drafts are not stored in localStorage, URLs or on the server. Saving notes retains unrelated unfinished editor changes.

In grid view, Favorite sits at the right of the card header; in list view, it remains immediately before the title. The other four actions stay grouped at the right. Borderless action icons are 18px with 32px desktop targets, theme-matched hover/focus backgrounds and native title tooltips. Selected favorites retain a filled star, and Delete uses danger colors on hover/focus. Mobile bookmark actions retain an accessible Favorite control and disclose the other labeled commands under Actions. Quick favorite/read changes confirm with an Undo action; feedback appears inside any active native dialog so its message is visible and announced. Search-only excerpts highlight matches and display decoded tag names. Near-match scope is visible beside its checkbox: titles, URLs, descriptions and tags only. Task-based Help is searchable from the navigation.

Opening a bookmark displays its article in a right-hand reader panel. Lead with the article title, then the source and reading time when available. Align the title, divider and article on the same reading column. Give section headings, quotations, figures and captions distinct spacing. Images can be enlarged. Code has copy and line-wrap actions. Use captured text when a rich copy is unavailable.

Show capture failures in a compact panel beneath the title. Group the status icon, known cause and retry action together. Keep any previously saved article or files accessible. Queued captures offer a status check. If there is no article or capture in progress, show one empty-state label. The toolbar provides access to the original page for web bookmarks.

### Settings

Settings is directly available in the library navigation. Library tools groups import, export and sign-out. Import first explains JSON/browser HTML metadata files and the 8 MiB limit, then leaves a durable result in the library. Sync provides a copyable WebDAV address and ordered instructions; mobile/browser settings explain installation, extension access and the local single-key shortcut preference.


The Settings overview opens from library navigation. Its searchable index groups Appearance and Backup & restore under Library, Two-factor authentication, Browser sessions and Password under Account & security, and AI tagging, API keys, Browser bookmark sync and Mobile & browser under Connected apps. Appearance shows theme previews and the single-key shortcut switch. The backup card uses a local illustration for each theme and opens the backup panel.

The Backup & restore panel opens on the schedule, destination, retention and recent runs. Show retention as a duration, initially **7 days**. Each history row starts with a keyboard-accessible Backup ID and ends with a right-aligned start timestamp. On phones, keep the ID, result and start time. A failed retention step keeps its failure label and separately shows when the remote copy was verified in run details. Use the same details dialog for queued manual requests and completed runs.

Every destination shares the Pocketmark header, its theme switch and a return to the library. On desktop the 280px grouped rail sits below the sticky 64px header. It scrolls independently on short screens. At 900px and below, the 58px header and Overview breadcrumb give access to the index. The active section has a shareable URL and survives reload and browser history. Returning to the library restores its filters and scroll position.

Use a single page title, 26px on desktop and 24px on phones, with compact 13px navigation and metadata labels. Phone controls have 44px targets and fields use 16px text. Scoped settings styles share the library’s palette, type and brand dimensions. Keyboard navigation moves focus to the destination title.

Password and Account security show sign-in details in rows with a related action at the end of each row. Change password opens a dialog with current, new and confirmation fields, individual visibility controls and live feedback. Password composition suggestions are optional. Account security groups password, authenticator and recovery codes. Authenticator replacement and code regeneration each open their own verification flow. Keep newly issued recovery codes accessible until the owner dismisses them. Protect pending changes and clear credentials on departure.

Sessions groups the current browser separately from other browsers. Show the browser, last activity and recorded sign-in IP on each card. Session details disclose sign-in time, expiry and the raw browser description. Confirm sign-out with the selected browser’s name. Keep refresh and the current browser’s inactivity timeout alongside the list.

API keys shows capacity, the next active key to expire, status filters and a search by name or role. The table displays name, role, last activity, status and actions. Phones use labeled stacked rows. A detail panel groups permissions, expiry, rename, rotation and revocation. The status switch controls access. Revocation becomes available after disabling the key and requires confirmation. Create key offers Reader, Editor, Sync and Full Access with a permissions description and expiry choices. Show a newly issued key once in a copyable, initially masked field.

Entering Settings settles the workspace 12px from the right over 220ms with a light fade, paired with a 180ms navigation fade. Initial loads and section changes remain still; leaving cancels the entrance. Focus and controls update immediately. Reduced motion skips both effects.

### Reader and dialogs

<a id="interface-refinement--31-october-2026"></a>

The reader toolbar keeps three icon buttons for HTML, screenshot and PDF. Available copies use the accent. Unavailable formats stay visible and disabled, with accessible status. Each shortcut opens the latest saved copy of its format. The viewer provides earlier copies. The toolbar also offers Open original, Notes, text size, fit to page and Close.

The **Aa** button opens a compact popover with small and large A markers above a graduated track. A round, indigo-outlined thumb marks the selected size, also shown in pixels. The seven stops are 15, 17, 20, 22, 24, 28 and 32 px. The reader starts at 17 px and applies each adjustment immediately to both the saved article and its text view. The slider supports touch, pointer and keyboard input. Escape dismisses the popover and returns focus to **Aa**.

The bookmark editor keeps its heading and save/cancel footer visible around a scrolling form body. URL, title and organization lead; description and notes are disclosed together and open automatically for existing content or drafts. Secondary controls use semantic surface, ink, border and hover tokens in both themes.

The bookmark editor offers an unchecked **Save an HTML copy** option for website bookmarks. Capture starts after metadata is saved, reports partial failure without undoing the bookmark, and offers a capture-only retry. Standalone files hide this option. Saved files in the reader focus on attachments and previews; PDF capture stays in the Chrome extension.

Dialogs use theme-matched panels, a dimmed backdrop, labeled headings and separated footer actions. The reader keeps its toolbar above a scrolling article with a comfortable line length. Fit to page fills the Pocketmark viewport and appends the current bookmark to the library breadcrumb. The return control and Escape restore the side panel at the current reading position. Notes and Highlights share a companion pane on wide screens and a separate view on narrow screens. Highlight excerpts retain their saved colors.

## Do's and Don'ts

### Do:
- Do preserve visible keyboard focus and text labels for capture states.
- Do use authored outline SVG icons with accessible names on icon-only controls.
- Do reflow rows and keep their actions available on phones.
- Do honor reduced motion, keep transitions brief and leave actions immediately available.

### Don't:
- Don’t add team or public-sharing visual concepts to this personal workspace.
- Reuse the existing React/shadcn primitives and authored icons. Keep fonts local; justify additional runtime dependencies against the frontend guide.
- Don’t use color alone to communicate capture status.
