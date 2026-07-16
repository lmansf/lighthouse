# add-shaped-views

## Why

Real files are messy — currency symbols inside numeric columns, junk header
rows, four quarterly exports that are really one dataset. Today every ask
pays that mess again, and the only "fix" is editing the source file, which
Lighthouse never does (sources are immutable). A shaped view gives the mess
a name: ONE guarded SELECT, saved once and resolved virtually at ask time,
so the cleanup is written once, reproducible always, and the bytes on disk
never change.

## What Changes

- A new store `.rag-vault/views.json` (versioned envelope `{v:1, views}`,
  bak-on-write — the investigations/boards idiom) holding views:
  {id, name (sanitized, unique), sql (ONE guarded SELECT over source tables
  and/or other views), reads (dependencies resolved at save), summary
  (plain language, provenance-labeled), createdMs}.
- Views are VIRTUAL. At ask time, after ordinary file registration, every
  view whose transitive source files are all present registers as
  `ctx.register_table(name, df.into_view())` — no materialized copies, no
  row caches. Freshness follows the underlying files' digests automatically;
  a registered view counts against the existing table slots.
- View-over-view composes as a DAG only: cycle detection and a small depth
  cap reject bad definitions at save (and definitions are re-guarded before
  every execution — defense in depth).
- Creation is explicit and evidence-first: (a) a "Save as view" chip on any
  Beam answer that carries SQL; (b) a shaping ask — the model proposes ONE
  transform SELECT, the engine renders before/after samples (first rows of
  the source and of the result), and NOTHING persists until the user clicks
  Save. Files are never modified.
- Visibility: views appear in the catalog/table cards (marked as views),
  in a Library section of the nav, in suggested asks, and in the inspector
  (definition SQL, provenance-labeled summary, the sources it reads,
  freshness).
- Local-only marks propagate: a view over a marked file is itself
  local-only — excluded from cloud asks exactly like the file.
- Lifecycle: rename refuses while dependents exist (with the list); delete
  refuses while dependents exist or cascades after explicit confirmation;
  deleting a view never touches sources.

## Capabilities

### New Capabilities

- `views`: shaped views — the object and store, guarded definitions, DAG
  rules, virtual resolution at ask time, creation flows with
  engine-rendered evidence, visibility surfaces, local-only propagation,
  and lifecycle protection.

## Non-goals

- **No materialization.** Views resolve virtually per ask; a
  materialize-to-cache mode is a designed follow-on, not v1.
- **No in-place redefinition.** v1 is create / rename / delete; changing a
  view's SELECT means saving a new view. This keeps DAG maintenance
  trivial and every saved definition immutable-by-construction.
- **Sources are never written.** Not on create, not on delete, not on
  cascade — views live in views.json only.
- **No new model surface beyond the single shaping completion**, which
  rides the same `collect(stream_answer)` machinery as multi-step
  analytics. Everything else — guard, samples, catalog, freshness,
  resolution — is deterministic engine work.
- **Twin executes nothing.** The TS twin gets the store, CRUD, validation,
  and visibility; registration, samples, and the shaping completion are
  Rust-only (PARITY).
- **No per-investigation scoping of views.** Views are vault-global
  catalog objects; investigations continue to scope FILES, and a view is
  usable exactly where its sources are allowed.
- **No view export/sharing as an object.** Evidence packs already carry
  SQL and provenance verbatim.

## Impact

- Engine: NEW `native/crates/lighthouse-core/src/views.rs` ⇄
  `src/server/views.ts` (store, CRUD, dependency derivation, DAG
  validation, lifecycle rules). `analytics.rs` gains view registration in
  the two ctx builders (ask path + `run_direct`) and view-aware table
  cards; the answer-cache key material gains registered-view definitions;
  the local-only check extends transitively to views; catalog / suggested
  asks / inspector gain view entries. Dispatch `op:"views"` +
  `op:"shapeView"` in `routes.rs` / `commands.rs` / `app/api/rag/route.ts`.
- Contracts/UI: View types + RagService methods (+ real/mock);
  "Save as view" chip in the answer chip row; a ShapeView dialog; a
  Library nav section; inspector view mode; rename/delete dialogs with
  dependent lists.
- `docs/data-flows.md` MUST NOT grow (no new egress; the shaping
  completion goes to the already-configured provider exactly like any ask,
  and local-only sources force the local path).
