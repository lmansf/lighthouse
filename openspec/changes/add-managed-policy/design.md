# Design — add-managed-policy

## Decisions (with rationale)

### D1. Fixed per-OS machine paths; env override only in debug builds
- Linux `/etc/lighthouse/policy.json`; Windows
  `%ProgramData%\Lighthouse\policy.json` (resolved via `ProgramData` env,
  fallback `C:\ProgramData`); macOS
  `/Library/Application Support/Lighthouse/policy.json`.
- These are the canonical admin-owned, MDM/GPO-reachable locations on each
  OS, writable by root/Administrators only under default ACLs — that ACL IS
  the integrity boundary for v1.
- `LIGHTHOUSE_POLICY_FILE` overrides the path **in debug builds only**
  (tests need a seam; the engine's env-per-call convention makes this
  natural). Release builds ignore it: an env var a standard user can set
  must not be able to re-point policy discovery. Recorded limitation: a
  local **admin** can trivially remove the file — see Threat model.

### D2. Load once per process (`OnceLock`), not per call
Machine policy legitimately changes only via the org's config management;
applying it at next launch is the industry-standard contract (same as GPO-
backed apps). Per-call re-reads would buy nothing and cost a stat() on every
enforcement point. The `policy` op reports the loaded snapshot.

### D3. Malformed file fails CLOSED, absent file fails OPEN
- Absent: no restrictions — the file only exists where an admin created it.
- Present but unparseable (or `v` unknown): enforce
  `{forceLocalOnly, telemetry:"off", chatHistory:"off"}` and surface a
  "Managed configuration error — contact your administrator" state. A broken
  policy must not silently grant everything the admin meant to forbid; and
  because the path is admin-owned, an accidental malformed file cannot hit
  unmanaged machines.
- Unknown keys in a valid file are ignored (forward compatibility) and
  logged once.

### D4. Enforcement at the engine chokepoints, UI is cosmetic
Every key has a server-side reject in the code path that DOES the thing —
not only in the component that shows the toggle:

| Key | Chokepoint(s) |
|---|---|
| `allowedProviders` / `forceLocalOnly` | `profile.rs` select_model (refuse persisting a disallowed provider) AND `llm.rs` stream_answer (refuse the call itself — belt and braces; a stale profile from before the policy landed must still be blocked). `forceLocalOnly` ≡ `allowedProviders: ["local"]`; if both present the intersection applies. The extractive fallback answers instead — the ask never silently dies. |
| `telemetry: "off"` | `license.rs`: `ping`, `event`, `events`, `assign` become no-ops; `usage.rs` records nothing and the opt-in reads as locked-off. The license `check`/`start`/`activate` ops remain (licensing integrity, documented in data-flows.md) — offline activation (S5) is the air-gap answer. User-initiated form submissions (feedback/bug) remain: explicit user actions, not telemetry. |
| `chatHistory: "off"` | the history store's write path refuses (nothing persisted), existing saved chats stay readable (deleting user data on policy arrival would be destructive — the lock-not-wipe posture), toggle locked off. **Implementation reality (discovered during wiring):** chat history has NO engine-side write path — it is a client-side localStorage store shared by both UIs (`useChatStore`), so the store IS the chokepoint; it enforces from the `{op:"policy"}` snapshot's `locks.chatHistoryOff` (both engines' policy modules gate `historyAllowed()` for any future server-side history surface). |
| `widgetHotkeys: "off"` | shell `main.rs`: the Whisper hook install and the summon-shortcut registration are never attempted (not installed-then-disabled); the recorder UI locks. |
| `ocr: "off"` | same semantics as the user toggle off (empty, uncached) via a policy check beside the settings check; Preferences toggle locked. |
| `notifications: "off"` | the shell's (future) notification helper checks policy before emitting; defined now so `add-briefings` inherits it. |
| `auditLog: "on"` | defined here; consumed by `add-audit-log` (forces the writer on and locks the preference). |
| `vaultRoots` | `vault_dir` application in the shell (choose-vault rejects + reverts), and the engine's link/addReference ops reject out-of-root paths. Paths are canonicalized (symlinks resolved) before the prefix check; a prefix matches only at a path-component boundary (`/srv/vaults` does not admit `/srv/vaults-evil`). |

### D5. One `policy` read op, no write surface
`{op:"policy"}` on the RAG route / `rag_op` command returns
`{present, error, keys…, locks:{…}}`. There is deliberately no write/reload
op — the app treats policy as read-only input.

### D6. TS twin scope (PARITY)
`src/server/policy.ts` parses the same schema and enforces
providers/telemetry/history in the dev twin's chokepoints. Hotkeys, OCR,
notifications, and vaultRoots are desktop-shell concerns — PARITY comments
on both sides. The twin honors `LIGHTHOUSE_POLICY_FILE` unconditionally
(it is a dev tool by definition).

## Threat model (stated for the reviewer)
Protects against: unmanaged drift (users pointing the app at forbidden
providers/paths), accidental data egress, and "shadow enablement" of
features the org forbids. Does NOT protect against: a local administrator
(who owns the file), a user with root, or binary patching. This is the same
posture as MDM configuration profiles, and `docs/managed-deployment.md`
says so explicitly.

## Follow-ons noted (not in v1)
Signed policy files (Ed25519, reusing the offline-activation verifier);
remote policy URLs; per-key "default but user-changeable" (vs v1's
hard-lock-only semantics).
