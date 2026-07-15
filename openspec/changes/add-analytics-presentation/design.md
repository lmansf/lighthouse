# Design — analytics presentation polish

## Non-Goals (pinned)

1. No pie/radar/heatmap; the kind set stays bar/line/area/scatter.
2. No client-side re-aggregation — the renderer draws verified batches only.
3. Stacking never fires without a proven constant whole; no stack total is drawn.
4. Axis formatting is renderer-derived, NOT a schema field → default outputs stay
   byte-identical.
5. No new sort semantics — only an honesty caption on truncated tables.
6. No cache-version bump; no desktop-crate change (chart is an opaque string).

## Two reconciliations (the load-bearing constraints)

### R1 — "Existing bar/line/area fixtures stay byte-identical" ⇒ axis formatting is renderer-only
The release-smoke wire test and the renderer both pin the exact chart-fence JSON.
So NO new key may appear on a default bar/line/area output. Consequence: every
axis-formatting ask (thousands separators, compact ticks, date-tick-by-
granularity, zero-baseline choice) is derived by the RENDERER from the `x`
strings and `values` already on the wire — it is not a schema change. Only the
genuinely new shapes (scatter, stacked) carry new keys, and only on their own
outputs. The Rust `default_chart_outputs_are_byte_locked` test asserts the exact
serialized bytes of a categorical bar and a temporal area, so a future edit that
perturbs them fails in-container before the smoke gate.

### R2 — "Never assert a sum the data doesn't make" ⇒ stack only on a proven constant whole
Stacking implies part-of-whole. The engine emits `stacked` ONLY when it can prove
that from the batches alone: ≥2 series, every value present and non-negative, and
every category's cross-series sum equals the same constant whole (≈100 or ≈1.0)
within epsilon. That is self-detectable, needs no query AST, and is safe by
construction — the parts literally sum to the whole. The renderer additionally
prints no stack total, so even a mis-hinted stack states no false number. Scatter
is likewise self-detectable (numeric, non-temporal first column) and states no
aggregate at all.

## Decisions

### D1 — Scatter detection: continuous (float) x, not merely numeric
Scatter requires exactly 2 columns, a FLOATING-POINT first column, and
first-column labels that do NOT all read as time. Gating on float (not any
numeric type) keeps small-integer keys — star ratings, status codes, enum ids —
as categorical bars, since a continuous scatter axis would imply a relationship
those keys don't have. A numeric-but-temporal column (bare years "2019".."2023")
still routes to area/line, preserving the existing `(year,value) → area`
behavior byte-for-byte. `xValues` is parsed with the same finite-f64 guard as
the y values, so a non-numeric render is a don't-chart, and ≥2 index positions
must carry BOTH a finite x and a finite y.

### D2 — `is_stackable`
A pure predicate over the built `series`. Rejects <2 series, any null/negative
part, an all-zero whole, and any whole that isn't ≈100 (abs eps 0.5) or ≈1.0 (rel
eps 0.01). Only those two canonical wholes read as "share of a total"; a run of
independent metrics that merely happen to sum to a shared constant of some other
scale is left grouped.

### D3 — Byte-identical construction
The non-scatter, non-stacked path builds the spec with the EXACT `json!` call
used before, so its bytes are unchanged. Scatter returns early with its own
object; stacked adds one key. Nothing else moves.

### D4 — Renderer axis formatting (soft parity)
`detectGranularity`/`formatXTick`/`formatGrouped` in `chartSpec.ts` mirror the
Rust label conventions (`looks_temporal`, `commafy`) but live renderer-side. A
PARITY comment marks this as SOFT parity — the label conventions must match, but
it is not on the wire and not byte-checked. `formatGrouped` matches `commafy`'s
thousands grouping for integers.

### D5 — Kind-aware Y domain
- stacked bar: `[0, max over categories of the stack sum]` (the true bar top).
- bar / area: keep the forced-zero baseline.
- line / scatter: fit the data (`[min, max]`) — a scatter of prices near 50k must
  not waste the axis on an unused zero.

### D6 — Truncation-honest sorting
The G1 footer (`_Showing the first N of M rows._`) appears ONLY on truncated
results, and a truncated result never carries a chart. So its presence is an
exact signal that the table below is a subset. `truncationNoteFrom` extracts it
from the answer markdown; the renderer strips the standalone footer line (so it
isn't shown twice) and binds it to the result table's `<caption>`, which stays
with the table through sorting. `truncationCaption` appends "Sorted view of the
shown rows." when a sort is active — a descending top row is the max of the shown
page, not of all M matched rows.

## Degradation

- A malformed/over-cap spec ⇒ `parseChartSpec` returns null ⇒ the fence renders
  as a plain code block (visible, not a wrong drawing).
- A non-chartable result ⇒ no chart, table only.
- A truncated result ⇒ no chart (unchanged), table + honest sorted caption.
- Scatter/stacked with too-sparse or unproven data ⇒ falls back to the table or
  to grouped/line, never to a misleading mark.

## Test plan

- Rust (`analytics.rs`): scatter for numeric non-temporal x; stacked when rows
  sum to 100; grouped (no `stacked` key) when they don't; a null part
  disqualifies; bare years stay area (not scatter); byte-lock of the categorical
  bar + temporal area outputs.
- Node (`chartSpec.test.mjs`): parse scatter (accept aligned `xValues`; reject
  missing/mismatched/multi-series/xValues-on-non-scatter); parse stacked
  (accept on bar; reject on non-bar); `formatGrouped`/`detectGranularity`/
  `formatXTick`. (`sortTable.test.mjs`): `truncationNoteFrom` + `truncationCaption`.
- `tsc --noEmit` + `next lint`.
- CI-only: `desktop-release.yml` (opaque-string pass-through still builds);
  `release-smoke.yml` grounded-ask fence bytes unchanged for default charts;
  SVG rendering of scatter/stacked + 2× PNG export are DOM — manual/visual QA.
