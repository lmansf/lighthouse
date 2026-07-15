# Tasks — file inspector

## 1. Engine op (Rust ships, TS twin mirrors what it can)
- [x] 1.1 Add an `inspect(fileId)` function in `lighthouse-core` assembling: extract preview (`doc_text`), `fromOcr` derivation (`is_ocr_image_ext` / scanned-PDF path), chunk count + mode (`index` / chunker), columns + kinds (`catalog`), index freshness (`index` key vs disk), and effective inclusion + local-only.
- [x] 1.2 Add the bounded per-file `testSearch(fileId, query)` reusing the existing retrieval scorer, scoped to the one file.
- [x] 1.3 Mirror in `src/server/` over `docText` + table profile + lexical retrieve, OMITTING the Rust-only fields (OCR flag, persisted chunk count, catalog, last-indexed) with a `PARITY:` note; return the reduced payload.
- [x] 1.4 Unit/snapshot the payload for a fixture file in both suites (twin omissions asserted).

## 2. Op + service wiring
- [x] 2.1 Add an `inspect` op in `routes.rs`, `commands.rs`, `app/api/rag/route.ts`, and the `sources` dispatchers.
- [x] 2.2 Add the `RagService` inspect method (`src/contracts/*` types + real + mock).

## 3. UI panel + explorer entry
- [x] 3.1 Add a read-only inspector panel component rendering the fields in plain language + the test-search box; reuse the inclusion + local-only labels; render "desktop only" for omitted twin fields.
- [x] 3.2 Add a "What the AI sees" item to the file row context menu that opens the panel.

## 4. Verify
- [x] 4.1 Run full verification: `cd native && cargo test --workspace`, `npm run test`, `tsc --noEmit`, `next lint`.
