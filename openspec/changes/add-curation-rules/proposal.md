# Bulk curation rules: per-folder, deterministic, future-proof

## Why

Big-vault curation is file-by-file today: a `/reports` folder that gains twelve
spreadsheets a month means twelve eye-toggles a month, forever. The existing
levers are all per-node (explicit include/exclude/local-only flags) or global
(the onboarding default). What's missing is the middle: *"in this folder,
spreadsheets are included"*, *"everything under /HR is local-only"* — stated
once, applying to files that arrive later, without ever surprising the user by
overriding what they set by hand.

## What Changes

- **A rule** is `{id, scope: folder id, predicate, action}` where predicate is
  ONE of: file kind (tabular / document / image), an extension list, or a glob
  on the path relative to the scope; action is `include | exclude | local-only
  | clear` (`clear` = a scoped return-to-default that masks broader rules).
- **Rules are a resolution layer, not writes.** Evaluation happens live at
  walk/resolution time, layered between explicit flags and the global default:
  1. an explicit per-node user toggle always wins over any rule;
  2. explicit ancestor-exclusion semantics are never overridden;
  3. matching rules apply — deepest scope wins; within a scope, the
     last-defined rule wins;
  4. otherwise the global onboarding default.
  Because nothing is written into `included`/`local_only` by a rule, FUTURE
  arrivals are covered by construction (a new file simply resolves), and
  **removal is non-surprising by construction**: deleting a rule makes exactly
  the nodes it was deciding revert to the next layer down — explicit flags are
  untouched.
- **Legibility:** the inspector's plain-language state says when a rule decided
  a flag — *"included by rule 'spreadsheets in /reports'"* — and the explorer's
  effective eye/lock states reflect rules like any other resolution.
- **UI:** "Rules for this folder…" on folder rows (list + create for that
  scope) and a complete rule list in Preferences.
- Persisted as a `rules` array in `state.json` (serde-default; the established
  un-versioned migration story).

## Capabilities

### New Capabilities
- `curation-rules`: deterministic per-folder predicates that resolve inclusion
  and local-only state for present and future files, always subordinate to
  explicit user toggles and ancestor exclusion.

## Impact

- **Both engines (PARITY):** `VaultState.rules` + rule evaluation inside the
  effective-state resolvers (`is_effectively_included` vault.rs:234 ⇄ vault.ts;
  `is_effectively_local_only` :261) + a "which rule decided" reporter for the
  inspector; a `rules` CRUD op beside `include`/`localOnly` in routes.rs /
  commands.rs / app/api/rag/route.ts / sources dispatchers; `RagService` +
  store actions.
- **UI:** folder-row "Rules for this folder…" (`FileExplorer.tsx` context
  menu), the Preferences rule list (`SettingsMenu.tsx` PreferencesDialog), the
  inspector rule line (`FileInspector.tsx` status section).
- **Tests:** rule-evaluation parity (same fixtures both engines), precedence
  units, and the E2E: create a rule, drop a new matching file into the vault,
  watch it arrive with the rule's flags.

## Non-goals

- **No content predicates.** Kind / extension / glob only — deterministic from
  the path and catalog kind; never "files mentioning X".
- **No rule ever mutates per-node flags** — no bulk-write mode, no "apply rule
  now" that stamps nodes. (The existing multiselect bulk actions remain the
  explicit-write tool.)
- **No cross-scope or vault-global rules in v1** — a rule's scope is one
  folder (the vault root is a folder).
- **No scheduling/automation beyond resolution** — rules don't watch, notify,
  or run jobs; they resolve.
- **No new egress; no schema version** for state.json.
