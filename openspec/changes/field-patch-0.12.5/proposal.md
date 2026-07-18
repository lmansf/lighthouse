# Field patch 0.12.5 — sectioned sidebar, visual-first answers, a measured verdict on business definitions

## Why

Three owner notes on the 0.12.x line, each about making Lighthouse clearer and
more honest. Rust engine ships; the TS twin mirrors it byte-for-byte per
`docs/ts-twin.md` (PARITY comments mark deliberate divergences). Beam tokens for
all UI. The §14 constitution is the review standard: **visuals render only from
engine-verified data, never from model prose.** No new egress; no
`CACHE_VERSION` change (none of these touch extraction/caching).

1. **The left sidebar is a flat stack.** Seven sections render top-to-bottom
   with the Files tree buried *last* (`app/page.tsx:88-99`). Make the Files tree
   the anchor at the top, and move every other section below it as header-only
   rows that slide out a second panel on click. The sidebar then reads as "your
   files, plus drawers for everything else."
2. **Answers under-use visuals.** The deterministic emitter already draws charts
   from verified query batches (`analytics.rs::decide_chart`), but two
   engine-verified surfaces render as prose only: profiled document tables
   (`table_profile.rs` → a `[TABLE PROFILE]` text block) and meta/catalog counts
   (`meta.rs::count_line` → a markdown line). Make a visual the default whenever
   an answer carries engine-verified quantitative data — a stat tile for a
   single number, a compact bar/tile row for counts, a chart for a profiled
   table — inside the constitution's hard boundary.
3. **Do the manual business-definition components earn their keep?** The
   semantic layer ships hand-authored **metric definitions**, **column
   synonyms**, and **declared join hints (+ backing entities)**. Measure each
   one's lift on the analytics + trust scorecards (`analytics_eval.rs`), then
   keep-and-auto-derive what helps and remove what doesn't — so manual authoring
   becomes optional polish, never a prerequisite for good answers.

## What changes

### §1 — Sectioned sidebar with flyout panels
- Reorder `app/page.tsx`: `FileExplorer` moves to the top and anchors the panel.
  The other six real sections — `InsightsNav` ("What stands out"), `SemanticNav`
  ("Business definitions"), `CapabilityNav`, `RecipesNav`, `ViewsNav`
  ("Library"), `InvestigationsNav` — become **header-only rows** below it.
- Clicking a section header slides out a **second left panel** holding that
  section's full UI. One flyout open at a time; re-click / `Esc` / click-outside
  closes. Open-section + flyout-width persist to the shell settings file by
  reusing the 0.12.3 resize machinery (`AppShell` handle → `POST /api/settings`
  → `setExplorerWidth` idiom; new `flyoutWidth` + `openFlyout` keys). Long lists
  virtualize like the file tree.
- Fully keyboard navigable (headers focusable, `Enter` opens, arrows move
  between sections); both themes; the file-tree virtualization
  (`flattenVisible` + `VirtualRows`) must not regress — measured by row-mount
  count before/after. Keep the first-run tour copy accurate
  (`FirstRunTour.tsx` steps anchored to `data-tour="explorer"`/`"settings"`).

### §2 — Visual-first answers
- Broaden the engine-built visual vocabulary: a single verified number → a stat
  tile inline in the answer (reuse boards' `detectStat`/`StatValue`); meta/
  catalog counts (`count_line`/`countLine`) → a compact bar or tile row; a
  profiled document table (`table_profile`) → chartable via the SAME emitter +
  chart floor; dated series → line/band as today.
- Policy: every answer whose content includes engine-verified quantitative data
  SHOULD render a visual by default; the only skip is genuinely non-visual
  content (pure prose, single-fact lookups where a tile adds nothing — the lint
  gate's "suppress with a stated reason" applies). The chart card + guidance
  update to encourage requesting a visual whenever data supports one; the
  deterministic emitter remains the fallback and floor.
- **Hard boundary (constitution):** visuals ONLY from query batches, catalog
  data, or engine-profiled tables — never from model prose. A number that
  appears only in narration is not chartable.

### §3 — Business definitions: measure, then decide
- Add a per-kind ablation hook (env-gated, at `semantic.rs::eligible_for_posture`
  — the seam that already partitions metrics/synonyms/entities/joinHints) so
  each component can be turned off for measurement without a shipped setting.
- Run the analytics + trust-check scorecards (`analytics_eval.rs`) on the
  fixture vaults **and** a realistic messy fixture, with each of the three
  manual components (metric defs, synonyms, declared joins/entities) ablated
  on/off. Auto-derived join hints (`analytics.rs::join_hints`) are NOT on trial.
  Record per-component pass rates in the PR and in `docs/analytics-beam.md`.
- **Decision rule (stated up front):** a component with negligible lift (< ~2
  points on the scorecards and no qualitative save in transcripts) is REMOVED
  (UI, storage, prompt injection, docs). A component with real lift is KEPT but
  the authoring cost moves off the user via auto-derivation:
  - synonyms → deterministic derivation from column names/values (abbreviation
    expansion, fuzzy stems), **proposed, not silently applied**;
  - metric definitions → mined from usage (`propose_metric` over recurring
    expressions in `answer_cache`/`views`/`pins`), surfaced as one-click "save as
    metric";
  - the brief → **newly built** (owner-approved): pre-drafted from what the
    engine already knows (vault composition, dominant tables, date ranges),
    editable. (A vault brief does not exist today, so it is NOT in the ablation —
    it is the auto-derive deliverable.)
- End state regardless of verdict: manual authoring is OPTIONAL polish, never
  required for good answers. Numbers + decision land in `docs/analytics-beam.md`.

### §4 — Housekeeping
- Triage remaining moderate Dependabot alerts via the supply-chain allowlist
  flow (`native/audit.toml` + `.github/workflows/supply-chain.yml`) — fix or
  justify with a dated rationale.

### §5 — Release
- Five-stamp bump `0.12.4 → 0.12.5` (package.json, package-lock ×2,
  native/Cargo.toml, tauri.conf.json, native/Cargo.lock ×5 lighthouse crates).
- One PR, **one commit per numbered section**. Squash-merge, dispatch
  desktop-release.yml, watch to the draft, **STOP and report the draft link +
  publish inputs** (publishing stays a separate owner-approved step).

## Reconciliations with the code (surfaced by recon; owner-approved)
- **No "vault brief" component exists** — the semantic store holds metrics,
  synonyms, entities, joinHints only. → Ablate the 3 real components; build the
  engine-drafted brief as a NEW auto-derive deliverable, not part of the study.
- **certified answers / benchmarks / join relationships are not sidebar panels**
  (a chat trust badge, CI-only harnesses, and record-only-no-UI respectively). →
  Reorder the 6 real sections only; no fabricated panels.
- **Declared joins have no authoring UI** (records only). → The ablation will
  likely show ~0 lift; the decision rule applies honestly.
- **No ablation toggle exists** (the store's only on/off is emptiness). → Add
  the env-gated per-kind hook for the study; it ships inert (no user setting).

## Constitution boundary (review standard)
- Visuals ONLY from query batches / catalog / engine-profiled tables — never
  model prose. Enforced by the emitter's inputs + the visual-coverage eval.
- Flyout appearance/state is a fixed set of safe, clamped values; no arbitrary
  code/CSS execution.
- §3 feature REMOVAL is gated on the measured ablation table + owner sign-off
  (destructive; UI + storage + prompt text + docs).
- Nothing leaves the machine; no new egress destination; no `CACHE_VERSION` bump.

## Gates (proof)
- Sidebar E2E: open a section flyout → act in it → close → state persisted;
  relaunch keeps widths; file tree unaffected. No virtualization regression
  (row-mount count before/after).
- Visual-coverage eval floor over a fixture set spanning answer types
  (analytics, meta, synthesis-with-profiled-table, pure prose): coverage ≥
  recorded baseline AND the pure-prose fixture must NOT gain a visual (gated
  BOTH directions).
- §3 ablation table committed; removed components leave no dead UI/prompt text
  (grep-proof); auto-derivation proposals have unit tests (conservative
  thresholds, no false-positive synonym merges); scorecards after ≥ before.
- `npm test`, the cargo suite, lint, release-smoke, and all eval/chart floors
  green; five stamps agree; before/after screenshots for the visual changes.

## Non-goals
- No new sidebar panels for certified answers / benchmarks / a joins editor.
- No change to the executed SQL, the chart *rendering*, or extraction/caching.
- No auto-*application* of derived synonyms/metrics (proposals only).
- Publishing 0.12.5 (this change stops at the built draft + report).
