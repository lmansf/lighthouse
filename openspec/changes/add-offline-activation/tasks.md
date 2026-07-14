# Tasks — add-offline-activation

## 1. Engine (license.rs)

- [x] 1.1 `OfflineLicenseFile { payload, signature }` + `OfflineClaims
      { paidThrough, graceUntil }`; `offline_pubkey()` (`LICENSE_OFFLINE_PUBKEY`,
      empty ⇒ None = fail closed); `offline_license_path()`
      (`LICENSE_OFFLINE_FILE` override, else `license.lic` beside the machine
      policy); `offline_license_status()` — verify via
      `updates::verify_update_signature`, parse claims, return `Some(valid|
      grace)` only for a live license, else `None`.
- [x] 1.2 `policy::policy_dir()` helper so the license sits beside `policy.json`.
- [x] 1.3 Integrate into `check_license` as the top authority, after the
      `disabled` gate and before the stored-license flow.
- [x] 1.4 Unit test: fresh keypair signs a payload → granted; no pinned key →
      None (fail closed); tampered payload → None; expired → None; wrong key →
      None.

## 2. Twin parity

- [x] 2.1 `src/server/license.ts`: PARITY comment at the same decision point —
      the dev twin does not verify the offline license (no minisign runtime;
      shipped-engine feature, like the audit HMAC and OCR).

## 3. Docs

- [x] 3.1 `docs/managed-deployment.md`: an Offline-activation section (how it
      works, `license.lic` format, machine paths, what the maintainer must
      provision, and the do-not-provision-before-signed rule) and a Silent /
      fleet installation section (NSIS `/S`, MSI `/qn`, macOS/Linux). Resolve the
      two dangling references.

## 4. Verification

- [x] 4.1 `cargo test -p lighthouse-core` (offline license test green); default
      build unchanged; `npm run test` green; `openspec validate --all` green.
