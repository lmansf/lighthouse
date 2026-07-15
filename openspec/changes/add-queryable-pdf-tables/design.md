# Design — queryable PDF tables

## Non-Goals (pinned)

These are fixed for this change. Re-opening any of them is a new proposal.

1. **`is_tabular` is not touched.** Queryability rides an independent `is_pdf`
   gate. No PDF enters the catalog, union grouping, chunking-as-tabular, or the
   "which spreadsheets do I have" meta path. This is the entire reason the
   add-pdf-tables change deferred this work; the design's first duty is to honor
   that boundary.
2. **No new extraction cache version.** `CACHE_VERSION` stays 9. Registration
   re-parses the PDF buffer at analytics time; `extract.rs` and the appended
   markdown are byte-for-byte unchanged.
3. **No new reconstruction.** `detect_tables`/`extract_tables` and their
   geometry, header-likeness, gutter, and page-budget rules are consumed
   as-is. This change adds a downstream *filter* and a *typing/registration*
   path, nothing upstream.
4. **Rust-only.** Analytics and PDF reconstruction are both already Rust-only by
   the established PARITY decision. No `src/server/` twin.

## Decisions

### D1 — A separate `is_pdf` gate, not an `is_tabular` extension
`is_tabular` fans out to catalog profiling, union grouping, tabular chunking,
and meta answers. Adding `.pdf` there would have exactly the catalog-wide
cost/correctness blast radius add-pdf-tables refused. Instead `is_pdf(name)` is
a leaf predicate used in only two places: the analytics singles-loop dispatch
(register) and the `direct_tables` / synth candidate scan (consider). Everything
`is_tabular` drives is left untouched. This is the load-bearing decision — it is
what makes "queryable PDFs" a bounded addition rather than a catalog rewrite.

### D2 — Re-parse at analytics time (the workbook pattern)
Spreadsheets are re-read from disk on each ask by `register_workbook`; PDFs
follow the same pattern via `register_pdf`. This keeps the extraction cache and
its version out of scope (D2/Non-goal 2), and keeps registration self-contained:
the analytics engine owns the whole PDF→table path and nothing in extraction has
to know a downstream consumer exists. The cost is a bounded re-parse per in-scope
PDF per ask; the glyph pass is already bounded (page budget, glyph cap) and
panic-guarded, and runs on `spawn_blocking` so it never stalls the async
runtime. A `MAX_PDF_BYTES` metadata gate rejects a pathological file before any
read.

### D3 — A stricter queryable gate than the markdown gate
The markdown path emits any ≥2×2 confident grid — worth *reading*. Asserting a
SQL aggregate over a grid deserves a higher bar, so `is_queryable_grid` requires
`header_like` (named, non-numeric first row — a real schema), ≥2 columns, and
≥`MIN_QUERYABLE_DATA_ROWS` (3) data rows. A 2-data-row grid stays readable in
the markdown but is not registered: an aggregate over two aligned rows is not
worth the model asserting. The gate is a pure function over an already-built
`Table`, so it is unit-tested with synthetic grids and never needs a PDF parser.
It lives in `pdf_tables.rs` (downstream of `detect_tables`) so the markdown path
and its cache version stay untouched.

### D4 — Reuse the spreadsheet typing path exactly
`register_grid` runs the *same* header sanitize (`sanitize_table_name`, blank/
"table" → `col_N`) and the *same* `table_from_matrix` numeric-typing (≥80%
numeric column → `Float64` with nulls, else `Utf8`, NaN-filtered, date-serial
aware) that `register_workbook` uses. A PDF column named `q3` with numeric cells
types `Float64`, so `SUM(q3)` is real arithmetic — identical to the spreadsheet
story. Factoring `register_grid` out of `register_pdf`'s loop makes the
typing/registration path unit-testable over a synthetic `Table` without a PDF,
mirroring how the geometry is tested with synthetic glyphs.

### D5 — Multi-grid naming
A PDF with one confident grid registers under the file's base name (the
spreadsheet-single-sheet convention). A PDF with several registers them
`{base}__1`, `{base}__2`, … so each is independently addressable, bounded by the
same `MAX_TABLES_TOTAL` budget the rest of registration respects.

### D6 — Coverage disclosure stays spreadsheet-scoped
The "Analyzed N of M in-scope tabular files (engine table limit)" footer must
keep meaning "spreadsheets". Its denominator counts only `is_tabular` files, so
a bonus-track PDF — registered or not — never changes the count. A PDF that
fails to register is not a dropped spreadsheet and must not read as one.

## Risks

- **A confident-looking but wrong grid becomes a queryable table.** Mitigated by
  the stricter D3 gate (header + ≥3 rows) on top of the reconstruction's own
  gutter-consistency invariant, and by the trust invariant itself: the SQL is
  shown verbatim and every number traces to DataFusion over the registered
  cells — a mis-parsed cell is visible in the shown grid, not hidden behind a
  fabricated number.
- **Re-parse cost on PDF-heavy vaults.** Bounded by `MAX_PDF_BYTES`, the page
  budget, the glyph cap, and `MAX_TABLES_TOTAL`; the pass runs on
  `spawn_blocking`. A prose PDF reconstructs nothing and registers nothing.
- **Scope creep back toward `is_tabular`.** Guarded by Non-goal 1 and D1, and by
  the coverage-denominator test (D6) that fails if a PDF ever leaks into the
  tabular count.
- **Silent divergence from the spreadsheet typing path.** Mitigated by D4's
  literal reuse of `sanitize_table_name` + `table_from_matrix` and the
  `register_grid` → `run_query` end-to-end test asserting `Float64` typing and
  an engine-computed `SUM`.

## Test plan

- `pdf_tables`: `is_queryable_grid` accepts a header + 3-data-row ≥2-col grid;
  rejects 2 data rows, a headerless (numeric-first) grid, and a single column.
- `analytics`: build a synthetic `Table { header_like:true, rows:
  [["region","q2","q3"],["ne","120","150"],["se","300","480"],["nw","90","110"]] }`,
  drive `register_grid` against a fresh `SessionContext`, assert `q3` types
  `Float64`, then `run_query("SELECT SUM(q3) …")` and assert the engine-computed
  total (740) appears — the number is DataFusion's, not the model's. Degenerate
  grids (1 data row, 1 column) register nothing; non-PDF/prose bytes yield no
  queryable table through the real (panic-guarded) extract path.
- `extract_test.rs`: `CACHE_VERSION` assertion stays `== 9` (nothing re-extracts).
