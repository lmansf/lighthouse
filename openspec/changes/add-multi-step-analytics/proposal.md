# Multi-step analytics: compare, explain, and reason across queries

## Why

"Compare Q3 vs Q4 and explain the drivers" needs several queries; today's analytics branch writes exactly one SELECT (plus one error retry), so comparison and why-questions either fail or get a single-query approximation. This is the capability ceiling between "runs my query" and "does my analysis".

## What Changes

- A **bounded multi-step loop** for analytics questions that also carry a comparison/explanation cue: the model may request up to 3 sequential queries; each runs through the existing guard and executor; the final narration sees every step's verified result. Numbers remain 100% engine-computed.
- **Remote-model gating**: multi-step runs only on keyed remote providers (`has_real_model` minus local) — the local 7B's 6144-token window can't carry multi-step context; local users keep today's single-query path.
- Progress streams per step ("Running query 2 of 3…"), and the provenance footer lists **every** executed query.

## Capabilities

### New Capabilities
- `multi-step-analytics`: the bounded plan→query→verify loop, its gating, and its provenance.

### Modified Capabilities
<!-- none -->

## Impact

- `native/crates/lighthouse-core/src/analytics.rs` (secondary cue, step-reply parsing, step prompt), `synth.rs` (loop in the analytics branch, footer, progress).
- No UI change (existing progress + footer rendering), no contracts change, no TS-twin change (analytics is Rust-only).
- Depends on nothing new; benefits from `add-tabular-scale` (groups/join hints make step queries land).
