# Design — add-pinned-questions

## Context

`watch.rs` exposes a monotonic `generation()` bumped on every relevant filesystem event (already debounced/coalesced), and the desktop shell already pushes vault-refresh events to windows. `add-analytics-refinement` provides `run_direct(sql, file_ids)` — deterministic guarded re-execution — and answers carry `{ sql, fileIds }`. State-dir JSON stores with serde are the established persistence idiom (profile, settings).

## Goals / Non-Goals

**Goals:**
- Zero model cost per recheck (stored SQL re-runs; only the CLICK-through re-narrates).
- Alerts are trustworthy: fire only when the computed result actually changed.
- Pins degrade visibly (stale + reason), never crash or spam.

**Non-Goals:**
- Cron-style schedules or OS notifications (vault-change-driven, in-app only, v1).
- Threshold alerts ("notify when > 100") — digest inequality only.
- Cross-machine pin sync.

## Decisions

1. **A pin is `{ id, question, sql, file_ids, created_ms, last_run_ms, last_digest, last_summary, stale_reason? }`** persisted at `state/pins.json` (cap 20 — a briefing list, not a dashboard product). `last_summary` = first ≤3 result rows rendered compactly, so the alert can say what changed without re-running anything.
2. **Recheck = `run_direct` + digest.** Digest = SHA-1 of the result markdown (stable: engine rendering is deterministic and ordering comes from the query's ORDER BY; queries without ORDER BY may reorder — accepted, worst case a rare false-positive alert). Failure (file gone, schema drift, guard error) sets `stale_reason` and clears alerts for that pin rather than alerting forever.
3. **Scheduler lives in the desktop shell, not core.** A tokio task samples `watch::generation()` every 30 s; when it advanced, debounce 60 s of quiet, then recheck ALL pins sequentially (≤20 × one local query — cheap) and emit one Tauri event `pins-changed { changed: [{ id, question, before, after }] }`. Rationale: core stays runtime-agnostic; the shell already owns background loops (update checks, warm passes). Per-file targeting was considered and rejected — generation is global, pins are few, and rechecking all is simpler and correct.
4. **Ops on `/api/rag`**: `pinAsk { question, sql, fileIds }`, `unpinAsk { id }`, `listPins`, `recheckPins` (manual). The TS twin implements all four but rechecks only on demand (`listPins`/`recheckPins`) — no background loop in the dev server (PARITY).
5. **UI: banner + dialog, chat-first.** Changed pins render one dismissible banner atop the chat (and the widget shows a dot); clicking a changed pin submits its question through the normal ask path — the fresh narrated answer IS the drill-down. The pins dialog (settings gear) lists pins with age/status, manual re-check, and remove.

**Degradation:** pins.json corrupt ⇒ start empty (never block boot); recheck errors mark stale with reason; event emission failures are logged to shell.log and retried on next generation change. No model, no window pressure.

## Risks / Trade-offs

- [Alert flapping on volatile files] → 60 s quiet debounce + digest (not mtime) comparison; a genuinely oscillating number IS a legitimate alert.
- [Stored SQL outlives a renamed column] → stale_reason surfaces in the dialog with the engine error; one click re-asks the question to re-derive fresh SQL, and re-pinning replaces the pin.
- [Recheck storm on bulk file operations] → generation sampling + quiet window collapses any burst into one recheck pass.
