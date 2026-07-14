# offline-activation — delta

## ADDED Requirements

### Requirement: Locally-verified signed license grants paid without network
When licensing is enabled and a machine-scope license file is present, the
engine SHALL verify it against a pinned license public key using the same
minisign Ed25519 verifier as the updater, and — when the signature is valid and
the license is unexpired — SHALL grant paid status without contacting any
network service. This offline license SHALL be the top authority in the
per-launch license check.

#### Scenario: A validly signed, unexpired license grants paid
- **WHEN** the pinned license public key is configured and a `license.lic` whose signature verifies and whose `paidThrough` is in the future is present
- **THEN** the license check returns status `valid` with license type `paid`, and no license network call is made

#### Scenario: The signed payload is verified verbatim
- **WHEN** a license file's `payload` bytes do not match its `signature`
- **THEN** verification fails and the file grants nothing

### Requirement: Offline activation is fail-closed and never locks
The engine SHALL grant an offline license ONLY when a pinned public key is
configured AND the file verifies AND the license is live. In every other case —
no pinned key, no file, malformed JSON, a bad or foreign signature, or an
expired license — it SHALL grant nothing and SHALL fall through to the normal
hosted/trial/local flow rather than locking the user.

#### Scenario: No pinned key disables the feature
- **WHEN** `LICENSE_OFFLINE_PUBKEY` is unset or empty
- **THEN** any license file present is ignored and the normal license flow applies

#### Scenario: A license signed by a different key is rejected
- **WHEN** a `license.lic` is signed by a key other than the pinned one
- **THEN** verification fails and the file grants nothing

#### Scenario: An expired offline license does not lock
- **WHEN** a validly signed license whose `paidThrough` and grace have passed is present
- **THEN** offline activation grants nothing and the engine falls through to the normal flow (the user is not locked out by the file)

### Requirement: Provisioning is gated and documented
The pinned license key SHALL be provisioned by the maintainer at build time and
kept separate from the updater key. Deployment documentation SHALL specify the
license file format, its machine-scope paths, and the requirement that offline
activation not be provisioned before release installers are signed.

#### Scenario: Ships inert by default
- **WHEN** the build has no `LICENSE_OFFLINE_PUBKEY` provisioned
- **THEN** offline activation is disabled and cannot open a paid path
