# add-semantic-layer

## Why

Beam can answer a shaped question, and recipes can run a shaped analysis, but
every ask still re-derives what a business term MEANS. Ask "what was revenue by
region" twice and the model may write `SUM(amount)` once and
`SUM(amount) FILTER (WHERE status='paid')` the next — two different numbers for
one word, each individually "engine-computed" and each equally unaccountable.
Shaped views (H3) fixed the SHAPE of a messy table; they did nothing for the
MEANING of a column. The recurring definitions — revenue, active customer,
churn, margin — are re-guessed on every ask, and nothing tells the analyst
whether the number they are looking at came from the definition the business
agreed on or from a one-off the model invented this turn.

This change adds a **local semantic layer**: a curated, device-resident layer
of business meaning over the vault's tables — canonical **metrics** (a name
bound to a guarded SQL aggregation, e.g.
`revenue = SUM(amount) FILTER (WHERE status='paid')`), **synonyms** (a term
mapped to a canonical column or metric), **entities** (a name bound to a table
plus its key columns and what it represents), and curated **join hints** (how
tables relate) — persisted and managed with the SAME rigor as shaped views. The
layer FEEDS NL→SQL: blessed definitions and synonyms ride into the analytics
prompt so the model computes a term the agreed way instead of re-guessing, and
a metric reference resolves deterministically to its definition.

On top of the layer sit two trust capabilities:

- **S3 — certified answers.** An answer whose executed SQL VERIFIABLY used a
  blessed metric definition carries a "certified" mark, distinct from an ad-hoc
  query. Verifiably means engine-determined by AST equality against the stored
  definition — never a decoration, never a model claim.
- **S2 — trust check.** A verification pass reconciles a computed answer against
  the semantic layer and the guard: it confirms the SQL used the metric's
  blessed definition AND RE-RUNS that definition through the guarded executor to
  check the numbers reconcile, then surfaces a trust verdict. Model-free — a
  real check, not an LLM opinion.

The whole layer is device data: definitions never egress; a metric over a
local-only-marked table is itself local-only; certified and trust marks are
computed on-device. Naming note: this "semantic layer" (business meaning) is
distinct from the existing `semanticSearch` setting (hybrid embedding
retrieval) — different subsystem, deliberately not conflated.

## What Changes

- **The semantic model + store (do first).** A new store
  `state_dir()/semantic.json` — the shaped-views idiom verbatim: versioned
  envelope `{v:1, metrics, synonyms, entities, joinHints}`, `store_lock`
  serialization, bak-on-write on an unreadable file, stable engine-minted ids,
  name sanitization/uniqueness. A **Metric** is `{id, name, expression
  (a guarded SQL aggregation), description, entity (the table/view it computes
  over), reads (source files/views resolved at save), summary, createdMs}`; the
  expression is validated at save by wrapping it as
  `SELECT <expression> AS <name> FROM <entity>` and running the SAME
  `guard_sql` every executed query passes, so a definition is always a
  re-runnable read-only SELECT. **Synonyms** map a term to a canonical column or
  metric; **entities** bind a name to a table + key columns + description;
  **join hints** are curated relations. Local-only propagation and posture
  eligibility mirror `views::view_effectively_local_only` /
  `eligible_for_posture`.
- **Resolution into NL→SQL.** At the analytics prompt assembly
  (`synth.rs:1268-1284`, where file cards and view cards become `sql_ctxs`),
  inject a deterministic "business definitions" context block built from the
  posture-eligible metrics/synonyms/entities/join-hints, plus
  `SEMANTIC_FEWSHOTS` showing a metric reference resolving to its definition.
  The block feeds BOTH the single-query `sql_question` and the multi-step
  `step_question` paths. Zero definitions ⇒ the block is empty and every prompt
  string is byte-identical to today (the shaped-views precedent). A model-free
  `resolve_metric(name) -> expression` resolves a reference without a model.
- **S3 — certified answers.** After a query executes, a deterministic,
  model-free check (`analytics.rs`, the `ledger.rs` AST-walk precedent) compares
  the executed SQL's projection expressions against each blessed metric
  expression by normalized-AST equality. A match certifies the answer for that
  metric. The mark rides a new `AnalyticsMeta.certified` field (persisted in
  `CachedAnswer.analytics`, so a replay carries it), and an engine-emitted
  `*Certified:*` footer line (never model text) names the metric.
- **S2 — trust check.** A verification pass that (1) runs the §3 definition
  check, then (2) RE-RUNS the blessed definition through `run_query` (the same
  guard, timeout, caps) and compares the reconciled number(s) to the answer's,
  producing a `TrustVerdict { certified, reconciled, metric, expected, got }` on
  `AnalyticsMeta.trust`. Deterministic: the same answer yields a byte-identical
  verdict; a number that does not reconcile is CAUGHT (verdict fails).
- **Management UI + surfaces.** A minimal semantic-layer editor mirroring the
  shaped-views management surface: define/list metrics + synonyms, a
  "Define as metric" chip on a Beam answer, dispatch `op:"semantic"` (CRUD) +
  `op:"defineMetric"`. The certified badge + trust verdict render on the answer
  card. `meta.rs` surfaces the applicable definitions (the
  `applicable_recipes` precedent).
- **Both engines.** Store, CRUD, validation, local-only propagation, prompt
  labels, and the certified/trust wire shapes mirror in the TS twin
  byte-compatibly; the certified/trust COMPUTATION and prompt injection are
  Rust-only analytics (PARITY, like recipes/ledger/views resolution).

## Capabilities

### New Capabilities

- `semantic-layer`: the curated business-meaning model — metrics (guarded,
  re-runnable definitions), synonyms, entities, curated join hints; the
  versioned local store managed like shaped-views (dependency-aware,
  local-only-posture-aware); resolution into NL→SQL (blessed definitions +
  synonyms fed to the analytics prompt; a metric reference resolved to its
  definition); the few-shots.
- `certified-answers`: the S3 certified mark — an answer verifiably computed
  through a blessed metric definition, determined by engine-side normalized-AST
  equality (never a model claim), surfaced on the analytics card and an
  engine-emitted footer, persisted through the answer cache so a replay stays
  certified.
- `trust-check`: the S2 verification pass — reconciles a computed answer against
  the semantic layer + guard by re-running the blessed definition through the
  guarded executor and comparing numbers, surfacing a deterministic trust
  verdict that catches a mismatch.

## Non-goals

- **Not a new number source.** The model never authors a certified number and
  never asserts "certified"; every figure still traces to an engine-executed
  guarded query. The semantic layer changes which DEFINITION the SQL uses, not
  who computes the number.
- **Certified is a verified fact, never a decoration.** A "certified" mark means
  the executed SQL's aggregation is AST-equal to the blessed definition. An
  ad-hoc query that merely resembles a metric is NOT certified.
- **The trust check is model-free reconciliation, not an LLM judge.** It re-runs
  the definition through the guard and compares numbers; it never asks a model
  whether the answer is trustworthy.
- **Definitions never egress; the layer is device data.** A metric over a
  local-only table is itself local-only — excluded from a cloud ask's prompt and
  its cache key, exactly like a local-only view.
- **No user-authored entities/join-hints beyond the minimal editor v1.** v1
  ships metric + synonym authoring and the record formats for entities/join
  hints; a full relationship-graph editor is a designed follow-on, not v1.
- **Twin computes nothing.** The TS twin gets the store, CRUD, validation, and
  visibility; prompt injection, certification, and reconciliation are Rust-only
  (analytics/DataFusion), degrading honestly (PARITY).
- **No version bump.** This is an H-suite phase (Phase B, following Phase A
  `add-beam-loop`); it stays on the current line and does not move the version
  stamps.

## Impact

- **Engine (Rust, ships):** NEW
  `native/crates/lighthouse-core/src/semantic.rs` ⇄ `src/server/semantic.ts`
  (store, CRUD, DAG/lifecycle rules, local-only propagation, `eligible_for_posture`,
  the `resolve_metric` resolver, the prompt-block builder). `analytics.rs`
  (`guard_metric_expression` wrapping an expression as a guarded SELECT;
  `SEMANTIC_FEWSHOTS` + a validating test; `certified_metrics(sql, defs)` — the
  normalized-AST equality check on the `ledger.rs` walker; `reconcile_metric` —
  re-run a definition via `run_query` and compare). `synth.rs:1268-1284` (inject
  the semantic context block into `sql_ctxs` for the single-query and multi-step
  paths); `synth.rs:1103/1657/1864` (set `AnalyticsMeta.certified` / `.trust` at
  the three final-chunk sites; emit the `*Certified:*` footer). `contracts.rs`
  (`AnalyticsMeta.certified: Option<Vec<String>>` + `.trust: Option<TrustVerdict>`;
  the `TrustVerdict` struct; mirrored in `types.ts`). `answer_cache.rs`
  (`key_from_parts`/`cache_key` gain a semantic-registry key component joining
  only when non-empty — the `\nv:` view-registry precedent — so a changed
  definition invalidates honestly and zero definitions leaves every legacy key
  byte-identical). `meta.rs` (`applicable_semantics` surfacing +
  `op:"semantic"`/`op:"defineMetric"` dispatch across `routes.rs`/`commands.rs`/
  `app/api/rag/route.ts`). `settings.rs` is UNTOUCHED — the store is the state
  (the shaped-views precedent), so no `DesktopSettings` field and
  `settings_test.rs` stays as-is.
- **Lockstep gates:** §3/§4 add persisted fields to `AnalyticsMeta` (part of
  `CachedAnswer`), a shared cached-answer wire-shape change, so `CACHE_VERSION`
  moves **11→12** in lockstep across `native/.../extract.rs`,
  `src/server/extract.ts`, and the assertion in `tests/extract_test.rs`
  (ts-twin.md rule 4; the beam-loop 10→11 precedent). `CACHE_VERSION` for the
  extract/schema-card cache is unaffected on its own.
- **Contracts/UI:** semantic-layer types + `RagService` methods (+ real/mock);
  NEW `src/features/semantic/SemanticNav.tsx` (the `ViewsNav` template) + a
  "Define as metric" chip in the answer chip row; a certified badge + trust
  verdict on the answer card.
- **Data flows / egress:** no NEW egress. The semantic block rides the prompt
  already sent to the configured provider (definitions are metadata the analyst
  authored); the certified check and the trust reconcile are on-device
  `run_query` work; local-only definitions force the local path.
