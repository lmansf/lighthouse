# Design — add-tabular-scale

## Context

`synth.rs` collects candidate tabular files (attachments or active included set) and stops at `MAX_TABLE_FILES = 4`; `register_tables` registers each file separately into one SessionContext. The freshness footer and references are per-file. There is no persistent knowledge of any file's columns outside a live ask.

## Goals / Non-Goals

**Goals:**
- A 30-file monthly family answers as one table with correct group provenance.
- Join-key discovery costs no model tokens beyond one small deterministic block.
- The catalog is reusable by later changes (suggested asks, meta answers) without re-reading files.

**Non-Goals:**
- Cross-file unions of files with *different* schemas (schema evolution/merging).
- Persisting row counts or full profiling in the catalog (headers + kinds only).
- Any UI surface (this is engine capability; UI benefits arrive via other changes).

## Decisions

1. **Catalog = header + kind sampling, cached as one JSON.** `catalog.rs`: `columns_for(files) -> Vec<FileColumns { id, name, columns: Vec<Column { name, kind }>, modified_ms }>`. CSV/TSV: read first line + ≤50 sample rows via plain buffered reads; XLSX/XLS: calamine first sheet through the same `detect_header_row`/`cell_text` path as analytics (consistency with excel-ingestion). Kind: numeric / date (ISO-looking) / text by ≥80% sample vote. Cache file `cache/columns.json` keyed `mtime:size` per absolute path — same self-healing freshness idiom as extraction. Corrupt/missing cache ⇒ recompute; unreadable file ⇒ omitted, never fatal.
2. **Grouping is name + signature, both required.** `union_groups(candidates, catalog)`: stem = lowercase name with `.ext` dropped and every digit run (and `-`/`_` around it) collapsed; files group when stems match AND sanitized column lists are identical (order-sensitive — sanitized headers must line up for UNION). ≥2 files ⇒ group (cap 48 files, newest first beyond that); singles register exactly as today. A group consumes ONE slot against `MAX_TABLE_FILES`. Alternative considered: grouping by signature alone — rejected; unrelated same-shape files (e.g. two different lookup tables) must not silently merge.
3. **Union mechanics per format.** CSV/TSV/Parquet: `ctx.read_csv(Vec<String>, opts)` / `read_parquet` (DataFusion's `DataFilePaths` accepts path vectors) then `register_table(name, df.into_view())`. Workbooks: build the string matrix per file (first sheet, header-detected), verify identical headers, concatenate rows, then infer column types ONCE over the combined rows — avoids per-file type drift (a column numeric in Jan but text in Feb unions as text).
4. **Group provenance.** `TableReg` gains `group: Option<GroupMeta { file_ids: Vec<String>, names: Vec<String>, newest_ms: i64 }>`. Freshness line renders `"sales-2025-*.csv" (12 files, newest saved 2 hours ago)`; references emit the first 3 member files (real ids — the explorer can open them) with the group label in the snippet.
5. **Join hints are computed, not modeled.** Shared column names between distinct registered tables (excluding a small stop-list: `id`, `name`, `date`, `value` — too generic to imply a key) render one context block `Join hints:\n- a.region = b.region`, score 0, appended after schema cards. Bounded to 12 hints.

**Parity:** Rust-only (analytics has no TS twin — module docs already state this). The catalog module is likewise Rust-only; `add-vault-meta-answers` documents the resulting PARITY divergence for column questions.

**Degradation:** any grouping/union failure falls back to per-file registration for that family (and the per-file cap applies); catalog failures degrade to no hints/no groups. The local model's 6144-token window is respected: group cards are ONE card per group (fewer cards than today's per-file worst case), and the hints block is ≤ ~500 chars.

## Risks / Trade-offs

- [Header drift inside a family (a column renamed mid-year)] → signature check splits the family into two groups; both register (may then exceed slots — newest group wins). Honest, visible in the cards.
- [Huge unions slow the ask] → 48-file cap + DataFusion streaming keeps registration bounded; workbook concatenation stays under the existing 100k-row cap per group.
- [Misleading join hints on coincidental column names] → stop-list + "hints" framing (the model may ignore them); never forces a join.
