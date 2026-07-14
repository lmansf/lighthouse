# Managed policy: an org-deployable control layer (IT security director, S1)

## Why

Lighthouse's controls are all per-user toggles. For a single analyst that is
right; for the IT security director evaluating a pilot it is disqualifying —
six cloud providers (DeepSeek among them, a hard policy flag in many orgs)
with nothing to pin the provider set, telemetry that can't be organizationally
silenced, a global keyboard hook (Whisper summon) an admin can't forbid, and
no way to restrict which paths a vault may live on. The roadmap's adversarial
analysis (§2.6) calls this the inverted trust story: provider choice shipped
without its admin counterpart. Every subsequent security-persona feature
(audit log, egress panel, offline activation) wants the same substrate: a
machine-scope, admin-owned policy the engine — not just the UI — enforces.

## What Changes

- **A machine-scope `policy.json`** read from a fixed per-OS path
  (`/etc/lighthouse/`, `%ProgramData%\Lighthouse\`,
  `/Library/Application Support/Lighthouse/`), loaded once per process in
  `lighthouse-core::config`-adjacent module `policy.rs`. Absent file = no
  restrictions (today's behavior). Malformed file = **fail closed** to
  local-only + telemetry/history off, surfaced in the UI.
- **V1 keys** (all optional): `allowedProviders` (subset of the seven),
  `forceLocalOnly`, `telemetry: "off"`, `chatHistory: "off"`,
  `widgetHotkeys: "off"` (the summon keyboard hook is then never installed),
  `ocr: "off"`, `notifications: "off"`, `auditLog: "on"`, `vaultRoots`
  (path-prefix allowlist for the vault location and linked folders).
- **Engine-side enforcement, not UI hiding**: provider selection AND the
  model-call chokepoint reject disallowed providers; telemetry ops no-op;
  history writes refuse; OCR extraction returns empty-uncached; vault
  re-point and link-in-place reject out-of-root paths after
  canonicalization. The UI additionally renders each managed control
  disabled with "Managed by your organization".
- **A `policy` op** on the RAG surface (routes + commands) so the UI (and
  the audit log later) can read the effective policy.
- **`docs/managed-deployment.md`**: the example policy, per-OS distribution
  notes (GPO/Intune/Jamf/MDM), and the stated threat model.
- **TS twin**: parses the same file and enforces providers/telemetry/history
  (PARITY: hotkeys/OCR/notifications/vaultRoots are desktop-shell concerns).

## Capabilities

### New Capabilities
- `managed-policy`: machine-scope, admin-owned restrictions the engine
  enforces server-side, with a locked-control UI state.

### Modified Capabilities
<!-- none — existing behaviors are unchanged when no policy file exists -->

## Impact

- New `native/crates/lighthouse-core/src/policy.rs` (+ `policy.ts` twin);
  enforcement touches `profile.rs`/`llm.rs` (providers), `license.rs` +
  `usage.rs` (telemetry), the history store (chatHistory), `extract.rs`/
  `ocr.rs` (ocr), `vault.rs` + shell vault ops (vaultRoots), shell `main.rs`
  (widgetHotkeys, notifications), routes/commands (`policy` op).
- UI: Preferences, AI-models dialog, history toggle, summon recorder gain
  the lock state.
- Consumed by later changes: `add-audit-log` (auditLog: "on"),
  the egress panel (renders policy state), `add-briefings`
  (notifications: "off").

## Non-goals

- **No remote policy fetch** — the file arrives via the org's own
  MDM/GPO/config management; Lighthouse never phones anywhere for policy.
- **No signed policies in v1** — machine-scope file ACLs are the integrity
  boundary (admin-writable only); signing is noted as a follow-on in the
  design.
- **No per-user exceptions or grouping** — one file, machine scope, applies
  to every user of the install.
- **No anti-tamper against local administrators** — the threat model is
  configuration management, not DRM (stated plainly in the docs).
