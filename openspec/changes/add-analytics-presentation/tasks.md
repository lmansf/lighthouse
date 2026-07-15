# Tasks — analytics presentation polish

## 1. Rust emitter (analytics.rs, Rust-only)
- [x] 1.1 Reconcile the `chart_spec_from_batches` doc comment (scatter/stacked
  now emitted under strict, self-provable conditions).
- [x] 1.2 Scatter branch: numeric non-temporal 2-col → `{kind:"scatter", x,
  xValues, series}`; ≥2 finite (x, y) pairs required.
- [x] 1.3 `is_stackable` + stacked emission on the categorical path (constant
  whole ≈100/≈1.0, no nulls/negatives); non-stacked path stays byte-identical.
- [x] 1.4 Rust tests: scatter, stacked, non-summing (no key), null-part, bare
  years stay area, and a byte-lock of the default bar + area outputs.

## 2. Parser + axis helpers (chartSpec.ts)
- [x] 2.1 `ChartKind`/`stacked`/`xValues` on `ChartSpec`.
- [x] 2.2 `parseChartSpec`: accept scatter (aligned `xValues`, single series),
  accept `stacked` on bar only, reject the malformed shapes.
- [x] 2.3 Pure helpers `formatGrouped`, `detectGranularity`, `formatXTick`
  (soft-parity mirror of `looks_temporal`/`commafy`).
- [x] 2.4 Node tests: parse scatter/stacked (accept + reject), axis helpers.

## 3. Renderer marks + axes (AnalyticsChart.tsx, DOM/CI-verified)
- [x] 3.1 Kind-aware Y domain (stacked max sum; line/scatter fit data).
- [x] 3.2 Stacked bar segments (no total label); scatter circles + numeric x-scale.
- [x] 3.3 Granularity-aware x-tick labels; scatter numeric ticks; aria updated.

## 4. Truncation-aware sortable tables (ChatPanel.tsx + sortTable.ts)
- [x] 4.1 `truncationNoteFrom` + `truncationCaption` (pure, unit-tested).
- [x] 4.2 SortableTable renders the note as a caption; strip the duplicate footer.

## 5. Gates
- [x] 5.1 `cargo test -p lighthouse-core` green (incl. byte-lock).
- [x] 5.2 `tsc --noEmit` + `next lint` + `node --test test/*.test.mjs` green.
- [x] 5.3 No `CACHE_VERSION` change; no desktop-crate change.
- [x] 5.4 `node scripts/openspec-validate.mjs add-analytics-presentation` green.
- [ ] 5.5 CI-only: desktop-release opaque-string build; release-smoke default
  fence bytes unchanged; SVG/PNG of scatter+stacked visually verified.
