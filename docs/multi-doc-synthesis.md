# Multi-document synthesis (Phase 1)

**Goal:** answer questions that span documents — "compare the Q3 report with the
Q2 report", "what do all my invoices say about late fees" — with real synthesis
instead of hoping the right chunks from different files land in one top-k pass.
And make numeric questions over tables *exactly* right by computing statistics
deterministically in the engine, never in the model.

Phase 1 needs **no model tool-use**: the engine owns a fixed map→reduce plan, so
it works identically on the bundled 7B local model and hosted providers. (Phases
2/3 — real function calling for hosted providers, then schema-constrained tool
calls for the local model — build on the same seams; see "Later phases".)

## How it works

The whole ask path is one pipeline per engine (`src/server/synth.ts` on the TS
side; `lighthouse-server/src/synth_pipeline.rs` orchestrating pure helpers in
`lighthouse-core/src/{synth,table_profile}.rs` on the native side). All three
call sites — the web route, the axum route, and the desktop IPC command —
delegate to it, so behavior and prompts are byte-identical everywhere.

```
question ─► trigger? ──no──► single-shot RAG (today's path)
              │                └─ + table profiles appended for CSV hits
             yes
              ▼
        pick docs (2..6)
              ▼
   MAP: per doc — retrieve top chunks scoped to that doc (the attachment-
        scoping path reused with one file id), + table profile if CSV,
        one extraction call: "bullet-point everything relevant, exact
        numbers/dates/quotes, or reply NO_RELEVANT_CONTENT"
              ▼
   REDUCE: one context block per document (the extracts), streamed through
        the normal grounded-answer prompt; [n] citations now point at
        *documents*; references carry each doc's best original snippet
```

### Trigger

Synthesis runs only when it will help and the user signalled it:

- the user attached **2+ files** to the question (the attach gesture is intent), or
- the question contains a **cross-document cue** (compare/versus/across/overall/
  trend/synthesize, or phrases like "all my files", "each document", "both
  reports") **and** 2+ documents are in scope.

Everything else keeps today's fast single-shot path. Synthesis is also skipped
when no real model is configured (the extractive fallback answers single-shot),
and it degrades to single-shot if fewer than two documents produce extracts.

### Picking documents

- Attachments present → the attached files (first 6).
- Otherwise: all included files when ≤6; when more, a wide retrieval pass
  (k=24) ranks files by summed chunk score and the top 6 win.

### Map calls

Per document, sequential (predictable latency + progress on the local model;
hosted is fast enough that sequential stays simple): chunks come from a
retrieval pass scoped to just that file (k=3), falling back to the file's
opening text when the query's tokens miss. The extraction reuses the normal
grounded prompt machinery with an extraction question wrapper; outputs are
capped and stripped of stray `[n]` markers so they can't collide with the
reduce step's citation numbering. Empty/`NO_RELEVANT_CONTENT` docs drop out.

### Table profiles (exact numbers)

For `.csv`/`.tsv` files, the engine computes a compact deterministic profile —
row count, per-column type, numeric sums/means/min/max, per-year rollups for
date columns, and group-by sums for low-cardinality text columns — and injects
it as an extra context block labeled *computed exactly by Lighthouse*. The
model narrates verified numbers instead of doing arithmetic. Profiles are
injected in map calls for profiled docs AND in the ordinary single-shot path
(top 2 CSV hits), so "total 2017 sales" is exact even without synthesis.
(XLSX profiles ride on the same seam later; extraction differs per engine
today, so Phase 1 keeps profiles to delimiter files where parity is exact.)

### Protocol + UI

`ChatChunk` gains an optional `progress` field:

```jsonc
{ "delta": "", "progress": { "label": "Reading q3-summary.xlsx (2/5)…", "step": 2, "total": 6 }, "done": false }
```

Old clients ignore unknown fields. ChatPanel and the widget show the label in
the pre-answer loader line, so long synthesis runs narrate themselves
("Reading… Synthesizing across 4 documents…") instead of sitting on a spinner.

### Budgets & guardrails

- 2..6 documents per run; k=3 chunks per map; map outputs truncated ~1800 chars;
  profiles ~1200 chars. History is omitted from map calls (extraction is
  context-free) and kept for the reduce.
- Everything is read-only and provenance-carrying: references always point at
  real vault files; map/reduce inputs go through the existing untrusted-data
  fencing in the system prompt.

## Later phases

> **Update:** aggregation over tabular files shipped as a dedicated analytics
> branch — the model writes SQL and DataFusion executes it in-process, which
> strictly subsumes the `aggregate(…)` tool sketched below. See
> docs/analytics-beam.md. The tool-loop phases remain future work for
> *prose* navigation (search/read/section tools).

- **Phase 2 — hosted function calling:** expose `search_vault`, `read_section`,
  `extract_table`, `aggregate(op, column, group_by, filter)` as native tools for
  Anthropic/OpenAI-compatible providers; the engine executes, the model plans.
- **Phase 3 — local tool loop:** same tools on the bundled model via
  JSON-schema-constrained decoding (works with `--no-jinja`; llama.cpp grammar
  sampling is independent of the chat template), one tool per step, hard step
  budgets.
