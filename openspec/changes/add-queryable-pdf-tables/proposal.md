# Queryable PDF tables: the analyst runs SQL over the grid, not just reads it

## Why

`add-pdf-tables` (0.11.x) taught extraction to reconstruct a PDF's confident
tables from its positioned text layer and surface them as markdown, so the rows
survive retrieval and citations. It deliberately stopped one step short: it
marked each reconstructed grid `header_like` but left it **out of the analytics
engine**, because the obvious wiring — routing PDFs through the catalog's
`is_tabular` profiling — would have been a catalog-wide cost and correctness
change (chunking, union grouping, "which spreadsheets do I have" meta answers)
disproportionate to that change. That deferral is quoted verbatim in the
add-pdf-tables Non-goals: *"No SQL-queryable PDF tables in this change — the
reconstruction keeps a `header_like` signal for a later change to build on."*

This is that later change. The data-analyst persona reads board decks and
exported dashboards as PDFs, and today those numbers can be *quoted* by the
model but never *computed over*: no `SUM`, no `GROUP BY`, no verified aggregate.
The trust invariant that makes Lighthouse analytics safe — the model reads the
schema, writes one SQL SELECT, DataFusion executes, the model narrates a
verified result, the SQL shown verbatim — should extend to a PDF's grid exactly
as it already does to a spreadsheet's sheet.

The insight that makes this safe and small is that the deferral's fear was
specifically about `is_tabular`'s blast radius. We thread that needle: a PDF
gets a **registration-only** gate (`is_pdf`) that never touches `is_tabular`.
The analytics engine registers a PDF's confident grids as queryable tables;
chunking, catalog profiling, and spreadsheet meta answers see nothing new. A
prose PDF costs a bounded re-parse and registers nothing.

## What Changes

- **A PDF's confident grid becomes a real queryable table.** The analytics
  engine's per-ask table registration learns a PDF branch: for each in-scope
  PDF, re-run the text-layer table pass, keep only grids confident enough to
  assert an aggregate over (`is_queryable_grid`: header-carrying, ≥2 columns,
  ≥3 data rows — stricter than the ≥2×2 markdown gate), and register each as a
  typed Arrow MemTable via the *same* header-sanitize + `table_from_matrix`
  numeric-typing path a spreadsheet sheet uses. The model then queries it under
  the unchanged trust invariant: schema-only read, one guarded SELECT, engine
  math, SQL shown verbatim.
- **Queryability rides a separate gate, not `is_tabular`.** A new `is_pdf`
  predicate drives ONLY table registration and the analytics candidate scan.
  `is_tabular` is untouched, so PDFs stay on prose chunking, out of union
  grouping, and out of spreadsheet meta answers — exactly the blast radius the
  add-pdf-tables Non-goal protected.
- **Coverage honesty stays spreadsheet-scoped.** The "Analyzed N of M in-scope
  tabular files" disclosure counts only `is_tabular` files in its denominator,
  so a bonus-track PDF that did or didn't register never distorts the count.
- **No new extraction cache version.** Registration re-parses the PDF at
  analytics time (the workbook pattern — spreadsheets are re-read per ask too),
  so `extract.rs` and its markdown path are untouched and `CACHE_VERSION` stays
  at 9. Nothing re-extracts; the markdown tables from add-pdf-tables are
  unchanged.
- **Bounded and fail-closed.** A PDF over a byte budget registers nothing; the
  glyph pass is panic-guarded and runs off the async runtime; a grid too thin
  to type registers nothing. A PDF with no confident grid consumes no table
  slot.

## Capabilities

### Modified Capabilities
- `pdf-tables`: EXTENDS the capability from readable-only to queryable. The
  reconstruction, confidence gate, and markdown surfacing are unchanged; this
  change adds that a confident, header-carrying grid is registered as a
  SQL-queryable analytics table under the existing analytics trust invariant,
  via a PDF-only registration gate that leaves `is_tabular` and the extraction
  cache untouched.

## Impact

- `native/crates/lighthouse-core/src/pdf_tables.rs`: `MIN_QUERYABLE_DATA_ROWS`,
  `is_queryable_grid` (pure over a reconstructed `Table`; unit-tested with
  synthetic grids), `queryable_tables(buf)` (confident registerable grids for a
  buffer). No change to `detect_tables`/`extract_tables`/markdown.
- `native/crates/lighthouse-core/src/analytics.rs`: `is_pdf`, `MAX_PDF_BYTES`,
  `register_pdf` (async; metadata size gate → `spawn_blocking` glyph pass →
  register each grid), `register_grid` (header sanitize + `table_from_matrix`
  typing, factored for unit testing over a synthetic `Table`), singles-loop
  dispatch, and the `direct_tables` candidate filter widened to `is_tabular ||
  is_pdf`.
- `native/crates/lighthouse-core/src/synth.rs`: analytics candidate collection
  widened to `is_tabular || is_pdf`; coverage denominator pinned to
  `is_tabular`-only so a PDF never distorts the "in-scope tabular files" count.
- Tests: `pdf_tables` queryable-gate units; an analytics `register_grid` →
  `run_query` end-to-end (engine-computed `SUM`, `Float64` typing) + degenerate
  and prose-bytes rejection. `extract_test.rs` `CACHE_VERSION` assertion stays
  `== 9` (unchanged).
- TS twin: **PARITY divergence, Rust-only** — analytics is Rust-only by the
  established PARITY decision, and PDF reconstruction is already Rust-only. No
  `src/server/` change; no cache-version drift (this change bumps nothing).

## Non-goals

- **No change to `is_tabular` and no catalog profiling for PDFs.** PDFs are not
  cataloged, not union-grouped, and not counted in spreadsheet meta answers.
  The whole point is to avoid the blast radius the add-pdf-tables Non-goal named.
- **No new extraction cache version.** Registration re-parses at analytics time;
  the markdown/extraction path and `CACHE_VERSION` are untouched.
- **No new reconstruction capability.** Geometry, header detection, gutters,
  page budget — all unchanged from add-pdf-tables. This change only *consumes*
  confident grids; it does not make more of them.
- **No multi-page table stitching, merged cells, or ruled-line detection** —
  inherited unchanged from add-pdf-tables.
- **No TS-twin queryability** — analytics is Rust-only.
- **No cross-file union of PDF grids with spreadsheet tables** — a PDF grid is
  registered under its own name and stands alone; it is not grouped with a
  same-shaped CSV/XLSX.
