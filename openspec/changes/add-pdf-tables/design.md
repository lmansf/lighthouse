# Design — PDF table reconstruction

## Substrate: `pdf-extract`'s `OutputDev`

`pdf-extract` 0.7 exposes a public `OutputDev` trait and the `output_doc(&doc,
&mut dyn OutputDev)` driver. The crate decodes fonts (including CID/Type0) and
calls `output_character(trm, width, spacing, font_size, char)` once per glyph
with the **decoded unicode** and the **text-rendering matrix**. That is the
whole reason this is tractable without a new dependency: font→unicode decoding,
the genuinely hard part of PDF text, is already solved upstream. We only do
geometry.

Per glyph we record, in the crate's own top-left-origin convention (mirroring
`PlainTextOutput`: `position = trm.post_transform(flip_ctm)` where
`flip_ctm = [1,0,0,-1,0, page_height]`):

- `x` = `position.m31` (left edge of the glyph)
- `y` = `position.m32` (baseline; y grows downward)
- `w` = `width * transformed_font_size` (advance, so `x + w` is the right edge)
- `fs` = `transformed_font_size` (effective on-page size; sets the row/gutter tolerances)
- `ch` = the decoded string

Collection is per page (`begin_page`/`end_page`), capped at `MAX_TABLE_PAGES`.

## Reconstruction (pure geometry, unit-testable without a PDF)

The core is `detect_tables(glyphs, page_h) -> Vec<Table>`, driven in tests by
synthetic `Glyph` vectors so the geometry is pinned independently of any PDF
parser.

1. **Rows**: sort glyphs by `y`, then greedily group into rows where successive
   baselines differ by less than `ROW_TOL * median_fs`. Within a row, sort by
   `x` and coalesce glyphs into text runs (a gap `> SPACE_TOL * fs` starts a new
   run; a gap `> GUTTER_TOL * fs` marks a candidate column boundary).
2. **Column model**: collect every inter-run gap across all rows; a *gutter* is
   an x-interval that (a) is wide (`≥ GUTTER_TOL * median_fs`) and (b) is empty
   in a strong majority of rows (`≥ COL_SUPPORT` of them). Gutters partition the
   x-axis into columns.
3. **Cell assignment**: each run drops into the column whose x-span contains its
   start. A row contributing two runs to one column, or leaving interior columns
   empty in a way that breaks alignment, counts against the region.
4. **Accept / reject**: a region is a table iff `rows ≥ 2`, `cols ≥ 2`, and the
   fraction of rows that fit the column model cleanly is `≥ FIT_RATIO`. Anything
   else returns no table (fail closed) — the linear text already covers it.

Constants are conservative on purpose: we would rather miss a faint table
(leaving good linear text) than assert a wrong one.

## Surfacing

### Readable (always, when a table is accepted)
`extract.rs` appends, after the linear text:

```
## Tables detected in <filename>

| Region | Q2 | Q3 |
| --- | --- | --- |
| NE | 120 | 150 |
...
```

Markdown cells are escaped (pipes/newlines). This rides the existing chunker,
so retrieval and citations work with zero further plumbing, and the whole-doc
context path sees the grid.

### Queryable (deferred)
Making a reconstructed grid SQL-queryable — registering it as a `MemTable`
alongside spreadsheet tables — is deliberately out of scope for this change. The
blocker is not the MemTable construction (the column-typing helper
`register_workbook` uses is reusable); it is the reach: the analytics catalog
decides what is a table via `is_tabular(name)` and `catalog::columns_for`, both
keyed on file extension. Admitting `.pdf` there makes EVERY pdf pay a
table-extraction + profiling cost during analytics planning and blurs the
"is this file tabular?" signal the planner depends on — a catalog-wide change
disproportionate to this feature. The reconstruction therefore carries a
`header_like` flag (all-non-empty, non-numeric first row) so a later change can
gate registration on a confirmed single clean grid without re-deriving it. Until
then the markdown path already lets the analyst see, cite, and copy the numbers.

## Parity

Rust-only, like OCR and `.parquet`. The TS twin's `unpdf` path yields only
linear text; it keeps that behavior with a PARITY comment and bumps
`CACHE_VERSION` in lockstep so the shared cache-schema assertion
(`extract_test.rs`) stays green. Prompts/labels are unaffected — the model just
sees better-structured document text.

## Why not a table-extraction crate

`camelot`/`tabula` are Python; the Rust table-extraction crates are either
immature, GPL, or wrap native libs we've avoided (the OCR change deliberately
stayed pure-Rust/no-native-deps). Since `pdf-extract` already hands us decoded
positioned glyphs, the geometry is a few hundred lines we can test exhaustively
and reason about — a better trust story than a black box.
