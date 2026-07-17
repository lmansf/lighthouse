# add-semantic-layer — design

## The feature this is closest to: shaped views (H3)

`views.rs` is the template, and this change follows it deliberately. A shaped
view named a messy TABLE once (`{id, name, sql, reads, summary, createdMs}` in a
versioned `views.json`, guarded at save, resolved virtually at ask time,
local-only-propagating, DAG-safe, twin-mirrored). A metric names a messy
DEFINITION once, with the same machinery: the store envelope, `store_lock`,
bak-on-write, stable sha1 ids, name sanitization, save-time guarding,
dependency derivation, `eligible_for_posture`, and the CRUD/lifecycle rules are
lifted from `views.rs` verbatim. Where views registered a virtual table, the
semantic layer instead (a) feeds definitions into the prompt and (b) certifies
answers that used them. Reading `views.rs` first is the fastest way to review
this change.

Naming caution: the existing `DesktopSettings.semantic_search`
(`settings.rs:56`) is the hybrid-embedding retrieval toggle — a DIFFERENT
subsystem. This layer is `semantic.rs` / `semantic.json` / the `semantic-layer`
capability; it adds no setting, so the two never collide on the wire.

## §1 — The semantic model + store (foundation)

A new `semantic.rs` ⇄ `semantic.ts`, store at `state_dir()/semantic.json`, the
`views.rs` versioning posture verbatim: envelope `{v:1, metrics, synonyms,
entities, joinHints}`, `v==1` loads, anything else (unknown/missing version,
corrupt JSON) reads EMPTY for the session and the next write baks the file to
`semantic.json.bak-<epochms>` first. `store_lock()` serializes load-modify-save.

```
Metric   { id, name, expression, description, entity, reads: Reads, summary, created_ms }
Synonym  { term, canonical }            // canonical = a column name OR a metric name
Entity   { name, table, key_columns, description }
JoinHint { left_entity, left_column, right_entity, right_column, description }
```

- **A metric's `expression` is a guarded, re-runnable definition.** The stored
  value is an aggregation expression (`SUM(amount) FILTER (WHERE status='paid')`),
  NOT a full statement. It is validated at save by synthesizing
  `SELECT <expression> AS <name> FROM <entity>` and running the SAME
  `analytics::guard_sql` every executed query passes — so a saved metric is
  always a read-only SELECT the engine can re-run (this is what §4 leans on).
  The synthesized SELECT's table factors also derive `reads` (the
  `views::collect_table_names` AST walk), so a metric over a source file/view
  carries its dependencies and propagates local-only.
- **Ids, names, uniqueness** reuse `views.rs`: `metric-` + sha1(name\nexpression
  \ncreatedMs)[..12]; `normalize_view_name`'s character rules; unique
  case-insensitively; a metric name may not shadow a column of its entity.
- **Local-only propagation** is `view_effectively_local_only` applied to a
  metric/entity's `reads`: any transitive source file marked local-only (the
  vault ancestor-wins resolver) makes the definition local-only.
  `eligible_for_posture(is_cloud)` returns the definitions usable under the ask's
  posture — every definition on device; only non-local-only ones on a cloud ask.
  This ONE function governs both what feeds a cloud prompt (§2) and what joins
  the cache key (below).
- **No setting.** The store is the state, exactly like `views.json`; `settings.rs`
  and `settings_test.rs` are untouched (the shaped-views precedent; the
  plan-approval §4.5 "no toggle" precedent for stating it).

## §2 — Resolution into NL→SQL

The injection point is `synth.rs:1268-1284`, where `sql_ctxs` is assembled
(file cards, then view cards, then `join_hints`) and handed to BOTH
`sql_question` (single-query) and `step_question` (multi-step). After the view
cards, append ONE deterministic `Ctx` block, `semantic::prompt_block(is_cloud)`:

- The posture-eligible metrics (`name = expression — description`), synonyms
  (`term → canonical`), entities (`name: table (key columns) — what it is`), and
  curated join hints, in a fixed order. Curated join hints render alongside the
  existing heuristic `analytics::join_hints`; the curated ones are labeled and
  win when they name the same pair.
- `SEMANTIC_FEWSHOTS` — messy-question→blessed-SQL pairs showing a metric
  reference expanding to its definition (e.g. "revenue by region" →
  `SELECT region, SUM(amount) FILTER (WHERE status='paid') AS revenue FROM
  sales GROUP BY region`). Every few-shot SELECT passes `guard_sql`, pinned by a
  test (the `SHAPE_FEWSHOTS`/`SQL_FEWSHOTS` validating-test precedent).
- **Empty store ⇒ empty block ⇒ byte-identical prompt.** When no definition is
  eligible, the block contributes nothing and every prompt string is exactly
  today's — the shaped-views "zero views" guarantee, pinned by a test.
- **`resolve_metric(name) -> Option<String>`** is the model-free resolver: a
  metric reference resolves to its stored expression with no model call. §3/§4
  and the eval floor use it; the prompt block uses it to render definitions.

**6144-token window:** the block is BUDGETED like every analytics context —
metric/synonym lines are short, and the eligible set is bounded; on a local
provider the block still rides (definitions are cheap text, unlike multi-step
result context), but the certify/trust computation below is remote-or-local
agnostic because it is model-free. If the definition set is large, the block
caps by count (newest-first, the `register_tables` slot-cap idiom) so it can
never blow the window.

## §3 — S3 certified answers

Certification is DETERMINISTIC and model-free (§14). After a query executes and
its SQL is known (`synth.rs`, the `sql` in hand at each `AnalyticsMeta`
construction — `:1103`, `:1657`, `:1864`), call
`analytics::certified_metrics(sql, &eligible_defs) -> Vec<String>`:

- Parse the executed SQL with `DFParser` (the `ledger.rs`/`guard_sql` parser, so
  the certifier can never disagree with the guard about what the SQL says) and
  collect its projection expressions.
- For each eligible metric, parse its stored `expression` the same way and
  compare by NORMALIZED-AST equality — the `ledger.rs` `Expr::to_string()` idiom,
  so whitespace, casing, and alias differences don't matter but a genuinely
  different aggregation does. A projection expr that string-equals the metric's
  parsed expr certifies the answer for that metric.
- The result is the list of metric names the answer verifiably computed. It
  rides `AnalyticsMeta.certified: Option<Vec<String>>` and an engine-emitted
  `*Certified:* revenue` footer line (never model text — placed after
  Query-used/Computed-from/Assumptions, the deterministic footer order).

"Certified" therefore means: the engine parsed the SQL that ran and confirmed
its aggregation IS the blessed definition. An ad-hoc `SUM(amount)` that omits
the `FILTER` is NOT AST-equal to `SUM(amount) FILTER (WHERE status='paid')`, so
it is not certified — the mark can never be a decoration.

## §4 — S2 trust check

The trust check is §3's definition-match PLUS a numeric reconciliation, both
deterministic:

1. **Definition check** — `certified_metrics(sql, defs)` (§3): did the SQL use a
   blessed definition at all?
2. **Reconcile** — for a certified metric, RE-RUN the blessed definition on the
   SAME `ctx` through `run_query` (the same guard, timeout, and caps as the
   original) — `SELECT <expression> AS <name> FROM <entity>` (plus the answer's
   own GROUP BY / WHERE when the answer is grouped, so like is compared to like)
   — and compare the re-run scalar/`QueryResult.digest` to the answer's. Equal ⇒
   `reconciled: true`; different ⇒ `reconciled: false` (the check CAUGHT a
   mismatch). No model is consulted at any step.

The verdict `TrustVerdict { certified: bool, reconciled: bool, metric:
Option<String>, expected: Option<String>, got: Option<String> }` rides
`AnalyticsMeta.trust`. It is byte-deterministic — the same `(sql, result, defs)`
always yields the same verdict, snapshot-testable like the ledger. A non-metric
ad-hoc answer has `certified: false` and no reconcile (verdict is simply "not
certified", honest, not a failure). Reconciliation failure is the SIGNAL the
capability exists to raise, surfaced plainly on the card, never swallowed.

**Degradation:** if the re-run definition errors or times out (`run_query`
returns `Err`), the verdict records `reconciled: false` with the reason rather
than fabricating a pass — doubt is never certified. A trust check never breaks
the answer: the number was already computed and shown; the verdict is an
addition to its meta, and its absence (older cache entries) renders no badge.

## Answer-cache persistence & key (cross-cutting)

- **Wire shape.** `AnalyticsMeta` gains `certified` + `trust`, both
  `#[serde(default, skip_serializing_if = "Option::is_none")]` so pre-Phase-B
  cached entries (no field) stay valid. Because `AnalyticsMeta` is persisted in
  `CachedAnswer.analytics` and a replay re-emits `..hit.analytics`, a cached
  certified answer replays STILL certified with its original verdict — no
  recompute. This is a shared cached-answer wire-shape change, so
  **`CACHE_VERSION` moves 11→12** across `extract.rs`, `extract.ts`, and
  `tests/extract_test.rs` (ts-twin.md rule 4; the beam-loop `manifest` 10→11
  precedent). The additive-optional fields mean old entries remain readable; the
  bump follows the repo's lockstep convention regardless.
- **Key material.** `key_from_parts`/`cache_key` (`answer_cache.rs:148`/`:191`)
  gain a semantic-registry component — the posture-eligible definitions as
  sorted `(name, expression)` pairs — joining the key as `\ns:` ONLY when
  non-empty, exactly like the `\nv:` view registry and the `\nr:` recall
  preference. Changing a metric definition then invalidates dependent cached
  answers honestly; a vault with zero definitions leaves every legacy key
  byte-identical (pinned against the literal material, the
  `view_registry_joins_the_key_only_when_non_empty` test precedent). This is key
  material, not the envelope, so it needs no `CACHE_VERSION` bump of its own.

## §5 — Management UI + surfaces (engine lands first)

`meta.rs` gains `applicable_semantics(included, is_cloud)` — the eligible
metrics/synonyms for the current tables, the `applicable_recipes` /
`suggested_asks_resolved` shape — and dispatch arms `op:"semantic"` (list /
create-metric / create-synonym / rename / delete) + `op:"defineMetric"` (propose
a metric from a Beam answer's SQL, the "Save as view" precedent), threaded
`routes.rs` / `commands.rs` / `app/api/rag/route.ts`. UI: `SemanticNav.tsx` on
the `ViewsNav` template (list + define metrics/synonyms), a "Define as metric"
chip on any Beam answer that carries an aggregation, and a certified badge +
trust verdict on the answer card. Scope is minimal-but-honest: metric + synonym
authoring v1; entities/join-hints have record formats and prompt rendering but
the full relationship editor is a follow-on.

## Rust/TS PARITY split

| Seam | Rust (ships) | TS twin |
|---|---|---|
| Store + CRUD + validation + local-only propagation (§1) | implemented in `semantic.rs` | mirrored in `semantic.ts` byte-compatibly (envelope, ids, error strings, DAG/lifecycle) — the `views.ts` precedent; textual single-SELECT guard, FROM/JOIN reads scan (PARITY) |
| Prompt block + few-shot LABELS (§2) | implemented | byte-identical labels where the twin assembles ctxs; the analytics injection itself is Rust-only (no analytics branch) |
| Metric resolver (§2) | implemented | mirrored (pure string lookup, no model) |
| Certified check (§3) | implemented (AST equality) | Rust-only (analytics); twin never certifies, `PARITY:` note |
| Trust reconcile (§4) | implemented (`run_query` re-run) | Rust-only (DataFusion); twin never reconciles, `PARITY:` note |
| `AnalyticsMeta.certified`/`.trust` + `TrustVerdict` shape | implemented | mirrored in `types.ts` (wire shape only; twin never populates) |
| Cache key `\ns:` component | implemented | mirrored in `answerCache.ts` (byte layout pinned) |

The store/CRUD/validation/key are SHARED behavior and land in both engines
(rule 1); the prompt injection, certification, and reconciliation are Rust-only
because analytics/DataFusion is Rust-engine-only (ts-twin.md), degrading
honestly (never a fake certified mark).

## Failure & degradation

- **No definitions:** the prompt block is empty, the prompt is byte-identical to
  today, no answer is certified, no verdict renders — the feature is inert until
  a metric exists.
- **Unparseable/dirty executed SQL:** the certifier parses with the guard's own
  parser; anything it can't parse simply certifies nothing (never a false
  positive), exactly as `ledger.rs` under-reports rather than guesses.
- **Reconcile error/timeout:** `reconciled: false` with the reason, never a
  fabricated pass; the answer itself is unaffected.
- **Local / extractive provider:** definitions still feed the (local) prompt and
  certification/reconciliation still run (they are model-free), so a
  local-model answer can be certified and reconciled exactly like a cloud one —
  the trust capabilities are provider-agnostic by construction.
- **Local-only definition on a cloud ask:** excluded from the prompt block and
  the cache key by `eligible_for_posture`, so a private table's meaning never
  rides a view of itself into a vendor prompt.
