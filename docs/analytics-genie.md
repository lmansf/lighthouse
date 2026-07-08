# Ask-your-data analytics ("Genie") — scope & design

**Goal:** "analyze my sales data" should behave like Databricks Genie, on your
own machine: the model reads the *schema* of your tabular files, writes SQL, a
real query engine executes it, and the model narrates the **verified result** —
with the query shown for trust. Privacy is architectural (everything
in-process, no network paths), and accuracy comes from execution: the model
never does arithmetic.

This extends the multi-document synthesis pipeline (docs/multi-doc-synthesis.md)
with an *analytics branch*, and folds in the two retrieval-quality pillars.

---

## Phase A — the analytics engine (BUILT)

### Engine choice: DataFusion, not DuckDB

Both are excellent embedded SQL engines. DataFusion wins for us on:

- **Pure Rust.** No C++ toolchain risk across the three CI platforms, no
  `libduckdb-sys` bundled build adding 10–20 min per release job.
- **Zero network by construction.** DuckDB's Excel/extension story runs through
  its extension loader, which *auto-installs from the network* unless carefully
  disabled — a foot-gun for a privacy product. DataFusion has no such path.
- **Native CSV/TSV + Parquet readers** (Arrow-based), PostgreSQL-style SQL via
  `sqlparser` (joins, aggregates, windows, CTEs).
- Excel routes through **calamine — already our extraction parser** — into an
  in-memory Arrow table, so both features share one parsing story.

Trade-offs accepted: DuckDB's SQL surface and CSV sniffer are somewhat
stronger; binary grows ~25–35 MB; compile time grows. All acceptable.

### The ask flow (core::analytics + core::synth)

```
question ─► analytics intent? (aggregate cue AND ≥1 tabular file in scope)
              │ no → existing paths (synthesis / single-shot + profiles)
              ▼
        register tables (≤4 files): csv/tsv/parquet by path,
        xlsx/xls via calamine → Arrow MemTable (≤4 sheets, 100k rows)
              ▼
        schema card: table names, columns + types, 3 sample rows, row counts
              ▼
        model writes ONE SQL SELECT (schema in prompt, data never)
              ▼
        guard: parses as a single SELECT/WITH-SELECT (no DML/DDL/pragma),
        LIMIT 200 enforced, 10 s timeout, result ≤ 200 rows × 24 cols
              ▼
        execute; on error → ONE retry with the engine's error appended
              ▼
        exact result table (markdown) + the SQL injected as context blocks
              ▼
        model narrates; the engine appends "Query used: ```sql …```"
        deterministically (never model-generated), references = the files
```

Failures at any step fall through to the existing synthesis/profile paths —
the analytics branch can only add capability, never break an answer.

### Safety rails (accuracy + robustness)

- **Read-only by construction**: the statement must parse as exactly one
  `SELECT`/`WITH … SELECT`; anything else is rejected before execution.
- **Bounded**: row/column caps on results, execution timeout, per-file size and
  sheet caps on registration, cell-text caps in the rendered table.
- **Verified numbers only**: the model sees schema + samples to *write* SQL and
  the result table to *narrate*; every number in the answer traces to the
  engine's output. The SQL is displayed verbatim so a skeptical user can check.
- **Trigger is conservative**: aggregate-flavored questions (sum/average/top/
  per/by/how many/trend/median/…) with tabular files in scope. Everything else
  keeps its current path.

### Scope decisions

- **Desktop-first.** The engine lives in `lighthouse-core` (Rust). The TS/web
  dev twin does not grow a parallel engine — its pipeline simply never takes
  the analytics branch. This is the first deliberate TS/Rust divergence;
  revisit with duckdb-wasm/duckdb-node if a hosted web product ever needs it.
- **Multi-file joins work on day one** — all in-scope tabular files register
  into one session context, so "join sales.parquet to regions.csv" is just SQL.
- **Parquet becomes visible to RAG too**: extraction now renders schema + head
  rows as indexable text (it was name-match-only before).

---

## Phase B — retrieval quality

### B1. Structure-aware chunking (BUILT)

Word-window chunking shreds tables: a chunk holding row 400 of a spreadsheet
arrives with no header, so the model sees naked numbers. Now: extracted text
that is *tabular* (csv/tsv/xlsx/parquet extracts) chunks **by rows, with the
header line prepended to every chunk**. Prose keeps the existing word windows.
Implemented identically in both engines (parity-tested) since it changes what
retrieval returns.

### B2. Local embeddings + hybrid search (DESIGNED — needs a bundling decision)

TF-IDF is blind to meaning ("Q3 revenue" ≠ "third-quarter sales"). Plan:

- A small embedding model (nomic-embed-text v1.5 GGUF, ~130 MB) served by the
  same llama-server we already supervise (`--embedding`, second port), vectors
  stored beside the existing index, **hybrid score = reciprocal-rank fusion**
  of lexical + vector lists, all on-device.
- **The decision needed:** +130 MB — bundled in the installer, or downloaded
  on demand like the chat model? (Recommendation: on-demand, same
  hash-verified path as the 7B; embeddings then activate transparently.)
- Not started so the installer-size call is yours.

## Phase C — depth (DESIGNED)

- **Charts in chat**: deterministic SVG (bar/line) rendered by the engine from
  small group-by results — needs a chat renderer component for inline SVG
  (ReactMarkdown is sanitized today); worth doing together with a "copy as
  CSV" affordance on result tables.
- **PDF layout/tables**: current extraction is text-only and serves prose RAG;
  PDF *table* extraction is research-grade — revisit after A/B prove out, or
  lean on hosted-model vision for the rare scanned-table ask (privacy opt-in).
- **NL→SQL few-shots**: once real usage exists, add 3–5 curated examples per
  common shape (top-N, month-over-month, share-of-total) to the SQL prompt —
  the cheapest accuracy lift for the local 7B.

---

## Verification

- Unit fixtures: csv + parquet (written by the test) + the committed xlsx
  extraction fixture; intent detection; SQL guard (rejects UPDATE/DROP/multi-
  statement/subquery-smuggled DML); result formatting caps; join across
  csv+parquet; chunker parity fixtures in both suites.
- The synthesis smokes must stay green (analytics never fires in them — no
  tabular files in scope).
