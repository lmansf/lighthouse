# Pinned questions: Beam taps you on the shoulder

## Why

Analysts re-ask the same questions every day ("open P1 tickets by priority") to see if anything moved. Lighthouse already watches every vault file; what's missing is memory of which numbers the user cares about. Pinning a question turns Lighthouse from a tool you interrogate into one that briefs you when the data changes.

## What Changes

- **Pin an analytics answer**: a pin captures the question, its exact SQL, and the file ids it read (all available from the answer's analytics metadata). Pins persist in the state dir (cap 20).
- **Watcher-driven rechecks**: on vault changes (debounced), the desktop engine re-runs each pin's stored SQL — deterministically, no model — and compares a result digest. A changed result emits an event with a compact before/after summary.
- **Alerts in the UI**: a banner surfaces changed pins ("📌 Open tickets by priority — changed"); clicking re-asks the question for a full narrated answer. A pins dialog lists, re-checks, and removes pins; stale pins (schema changed, file gone) show why.

## Capabilities

### New Capabilities
- `pinned-questions`: persisting, rechecking, and alerting on watched analytics questions.

### Modified Capabilities
<!-- none -->

## Impact

- New `native/crates/lighthouse-core/src/pins.rs` (store + recheck), `lighthouse-desktop/src/main.rs` (debounced scheduler off the watch generation + Tauri event), `routes.rs`/`commands.rs` (pin ops).
- `src/contracts` (types/service/mocks), `src/features/chat/ChatPanel.tsx` (pin toggle + alert banner), a small pins dialog under the settings gear.
- TS twin: pin CRUD + on-demand recheck (no background scheduler — PARITY; the web dev server rechecks when pins are listed).
- Depends on `add-analytics-refinement` (analytics metadata + direct execution path).
