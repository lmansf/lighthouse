# Ask-your-data analytics ("Beam") — scope & design

**Goal:** "analyze my sales data" should just work, entirely on your own
machine: the model reads the *schema* of your tabular files, writes SQL, a
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
        model narrates; the engine appends "Query used: ```sql …```" and
        "Computed from: “file” (saved N ago)" — the files the SQL referenced
        with their on-disk mtime age — deterministically (never
        model-generated), references = the files
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

### B2. Local embeddings + hybrid search (BUILT — bundled in the installer)

TF-IDF is blind to meaning ("Q3 revenue" ≠ "third-quarter sales"). Decision:
**bundle the model in the installer** (+~137 MB) so semantic search works with
zero setup. How it ships:

- **Model**: nomic-embed-text v1.5 Q8_0 GGUF in `resources/embed/` (its own
  resource dir — never `resources/llm/`, where chat-model discovery would
  mistake it for an installed 7B). Fetched at build time by
  `scripts/fetch-local-model.mjs`, pinned revision + SHA-256, fail-closed;
  the `asset-digests` workflow records pins and live-smokes the stack.
- **Serving**: the SAME bundled llama-server, second instance —
  `--embedding --pooling mean`, port 8091, CPU-only (tiny model; never
  contends with the chat model for VRAM; immune to the Vulkan crash class).
  Supervised like the chat instance (start/stop with the toggle, quick-exit
  give-up guard, killed on quit, skipped in safe mode).
- **Vectors**: every indexed chunk embeds in a background warm pass
  (single-flight, nudged by index builds / boot / server-healthy), quantized
  to i8 (~769 B/chunk) in a binary sidecar (`cache/vectors-v1.bin`) keyed by
  the index's own `mtimeMs:size` freshness key.
- **Retrieval**: query embeds with a tight timeout; per-chunk cosine fuses
  with the lexical ranking via **reciprocal-rank fusion** (k=60, top-rank
  in both legs ≡ 1.0 on the existing score scale, name-match nudge applies
  after). Degrades to pure lexical whenever the server is down, vectors are
  <80 % warm (avoids over-ranking half-embedded corpora), or the
  **Preferences → Semantic search** toggle is off (default on).
- **TS twin**: stays lexical (desktop-only, like the analytics engine); the
  dev server just round-trips the preference.

## Phase C — depth

- **Charts in chat (BUILT)**: chartable results (label column + 1–3 numeric
  columns, 2–24 rows) become an engine-built JSON spec in a
  `lighthouse-chart` code fence — data straight from the query batches, never
  model text. The chat renderer draws it as a theme-aware SVG (bar; line when
  the labels read as dates/quarters); a malformed spec degrades to a visible
  code block; the widget pill strips the fence (the numbers are in the prose).
  Spec validation + axis math live in `src/lib/chartSpec.ts` (node-tested);
  the emitter is `core::analytics::chart_spec_from_batches` (unit-tested).
- **Copy as CSV (BUILT)**: every table in a chat answer gets a hover
  copy-as-CSV button (RFC-4180 quoting via `tableToCsv`).
- **NL→SQL few-shots (BUILT)**: five curated examples (top-N, trend,
  month-over-month via LAG, share-of-total via a window over an aggregate,
  join) ride in the SQL prompt with deliberately generic names; a unit test
  rejects any example the engine's own guard wouldn't accept.
- **PDF layout/tables (DESIGNED)**: current extraction is text-only and serves
  prose RAG; PDF *table* extraction is research-grade — revisit after A/B/C
  prove out, or lean on hosted-model vision for the rare scanned-table ask
  (privacy opt-in).

---

## Phase D — semantic layer (measured)

The semantic layer ships three **hand-authored** business-definition components —
**metric definitions**, **column synonyms**, and **declared join hints (+ their
backing entities)**. Phase D asks whether each earns its keep *before* we invest
in auto-derivation, by MEASURING each component's lift on the analytics + trust
scorecards instead of guessing. (Auto-derived join hints,
`analytics::join_hints`, are NOT on trial — only the three manual components are.)

### Method

- **Ablation hook.** An env-gated, per-kind hook lives at
  `semantic::eligible_for_posture` — the ONE seam every consumer routes through
  (prompt injection, the curated-join merge, certify/trust, the answer-cache
  key). `LIGHTHOUSE_ABLATE_METRICS | _SYNONYMS | _JOINS` (`=1`/`true`) each make
  that kind ineligible for a run — as if the store held none of it (JOINS drops
  joinHints *and* their backing entities). It ships **INERT**: with no variable
  set, behavior is byte-identical to today (unit-pinned), so nothing is removed
  or disabled — this is a measurement instrument, not a shipped setting or UI.
  Mirrored byte-for-byte in the TS twin (`semantic.ts`).
- **Fixtures.** `examples/analytics_eval.rs` seeds a realistic *messy* fixture's
  definitions into the semantic store: abbreviated columns (`amt`, `rgn`) a
  **synonym** resolves; a recurring `SUM(amt) FILTER (WHERE status='paid')` a
  **metric** names; an `orders_msy`↔`reps_msy` pair a declared **join** makes
  authoritative. Model-free checks that route through `eligible_for_posture`
  depend on each component (commented per check in the eval), so ablating a
  component measurably drops the pass rate.
- **Runner.** The eval always prints `SCORECARD total=… passed=… rate=…` (pass
  or fail). `.github/workflows/ablation.yml` (workflow_dispatch) builds the eval
  once, runs the baseline plus each ablation without letting a nonzero exit fail
  the step, and reports the per-component lift table below.

### Decision rule (stated up front)

- A component whose ablation costs **< ~2 points** on the scorecards **AND**
  shows no qualitative save in transcripts is **REMOVED** — its UI, storage,
  prompt injection, and docs — because manual authoring of it was not earning
  its keep. Removal is destructive and stays gated on this table **plus** the
  owner's sign-off.
- A component with **real lift** is **KEPT**, and its authoring cost moves off
  the user via auto-derivation (synonyms proposed from column names/values;
  metrics mined from recurring usage). Either way, manual authoring becomes
  optional polish — never a prerequisite for a good answer.

### Results (pending the CI ablation run — no numbers invented)

| component | baseline rate | ablated rate | lift (points) | verdict |
|---|---|---|---|---|
| metric definitions          | _tbd_ | _tbd_ | _tbd_ | _tbd_ |
| column synonyms             | _tbd_ | _tbd_ | _tbd_ | _tbd_ |
| declared joins (+ entities) | _tbd_ | _tbd_ | _tbd_ | _tbd_ |

**Verdict: pending.** Fill from the `ablation.yml` output, then apply the
decision rule per component and record the follow-through (auto-derive, or
removal). Note that the model-free floor measures whether each component is
*exercised and wired*; the end-to-end answer-quality lift of synonyms/metrics is
the opt-in provider NL leg's job (`LIGHTHOUSE_EVAL_*`) plus a transcript review.

> The engine-drafted **vault brief** (§3.5) is a new additive deliverable, not
> part of this study: a deterministic summary of vault composition + the
> queryable tables in scope, injected as one editable block beside the
> business-definitions block. It draws only on engine-known facts, never model
> prose.

---

## Verification

- Unit fixtures: csv + parquet (written by the test) + the committed xlsx
  extraction fixture; intent detection; SQL guard (rejects UPDATE/DROP/multi-
  statement/subquery-smuggled DML); result formatting caps; join across
  csv+parquet; chunker parity fixtures in both suites; chart-spec fixtures in
  both languages (emitter in Rust, parser/axis math in TS).
- The synthesis smokes must stay green (analytics never fires in them — no
  tabular files in scope).
- **Retrieval quality floors**: `examples/retrieval_eval.rs` scores lexical vs
  hybrid on a golden set (paraphrase questions lexical can't answer + keyword
  questions it must keep winning); the asset-digests verify workflow runs it
  against the real bundled model and fails on any floor violation.
