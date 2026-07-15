# "What the AI sees" — a read-only per-file inspector

## Why

Lighthouse asks the user to decide, per file, what an AI may read — but it never
shows them what that *means* for a given file. What text did extraction actually
pull out (and was it OCR'd from a scan, so it might be imperfect)? How was it
chunked, and how many chunks exist? For a spreadsheet, which columns and types
did the catalog detect — the exact schema a cloud model would be told about? Is
the index fresh, or stale relative to the file on disk? Is this file included,
and is it marked private-to-this-device?

Today all of that is invisible; the user curates blind. The inspector makes the
engine's view of one file legible: a read-only panel that answers "what does the
AI see when it looks at this file?" — including a scoped test-search so the user
can watch which chunks a query would actually retrieve, with scores. It turns
the privacy-first promise into something inspectable per file, next to the
inclusion and local-only controls that act on the same file.

## What Changes

- **A read-only inspector op** in the engine that, given a file id, returns:
  the extracted text preview (flagged when it came from OCR), chunk count and
  chunking mode, detected columns + kinds (for tabular files), index freshness,
  and the file's inclusion + local-only state — plus a bounded test-search over
  **only this file** returning the top chunks with their scores. It performs **no
  mutation**; it reads what the index/catalog already hold.
- **An explorer entry point**: a "What the AI sees" item in the row context
  menu opens the panel for that file.
- **A read-only panel UI** rendering the fields in plain language, with the
  test-search box. Desktop-first.
- **Honest twin parity**: the TS twin renders the same panel minus the fields it
  cannot compute (OCR-source flag, persistent chunk count, the column catalog,
  and a persisted last-indexed time are Rust-engine-only) — it omits them with a
  short "desktop only" note rather than faking a value.

## Capabilities

### New Capabilities
- `file-inspector`: a read-only, per-file view of exactly what the engine has
  extracted, chunked, catalogued, and indexed for a file — including a
  file-scoped test-search — so a user can verify what an AI would see.

## Impact

- **Engine (Rust ships, TS twin mirrors what it can):** a new inspector function
  in `native/crates/lighthouse-core/` assembling from `doc_text`
  (`vault.rs:2153`), the index (`index.rs` chunk count/preview/freshness),
  `catalog.rs` (columns + kinds), OCR-source derivation (`extract.rs`
  `is_ocr_image_ext` / scanned-PDF path), and a per-file `retrieve`; twin in
  `src/server/` over `docText` (`vault.ts:1391`) + table profile, omitting the
  Rust-only fields.
- **Op wiring:** an `inspect` op in `routes.rs`, `commands.rs`,
  `app/api/rag/route.ts`, the `sources` dispatchers, and a `RagService` method
  (`src/contracts/*` types + real + mock).
- **UI:** the row-menu entry + panel in `src/features/explorer/` (or a sibling
  feature dir), read-only, reusing the inclusion + local-only labels.
- **Tests:** a snapshot of the inspector payload for a fixture file (both
  engines, with the twin's omissions asserted).

## Non-goals

- **Read-only — no mutation** beyond the inclusion + local-only toggles it
  merely *surfaces*. The inspector never edits, re-extracts, re-indexes, or
  deletes.
- **Not a document viewer.** It shows the **extracted** text the model would
  read — which for a scan or an image is OCR output, deliberately flagged as
  such — not a faithful render of the original file.
- **Not a re-index trigger.** It reports current index/catalog state and its
  freshness; refreshing is the existing watcher's job, not a button here.
- **No fabricated parity.** The twin never invents a chunk count, OCR flag,
  catalog, or last-indexed time it cannot compute; it omits the field honestly
  (consistent with the Rust-engine-only capability list).
- **Not a new retrieval mode.** The test-search reuses the existing per-file
  retrieval scoring; it does not add a second ranker.
