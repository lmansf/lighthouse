# Design — usability field patch

Engine ships (Rust `lighthouse-core`); the TS twin mirrors per `docs/ts-twin.md`
and PARITY. UI rides the Beam tokens (`src/shell/theme.ts`). The §14 constitution
is the bar: no arbitrary code or CSS execution, nothing leaves the machine.

## Environment split (what is verified here vs. deferred)

Authored where the Tauri desktop app cannot be built or displayed. Verified here:
the Rust engine + TS twin (`cargo`/`npm`/`tsc`/lint + eval/chart/openspec floors +
`scripts/check-contrast.mjs`), the React surfaces under Playwright against the web
build (with before/after screenshots), desktop-command grep-verify. Deferred to a
build-capable machine, **documented in the PR, never claimed verified**: §2 native
drag reproduce/fix in the built app, §1 real desktop-relaunch width persistence,
§4 wry print-to-PDF direct API, and the live built-app E2E + desktop screenshots.

## §1 Explorer resize

- **Handle:** a divider between `<Sidebar>` and `<div.main>` in `AppShell.tsx`
  (root is flex, sidebar `flexShrink:0`). Griffel `makeStyles` is build-time
  atomic — the dynamic width rides an inline CSS var (`style={{"--sidebar-w":…}}`,
  the `FileExplorer.tsx:631` precedent), static handle styling stays in
  `makeStyles`. The `transitionProperty:"width"` on the sidebar (used for the
  collapse animation) is suppressed during a live drag so the handle tracks the
  cursor. Pointer drag + arrow-key resize when focused; min/max clamp.
- **Persistence (per window mode):** the width is an engine-validated settings
  value in the app-state dir, keyed by `uiMode` (`window`/`widget`) — following
  the `widgetPos` precedent (an `extra`-map key hand-persisted through the
  read-modify-write in `settings.rs`), clamped to the bounds at write AND read.
  The UI also caches to `localStorage` per mode (the `SIDEBAR_COLLAPSED_KEY`
  pattern) for instant hydration and so the WEB build's Playwright E2E can prove
  resize→reload persistence (the `/api/settings` POST is desktop-only-guarded, so
  the settings-file round-trip is proven by `settings_test.rs`, the desktop
  relaunch by the built-app check).
- **Auto-fit:** double-click measures the widest visible row name (canvas text
  metrics on the windowed rows) and sets the width to fit, bounded by max.
- **Tooltip (regression-safe):** enrich the row's existing native `title`
  attribute (no new DOM) with the full name + a path reconstructed by walking
  `parentId` via the parent's `nodeById` map, passed as a **primitive string**
  prop so `memo(TreeRow)` and the fixed `VROW_H` windowing are untouched. NOT a
  per-row Fluent `<Tooltip>` (a portal mount per windowed row = the regression).

## §2 Attachments

- **@-mention (ships now):** typing `@` in the composer opens an inline picker
  (the ask-type-ahead `role="listbox"` pattern already above the textarea),
  ranked by the existing `quickOpenMatches(query, nodes, {limit})`
  (`src/lib/quickOpen.ts`) — the same matcher quick-open uses, reusing
  `emphasize()` for hit highlighting. Enter/click inserts the file as a removable
  attachment via the existing `addAttachments`/`attachmentBar`/`removeAttachment`
  path; the `@fragment` token is stripped from the question text. Multiple
  mentions per ask. Attachment scoping is UNCHANGED — pills become `attachmentIds`
  at send exactly as today. Regular and linked (`FileNode.external`) files both
  match (the `kind==="file"`, non-connector-id rule; NOT filtered on `external`).
- **Widget:** `WidgetBar.tsx` reimplements its own input and passes no
  attachments; @-mention does NOT reach it for free. v1 wires @-mention in the
  main composer only and records the widget as a noted follow-on (per the spec's
  "else note it").
- **Native drag (deferred):** the internal explorer→chat DOM drag
  (`FILE_DRAG_MIME` + `dropHandlers`) is engine-independent and appears wired; the
  desktop-native OS-drop path (`lighthouse:os-drop` → `attachOsPaths`, the
  `elementFromPoint` chat/explorer hit-test) is the piece that needs the built
  Tauri app to reproduce + root-cause. The `@`-mention gives a keyboard-first
  attach now; the drag repair is the documented follow-on.

## §3 Customization

Whitelisted, engine-validated appearance keys stored in the app-state dir
(`settings.rs` + the TS twin + `/api/settings`): `themePreset`
(`beam-light`|`beam-dark`|`auto`), `accent` (a curated enum, each passing
`check-contrast.mjs` on both themes), `density` (`comfortable`|`compact`),
`fontScale` (`s`|`m`|`l`), and `backgroundImage` (a copied-in file ref + a `scrim`
0–100). Validation lives in the engine writer (enums, ranges) exactly like
`ui_mode`/`briefing_note_hour`; the round-trip is pinned by `settings_test.rs`
(the new wire keys added to the destructure + wire-key array).

- **Background image:** uploaded → copied into the app-state dir (never egresses)
  → downscaled to a sane pixel/byte budget (engine `image` crate) → rendered ONLY
  behind the canvas/chrome via a fixed backdrop layer. Content surfaces (cards,
  chat bubbles, explorer rows, dialogs) keep opaque neutral tokens, so AA holds
  regardless of the image; a bounded `scrim` overlay darkens/lightens the backdrop
  for legibility; one-click reset. The contrast script gains a background-image
  case (quiet text vs. the scrimmed backdrop's effective backing).
- **Ask-to-adjust (the fenced-directive mirror):** a new
  `APPEARANCE_DIRECTIVE_FENCE = "```lighthouse-appearance-request"`, parsed +
  validated engine-side exactly like the chart directive — the model emits ONE
  fenced JSON block naming ONLY whitelisted keys; unknown keys ignored; invalid
  enum/range/contrast → rejected. `DirectiveScrubber` is generalized to accept the
  fence it scrubs (today hardcoded to `CHART_DIRECTIVE_FENCE`) so both directives
  stream cleanly. A valid directive is applied to the appearance settings + theme
  store with an inline **"Applied — Undo"** chip (Undo restores the prior
  snapshot); an invalid/out-of-vocabulary request yields a polite explanation and
  NO change; no directive → a normal answer pointing at Preferences. Works on
  every provider (plain text protocol). This is a settings patch — it maps only
  onto the whitelisted keys and can emit no markup, CSS, or code.

### Customization axes considered — the recorded decision (the boundary)

| Axis considered | Decision | Why |
|---|---|---|
| Theme preset (light / dark / auto) | **Adopt** | Two AA-verified Beam themes already exist; auto follows the OS. Zero contrast risk. |
| Accent color | **Adopt as a CURATED ENUM** | Personalization users want, but every accent must pass `check-contrast.mjs` on both themes. |
| Free-form accent (color picker) | **REJECT** | Arbitrary hex can't be guaranteed AA against text/surfaces; a picker invites unreadable UIs. Contrast risk. |
| Density + font scale | **Adopt (enums)** | Bounded, layout-safe, no contrast interaction. |
| Background image (behind chrome) | **Adopt, canvas-only** | The requested personalization, made safe by keeping content surfaces opaque + a scrim. |
| Per-surface / per-panel images | **REJECT** | An image behind text (cards, chat, rows) destroys readability and AA unpredictably. Readability. |
| Arbitrary custom CSS / theme file | **REJECT** | A support burden and an injection/exfiltration surface (CSS can load remote URLs, leak layout) — violates "no arbitrary CSS/code, nothing leaves the machine." Support burden + injection surface. |
| Ask-to-adjust via a settings directive | **Adopt** | Reuses the audited fenced-directive pattern; maps ONLY onto the whitelisted keys, validated engine-side. Never code. |
| Ask-to-adjust emitting CSS/markup | **REJECT** | Same injection/execution surface as custom CSS; the directive is a settings patch by construction. Injection surface. |

## §4 Export

Every report-shaped document (deep-analysis reports, briefings, evidence packs,
board exports, Lighthouse Notes/transcripts) gains an Export menu:

- **(a) Self-contained HTML** — reuse the `evidencePack.ts` shell
  (`composeEvidencePack`/`composeBoardPack` already inline `PACK_CSS` + charts as
  `standaloneChartSvg` with ZERO external references). A shared
  `composeReportHtml(title, markdownOrSections, charts, theme)` renders any report
  to one HTML string: inline styles, tabular numerals, charts baked to inline SVG,
  light/dark chosen at export. A test greps the output for `http`/`https`/`//`
  hrefs/srcs to prove zero external refs.
- **(b) PDF** — `wry`/Tauri offers no confirmed direct print-to-PDF API in this
  environment; v1 ships the **system-print / "Save as PDF"** path (open the
  self-contained HTML in the print flow) and STATES in the PR that the fallback
  shipped; the direct-wry-API investigation is the deferred built-app step.
- **(c) Markdown** — copy to clipboard / save via the existing `exportChat`
  allowlist write (`Lighthouse Notes`/`Results`, ext `md`), the vault-write model
  (no OS save-dialog exists). Sanitized names via `write_artifact`'s repair.

## Parity & degradation

- Settings appearance keys + the appearance directive parse/validate are twinned
  (`src/server/settings.ts`, a `src/lib/appearanceSpec.ts` mirroring
  `chartSpec.ts` byte-for-byte on the whitelist + error strings). The HTML report
  composer is TS-side (the UI owns rendered charts), so no Rust twin gap.
- Degradation: an unparseable/invalid appearance directive → no change + a polite
  note (never a partial apply); a missing/oversized background image → reset to no
  image; an out-of-range width → clamped; export of an empty report → a valid
  minimal document, never an error. No 6144-window interaction (these paths carry
  no model context growth).

## No bump to CACHE_VERSION

None of this touches the cached-answer wire shape, `AnalyticsMeta`/`ChunkMeta`, or
the extract cache. `CACHE_VERSION` stays 12; the version stamps move only for the
§6 patch bump (0.12.2 → 0.12.3).
