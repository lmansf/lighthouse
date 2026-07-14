# Tasks — add-managed-policy

## 1. Engine core (policy.rs)

- [ ] 1.1 `native/crates/lighthouse-core/src/policy.rs`: `Policy` struct
      (v1 keys, all `Option`), per-OS `machine_policy_path()`,
      debug-only `LIGHTHOUSE_POLICY_FILE` override, `OnceLock` load with
      the three states (absent / valid / malformed→fail-closed), unknown-key
      logging, `policy()` accessor + `provider_allowed(id)`,
      `telemetry_allowed()`, `history_allowed()`, `ocr_allowed()`,
      `notifications_allowed()`, `audit_forced_on()`,
      `vault_path_allowed(path)` (canonicalize + component-boundary prefix).
      Unit tests: each helper across absent/valid/malformed; boundary cases
      (`/srv/vaults-evil`); unknown keys ignored; test-seam reset.
- [ ] 1.2 TS twin `src/server/policy.ts`: same schema/semantics for
      providers/telemetry/history; PARITY comments for the desktop-only
      keys. Node tests mirroring 1.1's provider/telemetry/history cases.

## 2. Enforcement points

- [ ] 2.1 Providers: `profile.rs` select_model rejects disallowed ids;
      `llm.rs` stream_answer refuses a disallowed provider and falls
      through to the local/extractive path. TS twin: same two spots
      (`profile.ts`, `llm.ts`).
- [ ] 2.2 Telemetry: `license.rs` `ping`/`record_event`/`publish_usage_events`
      + `experiment.rs` assign no-op under policy; `usage.rs` opt-in locked
      off. TS twin: `license.ts`/`usage.ts` same.
- [ ] 2.3 Chat history: locate the history store write path (server +
      commands), refuse writes under policy without deleting existing
      data; toggle state reads locked. TS twin same.
- [ ] 2.4 OCR: policy check beside the settings check in `extract.rs`/
      `ocr.rs` (empty + uncached).
- [ ] 2.5 vaultRoots: shell choose-vault + `write_settings` vaultDir path
      revert-on-violation; engine link/addReference ops reject
      out-of-root paths server-side.
- [ ] 2.6 Shell: `widgetHotkeys` — skip whisper hook install + summon
      registration entirely; `notifications` — central helper checks
      policy (created now, used by briefings later).

## 3. Surface + UI

- [ ] 3.1 `{op:"policy"}` in `lighthouse-server` routes + `rag_op`
      command returning presence/error/keys/locks.
- [ ] 3.2 UI lock state ("Managed by your organization"): AI-models
      dialog (provider rows), Preferences (usage sharing, OCR, history,
      summon recorder), vault chooser error message. Managed-config-error
      banner for the malformed case.

## 4. Docs + verification

- [ ] 4.1 `docs/managed-deployment.md`: example policy.json, per-OS
      distribution (GPO/Intune/Jamf/MDM snippets), the threat model
      paragraph, key reference table.
- [ ] 4.2 `docs/data-flows.md`: note `telemetry:"off"` now exists and what
      it silences (update the "no runtime toggle" honesty note).
- [ ] 4.3 E2E (the phase gate): with a temp policy file —
      `forceLocalOnly` blocks a keyed cloud provider at the engine while
      profile.json says otherwise (server test), telemetry ops no-op
      (assert zero calls via the license hub), vaultRoots rejects an
      out-of-root link op. `openspec validate --all` green.
