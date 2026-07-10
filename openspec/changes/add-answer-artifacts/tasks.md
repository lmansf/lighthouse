# Tasks — add-answer-artifacts

## 1. Engine

- [x] 1.1 `vault::write_artifact(subdir, name, ext, bytes)` — sanitize (reuse rename rules), mkdir, collision suffix, return file id; unit tests (sanitize, collision, nested traversal rejected)
- [x] 1.2 CSV writer for record batches (RFC-4180 quote-doubling, SAVE_MAX_ROWS=100_000) + unit test with quotes/newlines/unicode
- [x] 1.3 `analyticsSql` op accepts `saveAs`; on save path runs with save cap and returns { savedId, savedName, rows } alongside the preview; routes.rs + commands.rs
- [x] 1.4 `exportChat { title, markdown }` op in BOTH engines (Rust + TS /api/rag) → write_artifact into Lighthouse Notes/, return { savedId, savedName }

## 2. UI

- [x] 2.1 "Save as CSV" chip on analytics answers (uses meta.sql/fileIds; toast with name + Reveal action)
- [x] 2.2 AnalyticsChart PNG export button (SVG → 2× canvas with theme background → toBlob download)
- [x] 2.3 Chat menu "Export chat to vault note": client renders transcript markdown, calls exportChat, toast + Reveal
- [x] 2.4 Contracts: rag service ops + mock impls

## 3. Verification

- [x] 3.1 cargo + node tests, tsc, lint; live check: save a result CSV, see it in explorer, ask a question over it; export chat and open the note
