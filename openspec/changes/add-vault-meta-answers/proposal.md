# Vault meta-answers and suggested asks

## Why

Questions ABOUT the vault — "what's new this week?", "what spreadsheets do I have?", "which files have an employee-id column?" — need no model at all, yet today they run the full retrieval pipeline and often answer poorly. And a new user staring at an empty chat has no idea what the genie can do with the files they just included.

## What Changes

- **Meta-answers**: a conservative, deterministic pre-model stage in the synthesis pipeline answers vault questions instantly from walk metadata (recency, counts, kinds) and — on desktop — the column catalog (column-membership questions). Real references attach; anything below full confidence falls through to the normal pipeline unchanged.
- **Suggested asks**: an engine op derives 3–4 concrete, answerable questions from the columns of the most recent included tabular files ("Total amount by region", "Monthly trend of amount") and the chat's empty state renders them as one-tap chips.

## Capabilities

### New Capabilities
- `vault-meta-answers`: instant deterministic answers to questions about the vault itself.
- `suggested-asks`: engine-derived example questions surfaced in the chat empty state.

### Modified Capabilities
<!-- none -->

## Impact

- `native/crates/lighthouse-core/src/synth.rs` (pre-model stage), new `meta.rs` (cues + renderers), `catalog.rs` consumption, `suggestedAsks` op in routes.rs/commands.rs.
- `src/server/synth.ts` + new `src/server/meta.ts` (recency/list parity; column questions are PARITY desktop-only), `/api/rag` op.
- `src/features/chat/ChatPanel.tsx` empty-state chips; contracts service + mocks.
