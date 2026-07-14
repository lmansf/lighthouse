# PDF tables: the vault reads the grid, not just the words (Phase 2)

## Why

The data-analyst persona lives in PDF reports — board decks, exported
dashboards, financial statements, lab results. Today the vault extracts a PDF's
text layer as a single linearized stream: the words survive, but the **table
structure is destroyed**. "Q3 revenue by region" becomes `NE 150 NW 200 SE 300`
run together with the surrounding prose, so the model can't reliably tell which
number belongs to which row, and the analytics engine — which already turns
CSV/XLSX sheets into queryable tables — can't see the numbers at all because
they never arrive as a grid.

The fix is on-device and deterministic. `pdf-extract` (already a dependency)
exposes a public `OutputDev` trait that hands us every glyph **with its decoded
unicode and its position on the page** — the font decoding, the hard part, is
already done. From positioned glyphs, table reconstruction is geometry:
cluster glyphs into rows by baseline, find the column gutters that hold across
those rows, and read cells out of the grid. No ML, no cloud, no new dependency.

The trust invariant carries over from charts: a reconstructed table is only
ever emitted when the geometry is unambiguous. Anything short of a confident
grid falls back to the existing linear text — the vault never *invents* a
table that wasn't visually there.

## What Changes

- **A PDF's tables survive extraction as tables**: a new `pdf_tables.rs`
  module implements a positioned-glyph `OutputDev`, clusters glyphs into
  rows/columns, and reconstructs confident grids. `extract.rs` appends the
  reconstructed tables to the extracted text as GitHub-flavored markdown
  under a `## Tables detected in <file>` heading, so the grid flows through the
  normal chunker/index/retrieval and lands in RAG answers with its rows intact.
- **The grid keeps its header for downstream use**: a reconstructed grid whose
  first row reads as column names is marked `header_like` — the signal a future
  queryable path would gate on. Making PDF grids SQL-queryable is deliberately
  deferred (see Non-goals): it would force every PDF through the analytics
  catalog's `is_tabular`/`columns_for` profiling, which is a catalog-wide cost
  and correctness change disproportionate to this change. The readable markdown
  already lets the analyst see and cite the numbers.
- **Bounded and fail-closed by design**: a page budget caps work on huge PDFs;
  a grid needs ≥2 rows, ≥2 columns, and column gutters that hold across the
  rows or it is discarded; ragged/degenerate layouts emit nothing and the
  linear text stands. `CACHE_VERSION` bumps (v8→v9) so existing PDFs re-extract
  once and pick up their tables.

## Capabilities

### New Capabilities
- `pdf-tables`: reconstructing tabular structure from a PDF's positioned text
  layer, on device and deterministically, and surfacing it as readable markdown
  in the extracted text so the grid flows through retrieval and citations.

### Modified Capabilities
<!-- none — retrieval/chunking/citations/analytics consume the tables unchanged -->

## Impact

- New `native/crates/lighthouse-core/src/pdf_tables.rs` (positioned-glyph
  collector, row/column clustering, markdown + cell-grid emit, unit tests
  driven by synthetic glyph layouts — no PDF needed to test the geometry).
- `extract.rs`: run the table pass alongside text extraction, append markdown,
  `CACHE_VERSION` 8→9. `extract_test.rs`: matching `CACHE_VERSION` assertion.
- TS twin (`src/server/extract.ts`): **PARITY divergence, Rust-only** — like
  OCR and `.parquet`. `unpdf` gives the twin only linearized text; the twin
  keeps that with a PARITY comment and bumps `CACHE_VERSION` in lockstep so the
  shared cache-schema assertion stays green.

## Non-goals

- **No SQL-queryable PDF tables in this change** — the reconstruction keeps a
  `header_like` signal for a later change to build on, but registering PDF grids
  as DataFusion tables would force every PDF through the analytics catalog's
  tabular-file profiling (a catalog-wide cost + correctness change) and is out
  of scope here. The markdown path already makes the numbers readable and
  citable.
- **No cloud table extraction** — on-device geometry only.
- **No ruled-line / vector-border detection in v1**: reconstruction is from
  text position alone. Fully borderless *and* whitespace-ambiguous layouts
  (no consistent gutters) are left as linear text, not guessed.
- **No spanning/merged-cell or nested-table modeling** — a cell that spans
  columns collapses to its best single-column home or the grid is rejected;
  no rowspan/colspan is emitted.
- **No multi-page table stitching** — each page's grids stand alone (a table
  broken across a page boundary yields two tables, as the pages present it).
- **No rotated or vertical text tables.**
- **No TS-twin reconstruction.**
