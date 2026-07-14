# Tasks — add-analytics-eval-floor

## 1. Correctness audit (find → independently verify)

- [x] 1.1 Two-pass adversarial audit of `analytics.rs`, `catalog.rs`,
  `table_profile.rs`, the tabular chunker (`vault.rs` ⇄ `vault.ts`), and
  `chartSpec.ts` across the enumerated wrong-but-plausible classes
- [x] 1.2 Independently verify each finding against the code + pinned deps
  (datafusion 54 / sqlparser 0.62) before fixing; record clean bills

## 2. Truncation honesty (engine → footer)

- [x] 2.1 `run_query`: count the uncapped plan when truncated → `QueryResult.total`;
  neutral, human-safe narration note; never present the cap as the total
- [x] 2.2 `truncation_footer` + `commafy`; wire into `direct_footer` (run_direct /
  Save-CSV) and the `synth.rs` ask path; fix the model-facing count description
- [x] 2.3 Column-cap disclosure note in `run_query`

## 3. Guard hardening

- [x] 3.1 Recursive read-only `guard_sql`: reject `SELECT … INTO` and any
  modifying set-expression in a body or CTE; keep read-only shapes passing

## 4. Audit fixes (each with a regression test)

- [x] 4.1 NaN/inf sentinel → NULL in `table_from_matrix` (no poisoned aggregate)
- [x] 4.2 Narrow Excel-serial-date detection (date-ish header + in-range whole
  numbers → ISO), guarded against misclassifying a real measure
- [x] 4.3 `unique_table_name` loop (no silent table overwrite)
- [x] 4.4 `join_hints`: extend generic list + suppress the `col_N` family
- [x] 4.5 Union signature folds `ColumnKind`; require a ≥2-char stem
- [x] 4.6 `detect_header_row`: `(all_textual, textual)` score so a data row
  can't displace an all-textual header
- [x] 4.7 Coverage disclosure (`unregistered_count`) + mtime-sort singles
- [x] 4.8 `fmtNum` parity: TS rounds half away from zero (matches Rust)
- [x] 4.9 Tabular chunker trims U+FEFF in both engines (byte parity)
- [x] 4.10 `niceTicks` normalizes an inverted domain

## 5. Eval floor

- [x] 5.1 Golden model-free regression tests in `analytics.rs` / `table_profile.rs`
  / `vault.rs` (truncation total, NaN-skip, serial dates, guard, header, union,
  chunker) + prompt-snapshot coverage via the existing few-shot/guard tests
- [x] 5.2 `examples/analytics_eval.rs`: model-free floor (CI-safe) + provider-
  gated NL scorecard that exits 0 with no provider

## 6. Known limitations

- [x] 6.1 Document the deferred findings (CSV Date32 substr, lenient dates,
  year-as-measure, num_of grammar, pin-digest bound, chart-kind heuristics,
  CSV-union coverage) in `design.md` rather than risk new wrong answers

## 7. Verification

- [x] 7.1 `cargo test -p lighthouse-core` (146 lib + integration green),
  `cargo check -p lighthouse-server`; `npm test` (tsc + node) green;
  `next lint` clean; `analytics_eval` model-free floor passes; `openspec
  validate --all` green
