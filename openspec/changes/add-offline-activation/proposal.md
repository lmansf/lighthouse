# add-offline-activation

## Why

Air-gapped and tightly managed deployments (the IT security director persona)
can't — or won't — let each machine phone a hosted license function. They need
to activate paid mode from a file their MDM already distributes, with no network
and no per-machine call, while the local-first invariants stay intact.

## What Changes

- The engine reads a **minisign-signed license file** (`license.lic`) deployed
  next to the machine policy, verifies it locally against a **pinned license
  public key**, and — when valid and unexpired — grants paid status as the top
  authority in `checkLicense`. Reuses the updater's minisign verifier (no new
  crypto).
- **Fail-closed and additive:** with no pinned key (the default), or an absent,
  malformed, expired, or unverifiable file, offline activation grants nothing and
  never locks — the app falls back to its normal hosted/trial/local flow.
- Provisioning (the signing keypair + baking the public key) is a maintainer
  step, documented in `docs/managed-deployment.md`, and must not open paid
  distribution before installers are signed.
- Deployment docs gain the file format, the machine paths, and silent/fleet
  install flags.

## Impact

- Affected specs: `offline-activation` (new capability).
- Affected code: `native/.../license.rs` (verify + integrate into
  `check_license`), `native/.../policy.rs` (`policy_dir` helper),
  `src/server/license.ts` (PARITY note — twin does not verify), plus
  `docs/managed-deployment.md`.
- No new network egress; no new dependency (reuses `minisign-verify`).
- Ships inert (public key unset) until the maintainer provisions it.
