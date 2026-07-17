# Design — curation rules

## Rules as a resolution layer (the load-bearing decision)

A rule never writes `included`/`local_only`. It is evaluated live inside the
effective-state resolvers, so the three hard requirements fall out structurally:

- **Future arrivals:** a file that appears tomorrow matches the same predicate
  at walk time — nothing to apply, nothing to miss.
- **Explicit toggle always wins:** the resolvers check the node's own explicit
  flag first, exactly as today; rules are consulted only when no explicit flag
  decides.
- **Non-surprising removal:** deleting a rule deletes only its layer — every
  node it was deciding reverts to the next layer (another rule, or the global
  default); every explicit flag survives untouched.

## Precedence (deterministic, documented, test-pinned)

For inclusion: (1) explicit own flag → (2) explicit ancestor exclusion (the
existing ancestor-wins semantics, never overridden by any rule — a rule cannot
resurrect a subtree the user excluded) → (3) rules whose scope contains the
node and whose predicate matches: deepest scope wins; within one scope, the
last-defined wins; `clear` is a first-class outcome (masks shallower rules,
yields the default) → (4) the global onboarding default.

For local-only: (1) explicit own/ancestor mark (ancestor-wins, as shipped) →
(2) matching `local-only` rules (same scope ordering) → (3) unmarked. A rule
can only ADD privacy relative to explicit state, never remove an explicit mark.

Predicates: `kind` uses the extraction/catalog classification already
computed (tabular / document / image); `ext` is a lowercase extension list;
`glob` matches the path relative to the scope folder (`*`/`**`/`?` only, no
brace expansion — small, hand-rolled, identical in both engines).

## Attribution ("included by rule 'spreadsheets in /reports'")

The resolver gains a sibling that returns *why*: `Explicit | AncestorExcluded |
Rule(id) | Default`. The inspector renders the rule's human name (rules carry a
generated display name from predicate + scope, editable later); the explorer
keeps rendering effective state only. Attribution is computed on demand (the
inspector's one file), not stored.

## Persistence & wire

`VaultState.rules: Vec<CurationRule>` with `#[serde(default)]` ⇄
`vaultState.rules ?? []` — the established un-versioned tolerance story; old
state files load rule-less. CRUD op `{op:"rules", action: list|add|remove,
rule?}` beside `include`/`localOnly` across routes.rs / commands.rs /
app/api/rag/route.ts / sources dispatchers; `RagService.rules` + a store slice
for the two UIs. Rule ids are short random strings minted engine-side.

## Rust/TS parity

Rule evaluation is shared retrieval-adjacent behavior → lands in BOTH engines
with shared fixtures (same vault tree, same rules, assert identical effective
sets in the parity test — the local-only parity test pattern). The `kind`
predicate degrades honestly in the TS twin where a format is Rust-only
(name-match-only files have no catalog kind: `kind` rules simply don't match
them there — `PARITY:` note; ext/glob rules are full-fidelity both sides).

## Failure & degradation

- An unparseable rule (bad glob, unknown action) is rejected at add-time
  (400/Err); a stored rule that fails to evaluate is skipped (layer falls
  through) rather than breaking the walk.
- Rule evaluation is O(rules × depth) per node with the same walk cache as
  today; rule changes invalidate the walk cache like flag writes do.
- Deleting the scope folder orphans its rules → they match nothing;
  list surfaces them (with the scope name struck) for cleanup; no auto-delete
  (the folder may return — e.g. an unplugged linked root).
- 6144 window: no prompt impact — rules change only which files are candidates.
