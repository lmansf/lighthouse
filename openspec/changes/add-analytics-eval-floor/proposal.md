# Analytics correctness audit + a durable eval floor

## Why

The analytics branch is the one place where a wrong number reads as an
authoritative one: the answer says "computed exactly by Lighthouse" and shows
the SQL for trust. Every previous Genie phase added *capability* (unions, joins,
charts, multi-step); none added a **standing correctness floor**. A regression
that makes `substr(date,1,7)` mis-bucket a month, or an Excel serial slip into a
summed column, or a 12,431-row result get narrated as "200 rows total", would
ship green — no test asserts the *numbers*.

Two concrete gaps motivate this change:

1. **Truncation is narrated as complete.** `run_query` caps results at 200 rows
   by fetching 201 and stopping, so `shown` saturates at 200 and the engine
   never learns the true total. The narration block tells the model "200
   row(s), truncated" with a note that says "of 200 total — tell the user the
   full count", and there is **no deterministic footer** stating the cap. A
   query over a large table is answered as though 200 were the whole answer.
2. **No golden executor floor.** The unit tests cover parsing, caps, and one
   union/join happy path, but nothing pins the *computed statistics* for the
   wrong-but-plausible classes (date grouping, NULL-in-aggregate, Excel serials,
   union mis-grouping, guard bypasses) so a refactor can silently change an
   answer.

## What Changes

- **Truncation honesty (behavior change).** When a query's result is capped,
  the engine computes the true total once (`SELECT COUNT(*)` over the guarded
  query) and surfaces it honestly: the narration context and a **new
  deterministic footer** read "first 200 rows of 12,431" — in the answer AND the
  footer, on both the ask path and the model-free `run_direct` path (Edit SQL /
  pins / Save-CSV preview). Counting failures degrade to "first 200 rows (more
  exist)" — never a fabricated total, never a broken answer.
- **Audit fixes.** Every defect confirmed by the two-pass correctness audit of
  `analytics.rs`, `catalog.rs`, `table_profile.rs`, the tabular chunking path,
  and `chartSpec.ts` gets a fix plus a regression test that fails without it.
- **A golden eval floor.** Deterministic, model-free executor tests
  (fixture → expected result table) covering the wrong-but-plausible classes,
  plus prompt-snapshot tests, run in the normal `cargo test` gate. A
  `examples/analytics_eval.rs` scorecard (question → expected numbers) runs the
  full NL→SQL→execute→narrate loop against a **configured** provider for local
  runs; with no provider it prints and exits 0, so it is never a flaky CI gate.

## Capabilities

### New Capabilities
- `analytics-eval-floor`: truncation honesty, the golden executor floor, and the
  provider-gated scorecard — the standing guarantees that keep every analytics
  number honest across future changes.

### Modified Capabilities
<!-- none — the truncation-honesty requirement lands as a new requirement of the
     new capability; it tightens run_query/run_direct without changing their
     signatures' meaning. -->

## Impact

- `native/crates/lighthouse-core/src/analytics.rs` — `run_query`/`QueryResult`
  gain a true-total count on truncation; `DirectResult`/`direct_footer` carry the
  truncation footer; audit fixes across the guard, registration, grouping,
  rendering, and chart emitters; new golden + snapshot tests.
- `native/crates/lighthouse-core/src/synth.rs` — the analytics branch emits the
  deterministic truncation footer and passes the true total into narration.
- `native/crates/lighthouse-core/src/catalog.rs`, `table_profile.rs`,
  `extract.rs` (`cell_text`), `vault.rs` (tabular chunker) — audit fixes only
  where the audit confirms a defect; parity fixes mirrored to `src/server/` and
  `src/lib/chartSpec.ts` where the path is shared.
- `native/crates/lighthouse-core/examples/analytics_eval.rs` — new scorecard
  binary (local-run, provider-gated).
- No contracts change, no new dependency. Analytics is Rust-only; only shared
  paths (the tabular chunker, `chartSpec.ts`) touch the TS side, and only to
  stay byte-identical.
