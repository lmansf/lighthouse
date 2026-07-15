# Design — local-only marks

## Data model & persistence

A new `local_only: HashMap<String, bool>` (Rust) / `localOnly: Record<string,
boolean>` (TS) sits beside `included` on `VaultState`
(`vault.rs:30-41` ⇄ `vault.ts:31-40`). Only **explicit** marks are stored;
absence means "not local-only".

**Migration safety without a version field.** `state.json` is deliberately
un-versioned (unlike the index's `DISK_VERSION` and the extract cache's
`CACHE_VERSION`): both engines read it with per-field tolerance — Rust
`#[serde(default)]`, TS `raw.x ?? default` — and re-serialize the whole struct
on write. An additive map therefore needs no migration: an old `state.json`
with no `localOnly` key loads as an empty map (nothing marked), and the next
write persists the field. Adding a schema version here would break the
established convention for zero benefit on an additive change; we follow the
same path `included` itself took.

## Effective value — ancestor-wins

`is_effectively_local_only(id)` walks the node's ancestors (by the same prefix
logic as `is_effectively_included`, `vault.rs:225-243`): the node is local-only
if **it or any ancestor** carries an explicit `true`. This makes a folder mark
cover its subtree by *resolution*, so — unlike `set_included`, which cascades
writes to every descendant — `set_local_only` writes **only the target's own
flag**. Consequences: marking a folder privatizes everything under it; a child
can be marked independently; you cannot "un-private" a child beneath a marked
ancestor (ancestor wins, by design — the safe direction). Move/rename/remove
remap and capture/restore the `local_only` keys exactly as they already do for
`included` (`vault.rs:573-630`, `935-961`).

## Enforcement — one shareable set, plus the two bypassers

Cloud-ness is a single predicate: **the active provider is a keyed remote
vendor** (`anthropic|openai|google|xai|mistral|deepseek`), i.e. `provider_id !=
"local"`. It is already resolved next to the audit/egress plumbing in
`chat_post` (`routes.rs:491-494`) and carried on the pipeline `cfg`.

The master gate `active_included_file_ids()` (`vault.rs:1102-1115` ⇄
`vault.ts:809`) gains a shareable-set form: **when a cloud provider is active it
returns the active-included set minus every effectively-local-only id; on the
local/extractive path it is unchanged.** Because retrieval, the analytics
candidate gather (`synth.rs:487-518`), catalog reads, and meta answers all start
from that gate, routing them through the shareable form covers them in one move.

Two paths bypass the global gate and are filtered at their own choke points:
- **Attachments** (`retrieve` attachment branch, `vault.rs:1837-1849`; wired
  `synth.rs`/`routes.rs:448`) — a per-question consent scope. When cloud is
  active, effectively-local-only attachment ids are dropped before retrieval.
- **Named-file / doc-focus** (`named_file_target`/`doc_text`,
  `vault.rs:2153-2211`) — dropped the same way so a "summarize <private file>"
  ask can't smuggle its full text to a vendor.

Belt-and-suspenders at the highest-leakage point: `analytics::register_tables`
(`analytics.rs:334-425`) builds schema cards carrying **column names, types, and
three sample rows** and pushes them as `Ctx` to the model — it filters the
shareable set before registering, so a private table's columns/samples never
reach a cloud prompt even if a future caller forgets the gate.

## Rust/TS parity

- **Mirrored (byte-parallel):** the `local_only` map, `is_effectively_local_only`,
  `set_local_only`, the op + service + store wiring, the shareable-set gate, the
  attachment/doc-focus filters, and the honesty-note template (byte-identical
  string, per `docs/ts-twin.md` rule 2).
- **PARITY-diverged (Rust-only, already so):** analytics table registration
  (`analytics.rs`) and the column catalog (`catalog.rs`) are Rust-engine-only —
  the TS twin's `analyticsSql`/`findColumn` already error/no-op, so there is no
  cloud egress of columns to gate there; the enforcement lands only in Rust, with
  a `PARITY:` note on the TS side pointing at the Rust filter. The shareable-set
  gate itself is mirrored so the **parity test (identical candidate sets under a
  cloud provider) passes on the retrieval path both engines exercise.**

## Failure & degradation

- **Fail closed toward privacy.** The shareable set only ever *subtracts*. If the
  provider can't be resolved, treat it as cloud (exclude local-only) — the safe
  default. A bug that mis-marks a file as local-only degrades to "the cloud model
  didn't see a file"; the inverse (leaking a private file) is the one we design
  against, and the belt-and-suspenders analytics filter guards the worst path.
- **Local/extractive path unaffected.** With `provider_id == "local"` (or no
  provider configured — the extractive fallback), the gate returns the full
  included set; local-only is inert, so on-device answers are byte-identical to
  today.
- **6144-token window:** enforcement can only shrink the candidate set, never
  grow it, so it never pressures the local model's window. When files *are*
  dropped, the freed budget is used by the remaining context as usual; the
  honesty note is a short fixed string.
- **Degrade, never break:** if resolving local-only fails for any node, that
  node is treated as local-only (excluded from cloud) rather than aborting the
  answer — consistent with "failures degrade, never break an answer".
