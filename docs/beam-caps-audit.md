# Registration-caps audit (Beam §1) — verify, then lift only what's real

**Verdict up front: no cap lifted.** Path-registered formats (CSV/TSV/Parquet)
already stream through DataFusion — the memory story the caps were suspected
of papering over does not exist for them. The audit found exactly one real
gap, and it was an honesty gap, not a capacity gap: a single workbook larger
than the row cap registered **silently truncated**. That is now disclosed
(engine text, deterministic); the cap itself is unchanged.

## Cap inventory (`native/crates/lighthouse-core/src/analytics.rs`)

| Cap | Value | Why it exists | Binds on the anchor ask? | Verdict |
| --- | --- | --- | --- | --- |
| `MAX_TABLE_FILES` | 4 slots | Prompt budget — schema cards must fit a 6144-token local window | No — a union group consumes ONE slot | Kept |
| `MAX_TABLES_TOTAL` | 6 | Same prompt budget (4 books × 4 sheets once blew the window) | No | Kept |
| `MAX_GROUP_FILES` | 48 | Bounds one ask's union registration work | No (12 ≤ 48) | Kept |
| `CANDIDATE_SCAN` | 64 | Gather wide enough to see a 12-file family whole | No | Kept (see observation) |
| `MAX_XLSX_ROWS` | 100 000 | Memory — xlsx/xls materialize as in-RAM Arrow MemTables | **No** — never applies to path-registered CSV/TSV/Parquet | Kept; now **disclosed** when it bites |
| `MAX_XLSX_COLS` / `MAX_SHEETS_PER_BOOK` | 64 / 4 | Same materialization + prompt bounds | No | Kept |
| `MAX_PDF_BYTES` | 64 MiB | A huge PDF must not stall an ask | No | Kept |
| `QUERY_TIMEOUT_SECS` | 10 | One query can't stall the answer | No | Kept |
| `MAX_RESULT_ROWS` | 200 | Result *semantics* — narration cap, not a read cap | Only for row-listing variants; discloses true total | Kept |
| `MAX_RESULT_COLS` / `MAX_CARD_CHARS` / sample caps | 24 / 1200 / 3 | Prompt hygiene | No (wide results disclose dropped columns) | Kept |

## Anchor-ask trace — "sum a year of 12 big monthly CSVs" succeeds

1. All 12 files are gathered (`CANDIDATE_SCAN` = 64 ≥ 12) and grouped by
   shared digit-stripped stem + identical column signature
   (`union_groups`, analytics.rs).
2. The family registers as **one** table via DataFusion's multi-path
   `read_csv` — registration is **by path**; execution **streams**. No row
   ever passes through `MAX_XLSX_ROWS`, which only guards the in-RAM
   MemTable build for xlsx/xls (and nothing else).
3. The group consumes one `MAX_TABLE_FILES` slot, so the table caps don't
   bite either. `SUM(amount)` covers every row of every member; the result
   is one row, far under `MAX_RESULT_ROWS`.

Proven in-tree: `end_to_end_union_of_monthlies` (12-file union, exact
year total) and the new Fixture A
(`row_cap_disclosure::big_csv_streams_every_row_with_no_cap_note`): a
120 000-row CSV sums to the exact all-rows total (Σ1..120000 =
7 200 060 000) with **no** cap wording anywhere — card, result, or footers.

## The variants that do bind — and how each discloses

- **Result larger than 200 rows** — `run_query` truncates but counts the
  uncapped total; `truncation_footer` states "_Showing the first 200 of
  12,431 rows._" (engine text on both the ask path and model-free re-exec).
- **More tabular files than slots** — the coverage footer states
  "_Analyzed N of M in-scope tabular files (engine table limit)._"
  (synth.rs), and a union whose older members were dropped by the row cap
  says so in its schema card ("row cap: N older file(s) NOT included").
- **A single workbook past 100 000 rows** — **was the gap**: data rows were
  `.take(MAX_XLSX_ROWS)`-truncated with no disclosure anywhere; the card
  even presented the capped count as the table's row count. **Now
  disclosed** (this change, cap unchanged):
  - registration records it (`TableReg::capped_rows`);
  - the schema card *leads* with "`big` — row cap: only the first 100,000
    rows of big.xlsx are included" (survives card clipping, so the model
    can't claim full-file totals);
  - the answer carries the deterministic footer
    "_“big.xlsx” analyzed to its first 100,000 rows (workbook row cap)._"
    on the ask path, the multi-step path, and the model-free re-exec
    footer. Union-family drops keep their existing disclosure and never
    double-fire this footer.

  Fixture B (`row_cap_disclosure::oversize_workbook_caps_with_card_note_and_footer`)
  was red on the pre-change tree (probe: card = "table big — 100000 rows",
  zero cap wording) and is green with the change.

## Observations — noted, not changed

- **`CANDIDATE_SCAN` = 64 is walk-order.** The gather loop takes the first
  64 tabular files in vault walk order; newest-first ordering applies only
  *downstream* among gathered singles. In a vault with more than 64 tabular
  files, which files compete at all is arbitrary — a latent quality (not
  correctness) issue to revisit if such vaults show up.
- **PDF grids don't use the workbook row cap.** `register_grid` materializes
  whatever `pdf_tables` reconstructs; that pass bounds a page grid at 120
  rows during geometry reconstruction (a page-local confidence mechanism,
  not a file read cap). No change made.

## Conclusion

Every cap earns its keep: prompt budget, materialization memory, or result
semantics. Streaming already solved the memory story for path-registered
formats, so the anchor ask needed no lift. The one change shipped is
**honesty, not capacity** — a row-capped workbook now says so, in engine
text, everywhere the answer is presented.
