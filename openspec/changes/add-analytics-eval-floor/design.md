# Design — add-analytics-eval-floor

## Context

The analytics branch is: schema cards → model writes ONE guarded `SELECT` →
`guard_sql` → `run_query` (post-plan `LIMIT 201`, 10s timeout, 200×24 caps) →
narrate with the verified result; `synth.rs` appends the deterministic
`*Query used:*` + `*Computed from:*` footer. `run_direct`/`run_direct_save`
re-run a stored SQL model-free for Edit-SQL, pins, and Save-CSV. Every number a
user sees must trace to engine output; failures must degrade, never break an
answer; the local model has a 6144-token window the narration caps protect.

`run_query` fetches `MAX_RESULT_ROWS + 1` rows precisely to *detect* overflow
without scanning everything — but it then reports `shown` (saturated at 200) as
the total, so the honesty the +1 probe was meant to enable is dropped on the
floor. And while the code is careful, nothing in the test suite asserts the
*computed statistics*, so correctness rests on reading, not on a gate.

## Goals / Non-Goals

**Goals:**
- A capped result is stated honestly — the true row count in the answer AND a
  deterministic footer, on the ask path and every model-free re-exec path.
- Every audit-confirmed defect gets a fix and a regression test that fails
  without it.
- A durable, deterministic **model-free** executor floor in `cargo test`, plus a
  provider-gated NL scorecard for local runs that can never flake CI.

**Non-Goals:**
- Re-architecting the engine, widening the SQL surface, or relaxing any cap.
- Counting rows on *every* query — the extra `COUNT(*)` runs only when a result
  actually overflowed (already a large result), never on the common small one.
- Making the NL scorecard a CI gate — model output is non-deterministic; the CI
  floor is strictly the model-free executor + snapshot tests.
- Changing TS-twin behavior. Analytics is Rust-only; the only shared code (the
  tabular chunker, `chartSpec.ts`) is touched only to stay byte-identical.

## Decisions

1. **Count only on overflow.** `run_query` keeps the `LIMIT 201` probe. When
   `truncated`, it runs one `SELECT COUNT(*) FROM (<the guarded sql>)` under the
   same 10s timeout to learn the true total, stored as `QueryResult.total:
   Option<usize>`. The subquery is the already-guarded single SELECT, so no new
   statement class can enter; a count failure or timeout leaves `total = None`.
   `DirectResult` grows the same `total`/`truncated` fields.
2. **Honest, engine-authored surfacing.** The narration note becomes "first N
   rows of TOTAL — narrate from these and tell the user the full count", or
   "first N rows; more rows exist beyond the {cap}-row cap" when the count is
   unavailable — never "N total" when N is the cap. `synth.rs` and
   `direct_footer` emit a new deterministic footer line, e.g.
   `_Showing the first 200 rows of 12,431._` (or `…of many._` on count failure),
   never model-generated. Non-truncated results are unchanged in every byte.
3. **Golden floor = model-free `cargo test`.** New `#[tokio::test]` cases pin the
   exact computed result for each wrong-but-plausible class the audit names —
   month grouping over ISO strings, NULL-in-AVG denominators, Excel-serial date
   columns, union of same-shaped monthlies, a cross-format join, header
   detection, and the truncation total. Prompt-snapshot tests pin `sql_question`
   / `step_question` so a prompt edit is caught. All deterministic, all in the
   normal gate.
4. **Scorecard = provider-gated example.** `examples/analytics_eval.rs` builds
   fixtures, and for each (question → expected numbers) runs the real
   `sql_question` → provider → `extract_sql` → `guard_sql` → `run_query` and
   checks each expected number appears in the verified result. With no provider
   env configured it prints "no provider — skipping model scorecard" and exits
   0. It additionally runs a deterministic model-free section (known-good SQL →
   expected numbers) that always checks, so a developer gets signal even offline.
5. **Audit fixes carry their own regression tests.** Each confirmed finding is
   fixed at its site with a focused test; parity-shared fixes (chunker,
   chartSpec.ts) update both engines' fixtures together.

**Parity:** Rust-only engine, per the standing analytics divergence. The tabular
chunker (`vault.rs` ⇄ `src/server/vault.ts`) and `chartSpec.ts` are the only
shared surfaces; any fix there lands byte-identically in both, with the parity
fixtures updated in lockstep.

**Degradation & the 6144-token window:** the truncation `COUNT(*)` is one cheap
aggregate that only fires on an already-overflowing result and shares the
existing 10s timeout; on any error it yields `total = None` and the answer still
lands. The new footer is a single short line and the narration caps are
unchanged, so the local model's window budget is untouched.

## Risks / Trade-offs

- **A second scan on overflow.** `COUNT(*)` over the guarded query re-scans the
  input. It only runs when the first pass already returned >200 rows (so the
  data is non-trivial), is bounded by the same 10s timeout, and falls back to
  `total = None` on timeout — the answer is never blocked. Accepted: honesty on
  large results is worth one bounded aggregate.
- **Snapshot brittleness.** Prompt-snapshot tests fail on intentional prompt
  edits. That is the point — the fix is to update the snapshot in the same
  commit, which forces a human to see the prompt diff.
- **Scorecard drift.** The NL scorecard depends on a provider and model version;
  keeping it out of CI avoids flakiness but means it only runs when a developer
  invokes it. Mitigated by the model-free floor carrying the deterministic
  guarantees.

## Known limitations (audit findings surfaced, deliberately not "fixed")

The two-pass audit found more than the fixes above. Some are left as documented
limitations because a change would risk NEW wrong answers (heuristic type
guessing) or invasive parity gymnastics for a low-severity gain — surfacing them
honestly is the same principle as the truncation footer:

- **CSV date columns and `substr`.** DataFusion's CSV reader infers an ISO-date
  column as `Date32`, so the few-shots' bare `substr(date,1,7)` fails on CSV
  date columns (it works on the workbook path, where dates are Utf8). The error
  is loud (`substr requires String`) so the model's one corrective retry casts
  or uses `date_trunc` — a wasted round, never a wrong number. Making CSV date
  columns register as strings for consistency is a larger change; the scorecard
  documents the robust `substr(CAST(d AS VARCHAR),1,7)` form.
- **Slashed / non-ISO CSV dates.** `year_of` classifies `m/d/yyyy` as a date so
  the profile shows a healthy year range, but the taught `substr` idiom can't
  bucket them. Same class as above; the profile is honest about the range, not
  the format.
- **Lenient `year_of`.** Accepts `0000-00-00`→year 0 and `2024-99-99`→2024
  (month/day unchecked). Only affects malformed dates; validating ranges is a
  parity-paired change with real fixture churn for a cosmetic gain.
- **Year-valued columns are summed as measures** in the profile (`sum of Year`).
  Semantically odd, never a wrong sum of the actual values; a name/range
  heuristic to exclude them risks dropping a genuine measure.
- **`num_of` over-accepts** grouped commas / trailing `%`, so an id/zip column
  of `"1,001"` can read as a summable measure. Tightening the grammar is
  parity-paired and low-frequency.
- **Catalog vs profile date vote diverge** on non-ISO dates (metadata only — no
  wrong number).
- **Pin digests cover the first ~200 rows** of a result; a change past row 200
  in a truncated pin isn't detected, and an unordered truncated query can flap.
  Pins are near-always aggregates (≤200 rows), so this is bounded.
- **Chart-kind heuristics** (`looks_temporal` accepting `2024-13` / `Q9 2024`)
  and label collisions on the 40-char x-axis truncation affect chart *kind* or
  clarity, never a plotted value — deferred to the presentation-polish change.
- **CSV/Parquet unions** validate only the first member's schema at registration
  (the workbook path checks every member); a divergent older member surfaces at
  query time as a graceful fall-through, not a silent wrong union.
