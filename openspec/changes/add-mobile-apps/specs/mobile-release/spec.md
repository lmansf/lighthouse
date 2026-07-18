# mobile-release — delta

## ADDED Requirements

### Requirement: Mobile builds are gated by a ported zero-network smoke
Every store submission SHALL be preceded by a green mobile smoke: the app
boots on iOS simulator and Android emulator with a seeded fixture vault, all
keys unset and network denied, drives the existing webview smoke driver over
the invoke transport, and produces a grounded, cited answer. Mobile smoke
SHALL gate mobile store lanes only and SHALL NOT block desktop publishing.
A per-PR `cargo check --target aarch64-linux-android -p lighthouse-core`
tripwire SHALL guard shared-engine changes against mobile-only breakage.

#### Scenario: Engine change that breaks the mobile target fails in PR
- **WHEN** a PR changes a shared engine signature in a way that only fails on the Android target
- **THEN** the per-PR tripwire goes red before merge rather than at release time

### Requirement: Mobile distribution is store-native and signing is all-or-nothing
Mobile updates SHALL flow exclusively through App Store and Play release
tracks; the minisign self-updater and the update-check poll SHALL NOT exist
in mobile builds. CI signing SHALL follow the existing secrets-gated pattern:
fully signed uploads when secrets are present, loud clean skips when absent —
never a half-signed artifact. Android SHALL publish AABs under Play App
Signing; iOS SHALL sign with a Distribution certificate and upload via an
App Store Connect API key.

#### Scenario: Missing store secrets skip loudly
- **WHEN** the mobile build workflow runs without the Android keystore secret
- **THEN** the Android lane reports itself skipped-for-missing-secrets and no unsigned artifact is uploaded anywhere

### Requirement: Versions stay on one train across five platforms
Mobile SHALL derive its user-facing version from the existing five-stamp
lockstep (single workspace version), with Android versionCode and iOS build
numbers derived monotonically from it. The mobile launch SHALL ship as
0.13.0 under the owner-approved overhaul rule, with subsequent releases
returning to patch bumps on the 0.13.x line across all five platforms
simultaneously.

#### Scenario: One bump moves every platform
- **WHEN** the workspace version bumps to 0.13.1
- **THEN** desktop installers, the iOS build, and the Android build all carry 0.13.1 with strictly increased store build numbers and no hand-edited stamps

### Requirement: Store compliance artifacts are part of the release, not an afterthought
Mobile releases SHALL carry a privacy manifest (`PrivacyInfo.xcprivacy`)
declaring required-reason API usage including file-timestamp access, accurate
privacy labels / Data safety declarations reflecting zero ambient egress,
`ITSAppUsesNonExemptEncryption=true` with the annual BIS self-classification
calendared, runtime notification permission requested in context, and
dependency audit + SBOM coverage extended to the mobile (Gradle) dependency
tree. Field diagnostics SHALL be a user-initiated, consent-gated export —
no crash reporting, no telemetry.

#### Scenario: Privacy label matches the code
- **WHEN** a reviewer compares the store privacy declaration against the app's observable network behavior
- **THEN** the only outbound requests are the user's configured provider calls and consent-gated pinned downloads, exactly as declared
