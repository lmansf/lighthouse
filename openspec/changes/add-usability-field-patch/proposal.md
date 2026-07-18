# Usability field patch — readable names, real attachments, customization, exportable reports

## Why

Four owner-reported gaps in day-to-day use, none of them about the engine's
correctness — all about the app being livable:

1. **"I can't see file names."** The explorer is a fixed width; long names
   truncate with no way to widen it and no tooltip.
2. **"Drag-and-drop doesn't work; let me reference files I know."** The
   drag-from-explorer-to-chat attach that shipped in the Electron era no longer
   attaches in the Tauri build, and there is no keyboard-first way to attach a
   file you can name.
3. **"Themes, a background image, and asking for changes."** Appearance is fixed
   to the two Beam themes; there is no personalization surface and no way to ask
   the assistant to adjust the look.
4. **Reports aren't exportable.** A deep-analysis report, a briefing, or an
   evidence pack lives in the vault as markdown but can't be handed to someone as
   a self-contained HTML or PDF.

This is a single field patch (one PR, one commit per numbered section), bumping
the patch version on the current line, with the §14 constitution as the review
bar: no arbitrary code or CSS execution, nothing leaves the machine.

## What Changes

- **Explorer resize (§1):** a draggable divider between the explorer and the
  chat — pointer + keyboard resize, sensible min/max, width persisted per window
  mode in the app-state dir, double-click auto-fit to the widest visible name.
  Truncated rows get a full name+path tooltip. The collapse-to-rail behavior is
  preserved; the 0.8.1 virtualization keeps its performance.
- **Attachments (§2):** an `@`-mention inline fuzzy file picker in the ask box
  (reusing the quick-open matcher) that inserts removable attachment pills, and
  the restoration of drag-from-explorer-to-chat attach for regular and linked
  files. Attachment scoping is unchanged — a pill scopes the question exactly as
  today.
- **Customization (§3):** an Appearance section in Preferences — theme preset,
  a curated accent set, density, font scale, and a user-uploaded background image
  shown only behind the chrome — every key engine-validated and stored in the
  app-state dir. Appearance intents ("make it darker", "blue accent", "use my
  photo") route through the established fenced-directive pattern onto the
  whitelisted keys only, applied with an "Applied — Undo" chip. This is a
  settings patch, never code.
- **Export (§4):** an Export menu on every report-shaped document —
  self-contained HTML (inline styles, charts as inline SVG, zero external
  references), a PDF path, and raw markdown copy/save. All local, sanitized file
  names.
- **Housekeeping (§5) + release (§6):** triage the open moderate Dependabot
  alerts via the supply-chain allowlist flow; a five-stamp patch bump, notes led
  by drag-to-attach restored and the customization surface, to a
  `desktop-release.yml` draft.

## Environment split (verification honesty)

This change is authored where the Tauri desktop app cannot be built or displayed
(no webkit/gtk, no display). Everything runnable here is verified here — the Rust
engine + TS twin (`cargo`/`npm`/`tsc`/lint + the eval/chart/openspec floors + the
contrast script), the React surfaces under Playwright against the web build
(with before/after screenshots), and the desktop-command grep-verify. The
built-app-only gates are **deferred and documented, never claimed**:

- §2's native drag-from-explorer regression **root-cause + fix in the built app**
  (the `@`-mention path ships now; the native-drag repair is a follow-on on a
  build-capable machine);
- §1's real desktop-relaunch width persistence (the engine setting round-trip is
  tested; the app-state relaunch is a built-app check);
- §4's **wry/Tauri print-to-PDF** direct-API confirmation (the system-print /
  "Save as PDF" fallback + the self-contained HTML ship now);
- the live built-app E2E per section and the desktop screenshots.

The PR carries a gate-status table marking each of these `needs built app`.

## Non-goals

- **No arbitrary custom CSS or code execution.** Customization is a fixed set of
  whitelisted, engine-validated keys; the ask-to-adjust path emits a settings
  directive, never markup or code. (Decision recorded in `design.md`.)
- **No free-form accent colors.** Accents are a curated set, each of which passes
  the repo's WCAG-AA contrast script against both themes; a color picker is out.
- **No per-surface background images.** The background sits behind the canvas
  only; content surfaces (cards, chat, explorer rows, dialogs) stay opaque
  tokens so readability and AA hold regardless of the image.
- **No new egress.** The background image is copied into the app-state dir and
  never leaves the machine; exports are local file writes; the ask-to-adjust
  directive rides the existing answer stream, same as chart directives.
- **No CACHE_VERSION change.** None of this touches the cached-answer wire shape,
  `AnalyticsMeta`/`ChunkMeta`, or the extract cache.
- **Native drag repair, desktop-relaunch persistence, and the wry PDF direct
  API are deferred** (see the environment split) — not abandoned.

## Affected areas (exact files refined in design.md after surface recon)

- Engine (Rust): `native/crates/lighthouse-core/src/settings.rs` (appearance +
  explorer-width keys), a new appearance-directive parser/validator, the
  report-export renderer (HTML), `tests/settings_test.rs`; the contrast script.
- Twin (TS): `src/server/` settings mirror + the appearance-directive twin per
  `docs/ts-twin.md` and PARITY.
- Desktop shell (Rust): `commands.rs` arms mirror any new op (grep-verified);
  background-image copy/downscale + the wry PDF investigation are the deferred
  shell pieces.
- UI: `src/shell/AppShell.tsx` (divider), `src/features/explorer/FileExplorer.tsx`
  (tooltips), `src/features/chat/ChatPanel.tsx` (`@`-mention + Export menu),
  the Preferences dialog (Appearance section), the theme provider (tokens),
  `src/contracts/*` (settings + appearance-directive + export ops), `test/*`.
- OpenSpec: this change (`explorer-resize`, `chat-attachments`, `appearance`,
  `report-export` capabilities).
