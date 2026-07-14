# Design — add-offline-activation

## Non-goals (pinned)

- **Not** a general licensing rework: hosted and local-dev modes are unchanged.
- **Not** seat/team management or a paid-enablement change (those remain
  maintainer decisions — see the phase report).
- **Not** a UI flow. Managed/air-gapped deployment means the file is delivered
  by MDM/GPO and auto-loaded, not clicked through in-app.
- **Not** anti-tamper against a local administrator (same posture as the policy
  layer — the OS ACL on the machine path is the boundary).

## Decisions

### D1 — Reuse the updater's minisign verifier, no new crypto
`updates::verify_update_signature(data, sig, pubkey)` already verifies a
minisign Ed25519 signature over arbitrary bytes against a pinned key. Offline
activation calls it directly. One signing story for the maintainer (docs/
signing.md), one audited verification path, zero new dependencies.

### D2 — Sign-then-verify the verbatim payload (no canonicalization gap)
The license file is `{ payload: string, signature: string }`. `payload` is the
exact claims JSON text that was signed; verification checks the signature over
`payload.as_bytes()` and only then parses claims out of it. This sidesteps any
JSON key-ordering / whitespace canonicalization mismatch between signer and
verifier — the bytes signed are the bytes checked.

### D3 — Fail-closed and strictly additive
`offline_license_status()` returns `Some(valid|grace)` ONLY when a pinned key is
configured, the file exists, the signature verifies, and the license is live.
Every other case (no key, no file, malformed, bad signature, wrong key, expired)
returns `None`. `check_license` consults it first; `None` means "fall through to
the normal hosted/trial/local flow." So a bad or expired offline file can never
lock a user out — it just doesn't grant.

### D4 — TS twin does not verify (PARITY)
The dev twin has no minisign runtime and does not ship. It documents the
decision point with a PARITY comment and takes no offline authority — the same
pattern as the audit-log HMAC chain (twin omits) and OCR (Rust-only).

### D5 — Ships inert; provisioning is a gated maintainer step
The pinned key is `LICENSE_OFFLINE_PUBKEY`, empty by default ⇒ the feature
rejects every file. Turning it on requires the maintainer to generate a
dedicated license keypair, bake the public key into the build, and sign
licenses. Because offline activation grants paid, the maintainer MUST NOT
provision it before installers are signed (the standing "paid must not open on
unsigned installers" rule). Kept separate from the updater key so licensing and
updates rotate independently.
