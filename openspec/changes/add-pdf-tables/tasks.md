# Tasks — add-pdf-tables

## 1. Engine: positioned-glyph collector
- [x] 1.1 `pdf_tables.rs`: `Glyph { x, y, w, fs, text }` and a `GridCollector`
      implementing `pdf_extract::OutputDev` (per-page, raw coords, page budget).
- [x] 1.2 `collect_pages(buf) -> Vec<Vec<Glyph>>` over `output_doc`, panic-guarded
      like `extract_pdf` (pdf-extract can panic on malformed input).

## 2. Engine: reconstruction geometry (pure, unit-tested)
- [x] 2.1 Row clustering by baseline tolerance; cell splitting by intra-row gaps
      with word-space reinsertion.
- [x] 2.2 Gutter detection via a coverage sweep (robust to right-aligned numeric
      columns) → column boundaries.
- [x] 2.3 Cell assignment + accept/reject gate (≥2×2, fit-ratio); fail closed.
- [x] 2.4 `tables_to_markdown` with cell escaping; `Table { header_like, rows }`.
- [x] 2.5 Unit tests on synthetic glyph layouts: clean grid accepted, right-aligned
      numbers aligned, multiword cells, ragged/single-column rejected, header
      detection, numeric-cell parsing, markdown escaping (8 tests).

## 3. Extraction integration
- [x] 3.1 `extract.rs`: after linear text, run the table pass, append
      `## Tables detected in <file>` markdown when any table is accepted.
- [x] 3.2 `CACHE_VERSION` 8→9 in `extract.rs`, `src/server/extract.ts`, and the
      `extract_test.rs` assertion (lockstep per CLAUDE.md).
- [x] 3.3 Extraction test: a real Helvetica text-grid PDF (built with lopdf)
      yields the markdown table end-to-end; a gridless PDF leaves text unchanged.

## 4. Analytics: queryable single clean grid — DEFERRED
- [~] 4.1 Registering a PDF grid as a `MemTable` is deferred: it would force
      every PDF through `is_tabular`/`catalog::columns_for` profiling (a
      catalog-wide cost + correctness change). The reconstruction keeps a
      `header_like` flag so a later change can gate registration without
      re-deriving it. See design.md "Queryable (deferred)" and proposal
      Non-goals. Not in this change.

## 5. Parity + docs
- [x] 5.1 `src/server/extract.ts`: PARITY comment (Rust-only reconstruction),
      `CACHE_VERSION` bump only.
- [x] 5.2 `docs/data-flows.md`: PDF tables noted in the extraction flow.
- [x] 5.3 OpenSpec change mirrors the add-ocr-perception format (no CLI validator
      installed in-repo; skill-managed).

## 6. Gates
- [x] 6.1 `cargo test -p lighthouse-core` (geometry + extraction, 129 lib + 5
      extract_test, 0 failed).
- [x] 6.2 `npm test` (98) + `npm run lint` (clean) — twin cache-version assertion,
      no FE regressions.
