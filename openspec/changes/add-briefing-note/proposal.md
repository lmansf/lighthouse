# Briefing note: a deterministic, self-refreshing "what changed" note with an opt-in daily nudge

## Why

Pinned questions already re-run on a schedule and quietly alert when a verified
answer changes (add-pinned-questions). But the change lives only in a transient
in-app toast and the pin dialog's "before → now" line. A user who wants a
durable, glanceable record — "what moved in my numbers since yesterday" — has
nowhere to find it, and nothing brings them back to the app when it matters.

The briefing REPORT (add-briefings) is the wrong tool for this: it is a
user-curated selection run on demand or on a cadence, composed from each pin's
last summary. What's missing is the automatic, zero-configuration counterpart —
a single note that the app keeps fresh from *whatever changed*, written as a
real vault file the user can open, search, and keep.

Every value in that note must hold the same trust invariant the rest of
analytics holds: it is a pin's VERIFIED before/after summary, composed by
deterministic string formatting with NO model call. The note states no number
the engine didn't already compute.

## What Changes

- **A deterministic note composer (both engines, byte-identical).**
  `compose_briefing_note(changed, now_ms)` renders one before→after table per
  changed pin plus a UTC freshness footer and an explicit "no AI" line. It is
  pure string formatting over pins' verified summaries — no model, no live SQL.
  The Rust engine ships it; the TS twin mirrors it byte-for-byte (a Node golden
  test pins the exact output against the Rust golden test).
- **A once-per-day scheduled refresh (desktop shell).** The existing pin-recheck
  task accumulates the pins that changed since the last note, and — gated by a
  pure `note_due(last_note_ms, now_ms, hour)` decision (local hour ≥ the user's
  setting AND not already written today) — overwrites `Lighthouse Notes/
  Lighthouse Briefing.md` in place, stamps the run, and fires ONE OS
  notification. The gate and the last-run stamp live engine-side so they are
  in-container testable without a clock.
- **An opt-in, never-intrusive notification.** The OS notification is ON by
  default but suppressed while the app is hidden/idle-suspended (the
  background-conserve "never wake from the tray" rule) and fully disableable via
  a `briefingNotify` setting. The note file is ALWAYS written regardless — only
  the nudge is gated.
- **An on-demand refresh from the pins dialog.** A "Refresh briefing note" action
  rechecks every pin now, composes, and overwrites the same file — with NO
  notification, because the user is already looking at the result.
- **In-place, escape-proof writes.** A new `refresh_artifact` vault helper does a
  truncating overwrite at a deterministic, sanitized, `safe_abs`-guarded path
  (no collision-suffixed duplicates), so the note is a single file that updates,
  not a growing pile.
- **Two new settings** — `briefingNotify` (default on) and `briefingNoteHour`
  (0–23, default 9) — round-tripped through the exhaustive settings tripwire and
  both engines' settings writers.

## Capabilities

### New Capabilities
- `briefing-note`: the deterministic, model-free note composer; the once-per-day
  scheduled refresh and its pure due-gate; the opt-in, hidden-app-respecting
  notification; the on-demand dialog refresh; and the in-place, vault-escape-safe
  write — all preserving "every value is a verified pin summary, never model
  text."

### Modified Capabilities
<!-- pinned-questions is unchanged: the note READS the same ChangedPin the pin
     recheck already produces. No pin behavior, digest, or alert changes. -->

## Impact

- `native/crates/lighthouse-core/src/briefings.rs`: `compose_briefing_note`
  (Rust-only composer, but mirrored in TS), `note_due` pure gate,
  `last_note_ms`/`mark_note_run` state (state/briefing-note.json), `esc_cell`;
  Rust tests (compose golden, empty set, due gate, state round-trip).
- `native/crates/lighthouse-core/src/vault.rs`: `refresh_artifact` (truncating,
  safe_abs-guarded in-place write) + a vault test.
- `native/crates/lighthouse-core/src/settings.rs` + `tests/settings_test.rs`:
  `briefing_notify`/`briefing_note_hour` fields + writer params, covered by the
  no-`..` exhaustiveness tripwire.
- `native/crates/lighthouse-desktop`: the scheduled refresh + `maybe_notify`
  gate in `main.rs`, the `refreshBriefingNote` IPC op + settings get/set in
  `commands.rs`, `tauri-plugin-notification` in `Cargo.toml`/capabilities
  (CI-only build).
- `native/crates/lighthouse-server/src/routes.rs`: the `refreshBriefingNote`
  HTTP op + the two new settings keys (dev-twin parity).
- TS twin: `src/server/briefings.ts` (`composeBriefingNote`, byte-parity),
  `src/server/vault.ts` (`refreshArtifact`), `src/server/settings.ts`,
  `app/api/rag/route.ts` (`refreshBriefingNote` case), `app/api/settings/route.ts`,
  `src/shell/tauriTransport.ts`, the contracts (`services.ts`/`rag.real.ts`/
  `rag.mock.ts`), and `test/briefings.test.mjs` (golden byte-parity).
- `src/features/chat/ChatPanel.tsx` (dialog refresh button) +
  `src/features/license/LicenseGate.tsx` (the two Preferences controls).
- No `CACHE_VERSION` bump (extraction untouched).

## Non-goals

- **No model in the note.** Composition is deterministic string formatting over
  verified pin summaries. There is no summarization, ranking, or prose.
- **No new schedule engine.** The note rides the pin-recheck task that already
  runs; the only new decision is the pure daily due-gate.
- **The note is never withheld to respect a notification setting.** Disabling the
  nudge or hiding the app suppresses only the OS notification — the file still
  refreshes.
- **No multiple/append history.** The note is ONE file overwritten in place, not
  a dated series; durable history is the user's to keep by copying.
- **No cross-file recompute.** The note reports the pins' own before/after; it
  performs no arithmetic and joins nothing.
- **No cache-version bump.** The note reads live pin state; extraction and its
  cache are untouched.
