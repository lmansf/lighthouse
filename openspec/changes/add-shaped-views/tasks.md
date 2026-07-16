# Tasks — shaped views

## 1. View object + store + DAG (both engines, PARITY)
- [x] 1.1 `views.rs` ⇄ `views.ts`: envelope {v:1, views}, bak-on-write, CRUD (list/create/rename/delete+cascade); name sanitization (table-name rules, 64 cap, reserved keywords, no collision with current file table names), case-insensitive uniqueness among views.
- [x] 1.2 Dependency derivation at save (Rust: sqlparser table-factor walk excluding CTE names; twin: FROM/JOIN scan, PARITY) stored as reads {files:[{fileId,tableName}], views:[id]}; `guard_sql` on the definition (twin: textual single-SELECT check, PARITY); unknown-view reference, cycle, and MAX_VIEW_DEPTH=3 rejection at save.
- [x] 1.3 Unit tests both engines: round trip, bak-on-write, guard refusals, name rules, cycle/depth rejection, dependent-refusal + cascade-set computation, sources untouched by every op.

## 2. Virtual resolution at ask time (Rust engine)
- [ ] 2.1 Registration wrapper after file registration (ask path + `run_direct`): eligibility = transitive reads.files ⊆ registered ids (composes with scope/policy); creation-order determinism; stored-name alias when ambient naming differs, files-win on collision; re-guard then `ctx.sql` → `register_table(name, df.into_view())`; one table slot per view under existing caps; skip-and-log on any failure.
- [ ] 2.2 View table cards (marked as view + summary) join the prompt; provenance footer keeps naming source files; local-only views ineligible on cloud asks (transitive `is_effectively_local_only`).
- [ ] 2.3 Answer-cache key material gains registered views (`v:` component, sorted, only when non-empty — legacy keys byte-identical); freshness surfaces from underlying digests.
- [ ] 2.4 Tests: ask-against-view returns shaped numbers via real DataFusion; source edit flows through with no on-disk rows; slot skipping deterministic; local-only exclusion; cache-key stability (no views) + sensitivity (view registered).

## 3. Creation flows
- [ ] 3.1 "Save as view" chip on SQL-bearing answers (chip row slot): name dialog → `views.create`; summary = the asked question, source:"question"; wired through contracts (types/services/real/mock) + dispatch `op:"views"` all three layers.
- [ ] 3.2 `op:"shapeView"` (desktop): mini-prompt (source `table_card` + few-shots + instruction) → one `collect(stream_answer)` → `extract_sql` + `guard_sql` → before/after SAMPLE_ROWS samples engine-rendered → proposal {sql, before, after, summary(source:"model")}; nothing persists without `views.create`; local-only source forces the local path; extractive provider → {available:false}; few-shots pinned by a guard test; twin returns {available:false} (PARITY).
- [ ] 3.3 ShapeView dialog UI: source picker (tables + views), instruction, proposal review (SQL + before/after tables), Save/Cancel; Beam treatment both themes.

## 4. Visibility surfaces
- [ ] 4.1 Catalog + suggested asks include views; inspector opens on a view (definition SQL, labeled summary, sources it reads, freshness); Library nav section (sidebar fragment, InvestigationsNav pattern); local-only badge propagates in UI; twin renders stored state honestly.

## 5. Lifecycle
- [ ] 5.1 Rename refuses with dependent list (surfaced in UI); delete refuses by default with transitive list, cascade only behind explicit confirmation showing it; delete/cascade never touch sources; twin CRUD parity.

## 6. Verify
- [ ] 6.1 Engine E2E (views_test.rs): messy fixture CSV → shaping proposal path on a canned model reply (real extract/guard/sample) → save → guarded ask via the view returns verified numbers → cascade delete → fixture byte-identical. UI structural tests: chip, dialog, nav, inspector, lifecycle dialogs.
- [ ] 6.2 Eval floor: +1 view-backed Golden in `examples/analytics_eval.rs` (messy fixture + saved view + question answered through the view).
- [ ] 6.3 Full gates: cargo core+server, npm suite, tsc, lint, smoke, analytics + chart eval floors, `openspec validate --all`.
