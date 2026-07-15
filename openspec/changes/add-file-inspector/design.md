# Design — file inspector

## Shape of the inspector payload

One read-only op, `inspect(fileId)`, returns a flat struct (all fields optional
so the twin can omit what it lacks):

- `name`, `included` (effective), `localOnly` (effective) — plain-language state.
- `extractPreview` — a bounded slice of the extracted text (what the model would
  read), with `fromOcr: bool` when the text was produced by OCR (image formats
  via `is_ocr_image_ext`, or the scanned-PDF fallback path).
- `chunkCount` + `chunkMode` (`tabular` row-windows vs `prose` word-windows).
- `columns` — `[{name, kind}]` for tabular files (catalog).
- `indexedAt` / freshness — the index key (`mtimeMs:size`) and whether it matches
  the file on disk right now.
- `testSearch(query)` — a **bounded** per-file retrieval returning the top chunks
  with scores, scoped to this file id only (reuses the existing retrieval
  scorer; no second ranker).

The op is **pure read**: it calls `doc_text`/`docText`, the index, `catalog`, and
`retrieve` — never a setter. The only state changes reachable from the panel are
the existing inclusion + local-only toggles, which it surfaces but does not own.

## Rust/TS parity — mirror what's shared, omit the rest honestly

The Rust-engine-only capability list (`docs/ts-twin.md`) decides the split:

| Field | Rust (ships) | TS twin |
|---|---|---|
| name, included, localOnly | yes | yes (mirrored) |
| extractPreview | yes (all formats) | yes for pdf/docx/xlsx/csv/md/txt; name-only for rich formats/images |
| **fromOcr flag** | yes | **omit** (OCR is Rust-only) |
| chunkMode | yes | yes (chunker is parity-pinned) |
| **chunkCount** | yes (persistent index) | **omit** (TS re-chunks per query, no persisted count) |
| columns + kinds | yes (catalog) | via table profile where available; **omit** the catalog-only inventory |
| **indexedAt / freshness** | yes (index + watcher) | **omit** persisted last-indexed; mtime is available but not an "indexed at" |
| testSearch | yes | yes (lexical) |

The twin renders the **same panel** and, for each field it cannot compute, shows
a short "desktop only" affordance rather than a blank or a fabricated value —
matching the honest-degradation rule (never a fake answer). A `PARITY:` comment
on both sides names the omitted fields. The op is registered on the TS route
layer with the same name so the contract is uniform; the twin's handler returns
the reduced payload.

## Failure & degradation

- **Missing/failed extraction** → `extractPreview` empty with an explicit "no
  extractable text (name-match only)" state, never an error dialog; the file
  stays inspectable for its other fields. This mirrors "extraction failures
  leave files name-findable".
- **Stale index** → the freshness field is the *point*: it reports
  matches-disk vs stale rather than hiding it; a stale entry still renders (the
  user learns it's stale).
- **6144-token window:** irrelevant — the inspector never calls the model.
  `extractPreview` and `testSearch` results are bounded (a preview slice and a
  small top-K) so the panel is a glance, and a huge file cannot blow any buffer.
- **Read-only guarantee:** because the op performs no writes, an inspector
  failure can never corrupt vault state; worst case a field is empty.
