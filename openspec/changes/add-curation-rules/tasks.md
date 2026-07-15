# Tasks — curation rules

## 1. Engine (both engines, PARITY)
- [x] 1.1 `CurationRule` + `VaultState.rules` (serde-default ⇄ `?? []`); add-time validation (predicate/action whitelists, glob parse).
- [x] 1.2 Rule evaluation inside `is_effectively_included` / `is_effectively_local_only`: explicit-first, ancestor-exclusion inviolable, deepest-scope-then-last-defined, `clear` masks; walk-cache invalidation on rule writes.
- [x] 1.3 Attribution sibling (`Explicit | AncestorExcluded | Rule(id) | Default`) for the inspector; rule display names.
- [x] 1.4 `rules` CRUD op (list/add/remove) across routes.rs / commands.rs / app/api/rag/route.ts / sources dispatchers; `RagService.rules` + real/mock; store slice.
- [x] 1.5 Units: precedence table, explicit-wins, ancestor-exclusion, clear, removal-reverts, glob/ext/kind predicates; parity fixtures resolving identical effective sets in both engines.

## 2. UI
- [x] 2.1 "Rules for this folder…" on folder rows (`FileExplorer.tsx`): scoped list + create dialog (predicate builder: kind / extensions / glob; action picker).
- [x] 2.2 Preferences rule list (`SettingsMenu.tsx`): all rules, scope-named, removable; orphaned scopes marked.
- [x] 2.3 Inspector rule line (`FileInspector.tsx`): "included by rule '<name>'" / local-only analog.

## 3. E2E
- [x] 3.1 Create a rule, drop a NEW matching file into the vault directory, assert it arrives with the rule's flags (walk resolution, no per-node write) and the inspector attributes the rule.

## 4. Verify
- [x] 4.1 Full verification: cargo core+server, npm test, tsc, lint.
