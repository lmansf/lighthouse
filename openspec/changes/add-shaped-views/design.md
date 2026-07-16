# add-shaped-views — design

## The object

```
View {
  id: string            // engine-minted, stable
  name: string          // sanitized identifier, unique case-insensitively among views
  sql: string           // ONE guarded SELECT (guard_sql at save AND before every execution)
  reads: {              // dependencies, resolved at save and stored
    files: [{ fileId: string, tableName: string }],   // name binding pinned at save
    views: [string]     // view ids
  }
  summary: { text: string, source: "question" | "model" }
  createdMs: i64
}
```

Envelope `{v:1, views:[...]}` in `state_dir()/views.json` — the
investigations/boards idiom verbatim (only v1 loads; unknown/corrupt
preserved as `.bak-<epochms>` on next write). Views are vault-global.

**Names.** Sanitized with the `sanitize_table_name` rules (lowercase,
`[a-z0-9_]`, no leading digit), capped at 64 chars, refusing a small
reserved-keyword list (select/from/where/join/group/order/by/with/union/
all/as/on/limit/table/values) and refusing collision with any CURRENT
catalog file table name. At resolution time files always win a name
collision (the view is skipped and logged) — a view can never shadow a
real table.

**Dependency derivation at save.** Rust walks the sqlparser AST's table
factors (the same parse `guard_sql` already does), EXCLUDING CTE names
declared in WITH clauses; names matching saved views become `reads.views`,
names matching the source tables in play become `reads.files` with the
name binding `{fileId, tableName}` pinned as stored. The TS twin derives
reads with a conservative FROM/JOIN identifier scan (PARITY: the twin
never executes; the authoritative derivation is the Rust parser, and
desktop re-guards + re-derives nothing at run time — it trusts the stored
record but re-runs `guard_sql` before execution).

**DAG rules at save.** A definition is rejected when (a) `guard_sql`
fails, (b) any referenced view is unknown, (c) it would create a cycle, or
(d) its depth exceeds `MAX_VIEW_DEPTH = 3` (a view over only files has
depth 1; referencing a view of depth d makes depth d+1). Because v1 has no
in-place redefinition, edges never change after save — rename keeps ids
stable and delete refuses/cascades — so the invariant holds by
construction; the cycle check stays anyway as defense.

## Virtual resolution at ask time

The two ctx builders (the ask path's `register_tables` consumer in
synth.rs and `run_direct`) gain one wrapper step AFTER ordinary file
registration:

1. **Eligibility**: a view is eligible when its transitive `reads.files`
   are ALL among the just-registered file ids. This composes with
   investigation scope and managed policy for free — out-of-scope sources
   never registered ⇒ dependent views never registered. On cloud asks a
   view that is effectively local-only (see below) is ineligible.
2. **Registration**, in creation order (deterministic): resolve each
   `reads.files` binding — if the ambient registration gave that file a
   different table name (collision suffixing), register an alias of the
   existing provider under the stored name; if the stored name is already
   taken by a DIFFERENT table, skip the view (logged). Then re-run
   `guard_sql(view.sql)` and `ctx.sql(&view.sql)` →
   `ctx.register_table(&view.name, df.into_view())` — the exact primitive
   the engine already uses for CSV union views. Each registered view
   consumes ONE table slot under the existing `MAX_TABLES_TOTAL`
   accounting; when slots run out, remaining views are skipped
   deterministically, never an error. Any resolution failure skips that
   view and logs — an ask never fails because a view is broken.
3. **Cards**: a registered view renders a table card like any table,
   marked as a view and carrying its one-line summary, so the model knows
   what it is. Source files are ambient registrations, so the provenance
   footer ("Computed from: …") keeps listing real files with saved times —
   freshness IS the underlying digests; there is nothing else to expire.

**Answer cache.** The key is computed once at ask entry, BEFORE retrieval
— so the per-ask registered set is not knowable at key time. Instead the
key material gains a `v:` component digesting the view REGISTRY as it
could apply to this ask: every view eligible under the ask's posture
(cloud asks exclude effectively-local-only views), sorted by name, as
`name\u{0}sql` pairs — appended ONLY when at least one such view exists
(the H1 "r:" precedent, so every legacy key stays byte-identical). Source
DATA freshness is already covered by the existing candidate digest;
the `v:` component covers the definitions themselves, so creating,
renaming, or deleting a view invalidates honestly. KEEP IN SYNC across
answer_cache.rs ⇄ answerCache.ts.

## Local-only propagation

`is_effectively_local_only` semantics extend transitively: a view is
effectively local-only when ANY transitive source file is. Cloud asks
exclude such views from eligibility and catalog surfaces (the
`shareable_subset` posture); the shaping ask over a local-only source
forces the local model path via the H1 `local_model_config()` seam, and
the provenance stamp stays honest for free.

## Creation flows

**Save-as-view chip.** Beam answers carrying `AnalyticsMeta {sql, fileIds}`
gain a "Save as view" chip beside Edit SQL / Save as CSV / Pin. It opens a
small name dialog; create persists `{name, sql, reads derived at save,
summary: {text: the asked question, source: "question"}}`. No model call.

**Shaping ask** (`op:"shapeView"`, desktop): request
`{source: table-or-view name + file ids, instruction}`. The engine builds
a mini-prompt — the source's table card (schema + sample rows, the
existing `table_card` output) + few-shot examples + the instruction — and
makes ONE `collect(llm::stream_answer(...))` completion (the multi-step
idiom). The reply's SELECT is recovered with the existing `extract_sql`,
checked with `guard_sql`, then the engine renders evidence: first
`SAMPLE_ROWS` of the source and of the proposed SELECT via the direct
machinery + `batches_to_markdown`. The response is a PROPOSAL
`{sql, before, after, summary}` — nothing persists until the UI calls
`views.create` on the Save click. The few-shot SELECTs are pinned by a
test that runs each through `guard_sql` (the chart-directive precedent of
validating few-shots with the engine's own validator). Extractive-only
provider ⇒ `{available:false}` with honest copy. Files are never opened
for write anywhere in the flow.

## Lifecycle

- **Rename**: refused while dependents exist, returning the dependent
  names for the UI to show (chosen over rewrite-dependents: dependent SQL
  is user-approved text; silently editing it risks corrupting a definition
  where the old name also appears as a column). No dependents ⇒ rename is
  a pure store update; id, reads, and dependents' stored bindings are
  untouched.
- **Delete**: refused by default while dependents exist, returning the
  transitive dependent list; `cascade:true` (sent only after the UI's
  explicit confirmation showing that list) deletes the view plus its
  transitive dependents in one write. Sources are never touched by any
  path — the E2E asserts source bytes are identical after delete.

## Rust/TS parity

- `views.rs` ⇄ `views.ts`: byte-compatible envelope + CRUD + name rules +
  cycle/depth checks + dependent rules. PARITY divergences, each marked:
  reads derivation (AST vs textual scan) and the definition guard (the
  twin uses a textual single-SELECT check — no INSERT/UPDATE/…, single
  statement, starts with SELECT/WITH — since `guard_sql`'s parser is
  Rust-only and the twin never executes; desktop re-guards before every
  execution regardless).
- Resolution, samples, and `shapeView` are Rust-only; the twin's
  `shapeView` answers `{available:false}` and its catalog/inspector
  surfaces render stored state (the pins.ts / boards refreshCards
  precedent).
- UI is client-shared; the widget is untouched.

## Failure & degradation

- Source file deleted/unreadable ⇒ the view stays saved, drops out of
  eligibility (its file id is never registered), and the inspector shows
  the missing source honestly. Never blocks an ask.
- Registration/parse failure at resolution ⇒ skip + log, ask proceeds
  without the view.
- Corrupt/unknown-version views.json ⇒ session-empty + bak-on-write.
- Shaping completion returns no usable SELECT ⇒ the dialog shows the
  refusal with the raw reason; nothing persisted, retry is free.
- Power-conserve: resolution and samples are model-free (no gating); the
  shaping completion behaves like any ask.
- 6144-token local window: the shaping prompt is one table card +
  few-shots — bounded exactly like the existing analytics prompt path.
