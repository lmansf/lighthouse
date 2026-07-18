# Tasks — usability field patch (one commit per numbered section)

## 1. Resizable explorer (engine setting, then UI)
- [ ] 1.1 Engine: add a per-mode explorer width to `settings.rs` (an `extra`-map
  key like `widgetPos`, or a modeled `Option`), clamped to [MIN,MAX] at write +
  read; mirror in `src/server/settings.ts` + `app/api/settings/route.ts`
  (GET+POST whitelist); extend `settings_test.rs` (destructure + wire-key array +
  writer-call). VERIFY: `cargo test -p lighthouse-core settings`.
- [ ] 1.2 UI: a divider handle in `AppShell.tsx` between `<Sidebar>` and
  `<div.main>` — pointer + arrow-key resize, min/max clamp, drag suppresses the
  width transition, dynamic width via an inline CSS var; collapse-to-rail
  preserved. Persist per `uiMode` to `localStorage` (web-testable) + `/api/settings`
  (desktop). Double-click auto-fits to the widest visible row name.
- [ ] 1.3 UI: enrich `FileExplorer.tsx` truncated rows' native `title` with the
  full name + reconstructed path (primitive-string prop; no per-row Fluent
  Tooltip; `VROW_H`/windowing unchanged).
- [ ] 1.4 Web E2E (Playwright): resize by drag + keyboard, reload → width persists
  (localStorage); auto-fit reveals a long fixture name. Before/after screenshots.
  DEFERRED: the real desktop-relaunch app-state persistence (built app).

## 2. Attachments (@-mention now; native drag deferred)
- [ ] 2.1 UI: an inline `@`-mention picker in the `ChatPanel` composer reusing
  `quickOpenMatches` + `emphasize`; Enter/click inserts a removable pill via the
  existing `addAttachments`, strips the `@fragment`; multiple mentions; regular +
  linked files. Scoping unchanged.
- [ ] 2.2 Web E2E: `@`-mention a fixture by fragment → pill → answer cites it;
  two mentions → two pills; each removable. Screenshot the picker.
- [ ] 2.3 Record the widget limitation (separate input, no attachments) as a noted
  follow-on in the PR. DEFERRED (built app): reproduce + root-cause the native
  drag-from-explorer regression for regular + linked nodes, the folder-drop hint,
  and the OS-file-drop link-first non-regression.

## 3. Customization (engine + directive, then UI)
- [ ] 3.1 Engine: appearance keys in `settings.rs` (themePreset, accent, density,
  fontScale, backgroundImage ref + scrim), validated (enums/ranges); twin +
  `/api/settings` + `settings_test.rs`.
- [ ] 3.2 Engine: the appearance directive — `APPEARANCE_DIRECTIVE_FENCE`, a
  parse fn (whitelist keys, ignore extras) + validate fn (enum/range/contrast),
  mirroring `parse_chart_directive`/`validate_directive`; generalize
  `DirectiveScrubber` to accept the fence it scrubs; wire the appearance card into
  the prompt. Twin `src/lib/appearanceSpec.ts` (byte-identical whitelist + error
  strings). Unit tests (Rust + `test/*`).
- [ ] 3.3 Contrast: add the curated accent set + the background-image case to
  `scripts/check-contrast.mjs` + `theme.ts`; the script stays green on both themes.
- [ ] 3.4 UI: an Appearance section in `PreferencesDialog` (theme preset, accent,
  density, font scale, background upload + scrim + reset); background copied to
  app-state, downscaled, rendered behind the chrome only with opaque content
  surfaces; theme provider applies preset/accent/density/fontScale.
- [ ] 3.5 UI: the ask-to-adjust apply path — a valid appearance directive applies
  + shows an "Applied — Undo" chip (Undo restores the prior snapshot); invalid /
  out-of-vocab → polite note, no change.
- [ ] 3.6 Web E2E: switch preset + accent in Preferences; upload a background →
  content surfaces stay opaque (contrast script run with image active); a
  mocked-provider "make it compact" applies density + Undo reverts; an
  out-of-vocabulary ask changes nothing. Screenshots: each preset, background+scrim.

## 4. Exportable reports
- [ ] 4.1 A shared `composeReportHtml(title, body, charts, theme)` (extending the
  `evidencePack.ts` shell + `standaloneChartSvg`) → self-contained HTML, ZERO
  external refs; a markdown export via `exportChat`; the Export menu on each
  report surface (deep-analysis, briefings, evidence pack, board, Notes).
- [ ] 4.2 PDF path: ship the system-print / "Save as PDF" over the HTML; state
  which path shipped. DEFERRED (built app): the wry direct print-to-PDF API check.
- [ ] 4.3 Web E2E: export a fixture report → HTML greps clean of external URLs +
  charts render; markdown round-trips; the shipped PDF path is exercised.
  Screenshot the export dialog.

## 5. Housekeeping
- [ ] 5.1 Triage the open moderate Dependabot alerts on main via the supply-chain
  allowlist flow — fix (bump) or justify (allowlist entry with a reason).

## 6. Release + verify + no-bump/parity confirmation
- [ ] 6.1 Full gates GREEN: `cargo test -p lighthouse-core -p lighthouse-server`;
  `npm run test`; `tsc --noEmit`; `next lint`; `analytics_eval`/`chart_eval`
  floors; `scripts/check-contrast.mjs`; `node scripts/openspec-validate.mjs --all`;
  desktop `commands.rs` arms grep-verified. Playwright web E2E per section + the
  before/after web screenshots attached to the PR.
- [ ] 6.2 Confirm NO `CACHE_VERSION` bump (stays 12); the appearance/export paths
  touch no cached-answer wire shape. State it.
- [ ] 6.3 Five-stamp bump 0.12.2 → 0.12.3 (package.json, package-lock ×2,
  native/Cargo.toml, tauri.conf.json, native/Cargo.lock ×5 crates); stamps agree.
- [ ] 6.4 One PR (one commit per numbered section), notes led by drag-to-attach
  restored (with the honest deferred note) + the customization surface; the
  customization-axes decision table + the honest PDF-path note + the gate-status
  table (in-container ✓ vs. needs-built-app). Squash-merge, dispatch
  `desktop-release.yml`, watch to the draft, STOP, report the draft link + publish
  inputs.
