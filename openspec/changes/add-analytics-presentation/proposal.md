# Analytics presentation polish: scatter, stacked, axis formatting, truncation-honest sorting

## Why

The analytics engine already turns a verified query result into a chart (bar /
line / area) and a copy-as-CSV-able, sortable table. Two gaps remain for the
data-analyst persona:

1. **Only three chart kinds.** A numeric-vs-numeric relationship (weight vs
   price) has no honest home — it charts as a bar with numeric category labels,
   which reads as ordinal when it is continuous. And a genuine part-of-whole
   breakdown (each region's share of 100%) draws as a grouped bar, hiding the
   "sums to the whole" story. Scatter and stacked bar cover these — but only when
   the data itself PROVES the shape, never on a guess.
2. **Axis + sort honesty.** Large magnitudes want thousands separators / compact
   ticks; monthly labels want month abbreviations, not raw `2024-07`; and a
   sortable table over a TRUNCATED result silently implies its top row is the
   global maximum when it is only the maximum of the shown page.

Every addition holds the analytics trust invariant: the chart is built from the
engine's own record batches (never the model), and the renderer never states a
number the data doesn't make.

## What Changes

- **Scatter (Rust emitter + renderer).** A two-column result whose FIRST column
  is genuinely numeric and does NOT read as a temporal label emits
  `{"kind":"scatter", …, "xValues":[…]}` — a real (x, y) relationship with a
  numeric x-axis. Temporal-numeric labels (bare years) still route to area/line,
  byte-for-byte as before.
- **Stacked bar (Rust emitter + renderer).** A categorical multi-series result is
  emitted `stacked` ONLY when, for every category, the cross-series values sum to
  the same constant whole within epsilon (≈100 or ≈1.0) — a part-of-whole
  relationship the batches themselves prove. Otherwise grouped. The renderer
  draws segments but prints NO stack total, so even a mis-hinted stack states no
  false number.
- **Byte-identical defaults.** Every existing bar/line/area output is unchanged:
  the new keys (`stacked`, `xValues`, `kind:"scatter"`) appear only on the new
  paths. Axis formatting is therefore RENDERER-only — derived from the `x`
  strings and `values` already on the wire, never a schema field.
- **Axis formatting (renderer).** Thousands-grouped exact values, compact
  magnitude ticks, granularity-aware x-tick labels (month/day/quarter/year/
  numeric), and a kind-aware Y domain (stacked → max stack sum; line/scatter fit
  the data instead of forcing a zero baseline).
- **Truncation-honest sortable tables (renderer).** When a result carried the G1
  "first N of M rows" footer (which only appears on truncated results — which
  never chart), that disclosure binds to the result table's caption and, when a
  sort is active, says the sort covers the shown subset only.

## Capabilities

### New Capabilities
- `analytics-presentation`: the chart kinds (bar / line / area / scatter), the
  safe stacking rule, renderer-side axis formatting, and truncation-aware
  sortable result tables — all preserving the "never draw a claim the data
  doesn't make" guarantee and the byte-identical default outputs.

### Modified Capabilities
<!-- answer-artifacts (PNG export) renders the new scatter/stacked marks with no
     new requirement text — it clones whatever SVG is drawn, theme-correct. -->

## Impact

- `native/crates/lighthouse-core/src/analytics.rs`: `chart_spec_from_batches`
  scatter branch + `is_stackable` predicate (Rust-only, analytics has no twin);
  doc-comment reconciliation; Rust tests incl. byte-lock of the default outputs.
- `src/lib/chartSpec.ts`: `ChartKind`/`stacked`/`xValues` on the type, parser
  acceptance of scatter+stacked, and the pure axis helpers `formatGrouped`,
  `detectGranularity`, `formatXTick` (soft-parity mirror of `looks_temporal`).
- `src/features/chat/AnalyticsChart.tsx`: stacked + scatter marks, kind-aware Y
  domain, numeric/temporal x-axis formatting (DOM — CI/manual-verified).
- `src/features/chat/ChatPanel.tsx` + `src/lib/sortTable.ts`: `truncationNoteFrom`
  + `truncationCaption`, the sortable table's caption binding.
- Tests: Rust chart tests (scatter/stacked/year-exclusion/byte-lock), node
  `chartSpec` (parse + axis helpers) and `sortTable` (truncation helpers).
- No desktop-crate change (chart is an opaque `Option<String>` end to end). No
  `CACHE_VERSION` bump.

## Non-goals

- **No pie / radar / heatmap** — the deterministic kinds stay a small, honest set.
- **No client-side re-aggregation.** The renderer draws the verified batches; it
  never recomputes a sum, average, or share.
- **Stacking never auto-fires without a proven constant whole.** Independent
  metrics that merely happen to be multi-series stay grouped.
- **No stack total is ever printed** — the renderer states no number the query
  didn't already produce.
- **Axis formatting is not a schema change.** It is renderer-derived so every
  existing bar/line/area fixture stays byte-identical.
- **No new sort semantics.** Sorting still reorders the shown rows; the change is
  only that a truncated table SAYS so.
