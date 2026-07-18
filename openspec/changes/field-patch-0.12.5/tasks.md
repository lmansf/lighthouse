# Tasks — field patch 0.12.5

One commit per numbered section. Rust ships; TS twin mirrors (PARITY). Gates run
per section; the full suite + smoke + floors before the bump.

## §1 — Sectioned sidebar with flyout panels (commit 1)
- [ ] 1.1 Reorder `app/page.tsx` so `<FileExplorer>` is first; the other six
      sections (`InsightsNav`, `SemanticNav`, `CapabilityNav`, `RecipesNav`,
      `ViewsNav`, `InvestigationsNav`) render below as collapsed header rows.
- [ ] 1.2 Flyout shell: a second left panel that renders the active section's
      existing component; one open at a time; open via click/`Enter`, close via
      re-click/`Esc`/click-outside. New `SectionFlyout` + a small store.
- [ ] 1.3 Persist open-section + flyout width to the shell settings file by
      extending the `explorerWidth` idiom (`src/server/settings.ts`
      `setFlyoutWidth`/`setOpenFlyout`; `app/api/settings/route.ts`;
      `AppShell.tsx` handle reused for the flyout edge). Clamp width; per-mode.
- [ ] 1.4 Keyboard nav: headers focusable, `Enter` opens, Up/Down move between
      sections; visible focus ring in both themes (Beam tokens).
- [ ] 1.5 Virtualize long flyout lists (reuse `VirtualRows`); confirm the file
      tree's row-mount count is unchanged (perf regression guard).
- [ ] 1.6 Keep `FirstRunTour.tsx` copy accurate for the new layout
      (`data-tour="explorer"` stays on the tree; adjust any sidebar wording).
- [ ] 1.7 Tests: reducer/store unit tests (open/close/persist); Playwright E2E —
      open Metrics flyout → edit a metric → close → state persisted; relaunch
      keeps widths; file tree unaffected. Before/after screenshots.

## §2 — Visual-first answers (commit 2)
- [ ] 2.1 Engine: route `table_profile` group-by/rollup numbers into a
      `RecordBatch` the existing `chart_spec_from_batches` can consume (new
      `table_profile::chartable_batches` or equivalent) — values from the profile
      only, never prose. TS twin mirrors.
- [ ] 2.2 Engine: emit a stat tile / compact bar for meta/catalog counts
      (`meta.rs::count_line` → structured `StatValue`/tiny batch) so "how many
      PDFs" renders a tile/bar. TS twin mirrors.
- [ ] 2.3 Chat: render an inline stat tile from a single verified number (reuse
      boards' `detectStat`/`StatValue` + `AnalyticsChart` for bar/line).
- [ ] 2.4 Policy: update the chart card + guidance (`analytics.rs::chart_card`)
      to encourage a visual whenever data supports one; `decide_chart` stays the
      deterministic floor. Keep the "suppress with a stated reason" path.
- [ ] 2.5 Constitution guard: assert visuals derive only from batches/catalog/
      profiled tables (no prose path); unit + PARITY tests.
- [ ] 2.6 Eval: extend `chart_eval.rs` (or a new `visual_eval`) with a
      visual-coverage floor over analytics / meta / synthesis-with-profiled-table
      / pure-prose fixtures — coverage ≥ baseline AND pure-prose grows NO visual.
- [ ] 2.7 E2E: "how many PDFs" → tile; synthesis over a profiled-table fixture →
      chart; a definitions-free prose ask → none. Before/after screenshots.

## §3 — Business definitions: measure, then decide (commit 3)
- [x] 3.1 Add env-gated per-kind ablation at `semantic.rs::eligible_for_posture`
      (`LIGHTHOUSE_ABLATE_METRICS|SYNONYMS|JOINS`), ships inert (no user setting).
      TS twin mirrored (PARITY); inert-ship unit-pinned in both engines.
- [x] 3.2 Ablation harness: `analytics_eval.rs` seeds a realistic messy fixture
      into the semantic store with per-component dependent checks + an always-on
      `SCORECARD … rate=` line; `.github/workflows/ablation.yml` (dispatch) runs
      baseline + each component ablated and prints the per-component lift table.
- [x] 3.3 Record the ablation table + a one-paragraph plain-language verdict in
      `docs/analytics-beam.md` (new "Phase D — semantic layer" section). — Phase D
      results table (metrics 48→46, synonyms 48→46; joins row removed) + the
      plain-language verdict landed with the §3.4 decision.
- [x] 3.4 Apply the decision rule per component:
      - REMOVE — declared join hints + backing entities: deleted from both engines
        (structs, CRUD, `curated_join_pairs`, the JOINS ablation gate, the
        curated-join prompt section, the answer-cache registry chains, the eval's
        joins checks + `ablation.yml` joins run + Phase D joins row). Store loads
        an old `semantic.json` with `entities`/`joinHints` keys tolerantly (serde
        ignores unknown keys; a mirrored TS check + a test pin it). Grep-proof: no
        dead references remain.
      - KEEP + auto-derive — metrics + synonyms: synonyms proposed deterministically
        from the included columns' known abbreviations
        (`semantic::propose_synonyms` / `proposeSynonyms`, conservative curated
        dictionary, no false-positive merges); metrics mined from recurring usage
        (`semantic::propose_metrics` over views/pins/answer_cache via
        `analytics::propose_metric`, threshold ≥ 2 or one certified). Surfaced in
        SemanticNav's "Suggested" list; accepted one-by-one through the guarded
        create path. Nothing auto-applied.
- [x] 3.5 Build the engine-drafted **vault brief** (new): deterministic draft
      from vault composition + queryable tables (date-range render supported;
      live enrichment a follow-on), injected as one `Ctx` beside the business-
      definitions block. TS twin mirrors byte-for-byte (`vaultBrief.ts`).
- [x] 3.6 Tests: auto-derivation proposal unit tests (conservative thresholds,
      NO false-positive synonym merges); scorecards-after ≥ scorecards-before;
      brief-draft determinism. — brief-draft determinism + composition pinned in
      both engines; per-component ablation checks landed. Auto-derivation now
      covered: `propose_synonyms` pins the obvious hits AND the no-false-positive
      cases (region↔regularization, amount↔amortization, both-forms-present,
      existing-synonym) in Rust + the TS twin; `propose_metrics_from_usage` pins
      the ≥2-or-certified threshold, occurrence tally/sort, and already-defined
      dedupe. Backward-compat load of legacy `entities`/`joinHints` keys pinned in
      both engines.

## §4 — Housekeeping (commit 4)
- [x] 4.1 Triage remaining moderate Dependabot alerts: `npm audit`/`cargo audit`
      review; fix by update or justify via the allowlist (`native/audit.toml`
      dated rationale). No blanket disables. — 2026-07-18 re-triage: npm
      `--omit=dev` clean (0 vulns); cargo audit exits 0 with the four documented
      ignores (no new High/Critical). The 20 non-failing warnings (gtk-rs GTK3
      stack, glib unsound, instant/paste/proc-macro-error/spin/unic-*) are all
      transitive with no semver-compatible fix in the pinned tree; dated,
      per-crate rationale added to `native/audit.toml`; no new ignore (no blanket
      disable). Fixed a stale path ref in `supply-chain.yml`
      (`native/.cargo/audit.toml` → `native/audit.toml`).

## §5 — Release (commit 5)
- [ ] 5.1 Five-stamp bump `0.12.4 → 0.12.5` (package.json, package-lock ×2,
      native/Cargo.toml, tauri.conf.json, native/Cargo.lock ×5 lighthouse crates;
      leave hashbrown/ocrs/pbkdf2 alone). No `CACHE_VERSION` change.
- [ ] 5.2 Proof gates: `npm test`, cargo suite, lint, release-smoke, eval/chart +
      visual-coverage floors, contrast gate — all green; stamps agree.
- [ ] 5.3 One PR (all five commits). Squash-merge → dispatch desktop-release.yml
      → watch to the v0.12.5 draft → STOP and report the draft link + publish
      inputs. Do NOT publish.

## Report (close-out)
- [ ] R.1 Per-component ablation table + one-paragraph verdict on business
      definitions.
- [ ] R.2 Before/after screenshots (sidebar + visual-first answers).
