# Tasks — briefing note

## 1. Engine composer + gate + state (briefings.rs, Rust; TS twin byte-identical)
- [x] 1.1 `compose_briefing_note(changed, now_ms)`: one before→after GFM table per
  pin, pipe-escaped cells, "—" for a missing prior, UTC footer + "no AI" line;
  empty set → coherent "nothing changed" note.
- [x] 1.2 `note_due(last_note_ms, now_ms, hour)`: pure local-day gate (hour ≥ set
  AND not already written today).
- [x] 1.3 `last_note_ms` / `mark_note_run` state (state/briefing-note.json, atomic).
- [x] 1.4 Rust tests: compose golden, empty set, four-case due gate, state round-trip.
- [x] 1.5 TS `composeBriefingNote` (src/server/briefings.ts) — byte-identical (UTC).

## 2. In-place vault write (vault.rs + twin)
- [x] 2.1 `refresh_artifact(subdir, name_hint, ext, bytes)`: shared sanitize +
  `safe_abs` guard, truncating overwrite, walk-cache invalidation.
- [x] 2.2 Rust `vault_test`: overwrites in place, stays inside the vault.
- [x] 2.3 TS `refreshArtifact` (src/server/vault.ts) mirror.

## 3. Settings (both engines + tripwire)
- [x] 3.1 `briefing_notify` (default on) + `briefing_note_hour` (0–23, default 9)
  on `DesktopSettings` + positional writer (hour validated 0–23).
- [x] 3.2 `settings_test.rs`: both fields in the no-`..` destructure, wire-key
  list, and the positional-writer round-trip.
- [x] 3.3 TS `settings.ts` (`briefingNotify`/`briefingNoteHour`) +
  `app/api/settings/route.ts` GET/POST + `tauriTransport.ts` passthrough.

## 4. Desktop shell (CI-only build)
- [x] 4.1 `main.rs`: accumulate changed pins per id (earliest before / latest
  after) across recheck passes; on `note_due`, refresh the note, `mark_note_run`,
  emit vault-changed, `maybe_notify`, clear the accumulator.
- [x] 4.2 `maybe_notify`: gate on `briefingNotify != false` AND not suspended;
  best-effort `NotificationExt` show.
- [x] 4.3 `commands.rs`: `refreshBriefingNote` IPC op (recheck to freshen →
  compose from a snapshot of all pins with a summary → refresh_artifact; NO
  notification, NO daily-gate stamp — decoupled from the scheduled note) +
  settings get/set the two new keys/params (both `write_desktop_settings` sites).
- [x] 4.4 `Cargo.toml` `tauri-plugin-notification = "2"` + `.plugin(...init())` +
  `capabilities/default.json` `notification:default` + Cargo.lock entry.

## 5. Dev-twin server + contracts + UI
- [x] 5.1 `lighthouse-server/routes.rs`: `refreshBriefingNote` HTTP op (snapshot,
  no daily-gate stamp) + the two settings keys (get/set), parity with the desktop op.
- [x] 5.2 `app/api/rag/route.ts`: `refreshBriefingNote` case (compose from pins
  with a last summary, `refreshArtifact`) + contracts
  (`services.ts`/`rag.real.ts`/`rag.mock.ts`).
- [x] 5.3 `ChatPanel.tsx`: "Refresh briefing note" action in the pins dialog
  (on-demand, confirms inline).
- [x] 5.4 `LicenseGate.tsx`: Preferences — notify switch + daily-hour picker.

## 6. Gates
- [x] 6.1 `cargo test -p lighthouse-core -p lighthouse-server` green.
- [x] 6.2 `tsc --noEmit` + `next lint` + `node --test test/*.test.mjs` green
  (incl. the composeBriefingNote byte-parity test).
- [x] 6.3 No `CACHE_VERSION` change.
- [x] 6.4 `node scripts/openspec-validate.mjs add-briefing-note` green.
- [ ] 6.5 CI-only: desktop-release builds with the notification plugin
  (`--locked`); scheduled write + notification and the two Preferences controls
  visually verified.
