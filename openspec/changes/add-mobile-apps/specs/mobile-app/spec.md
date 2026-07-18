# mobile-app — delta

## ADDED Requirements

### Requirement: The mobile shell is a fifth consumer of the Rust engine
The iOS and Android apps SHALL link `lighthouse-core` in-process through the
shared `lighthouse-desktop` library crate and route every ask through
`ask::run_headless_ask`, inheriting the audit log, egress ledger, sealed
secrets, and managed-policy enforcement. Mobile SHALL NOT introduce a third
engine implementation, and the TS twin SHALL remain dev-only. Desktop-only
shell surfaces (tray, widget windows, whisper hooks, global shortcuts,
autostart, single-instance, window-state, the self-updater, llama-server
supervision) SHALL be compiled out of mobile builds behind `cfg(desktop)`.

#### Scenario: Mobile ask is audited like every other shell
- **WHEN** a question is answered on a phone
- **THEN** the audit chain records it with the same fields as a desktop ask, and the egress ledger attributes any provider call

#### Scenario: Desktop binary is unchanged by the crate split
- **WHEN** the split lib+bin desktop build runs the 3-OS release smoke
- **THEN** it boots, answers the zero-network ask, and exits green with no behavior change

### Requirement: Mobile v1 vault is copy-in, visible, and never silently backed up
Mobile ingestion SHALL copy documents into an app-container vault via the
share sheet, the document picker, and in-app upload using the existing
`vault::add_file` path; link-in-place references SHALL NOT be offered on
mobile v1. The vault SHALL be exposed to the iOS Files app for user-visible
transfer. The vault, `.rag-vault` state, app-state dir, and the sealing
`secret.key` SHALL be excluded from iCloud and Android system backups.

#### Scenario: Share-sheet ingestion lands in the vault
- **WHEN** a user shares a PDF from another app into Lighthouse
- **THEN** it is copied into the vault, extracted, and answerable with citations — with no reference to the source path retained

#### Scenario: OS backup never carries vault contents or the sealing key
- **WHEN** an iCloud or Android backup runs
- **THEN** the backup contains no vault documents, no derived state, and no `secret.key`

### Requirement: The answer ladder on mobile v1 is cloud then extractive, honestly labeled
Mobile v1 SHALL answer via configured cloud providers, degrading to the
zero-network extractive fallback exactly as the engine does today; the local
model rung SHALL report unavailable rather than being hidden. Retrieval SHALL
be lexical (the engine's designed embeddings-absent mode). A device with no
provider key SHALL still answer extractively with citations and zero network
calls.

#### Scenario: No key, airplane mode, still grounded
- **WHEN** a user with no provider key asks a question in airplane mode
- **THEN** an extractive, cited answer streams with the "Connect an AI model" footer and zero outbound requests

#### Scenario: Provider failure degrades, never breaks
- **WHEN** the configured provider errors mid-ask on mobile
- **THEN** the answer falls through to the extractive fallback with the standard honest note

### Requirement: Freshness on mobile is reconcile-on-foreground, correctness unchanged
Mobile SHALL run watcher-less: per-query mtime+size revalidation plus a
reconcile pass on foreground activation. The UI SHALL label freshness by last
reconcile rather than implying live watching. Briefings and pinned-question
rechecks SHALL evaluate on foreground activation only in v1, with no
background-execution promises.

#### Scenario: Edited-in-place file is fresh at next ask
- **WHEN** a vault file changes (e.g. via the Files app) while Lighthouse is backgrounded, and the user returns and asks about it
- **THEN** the answer reflects the changed content without any manual refresh

### Requirement: First-run model assets are consent-gated, pinned, and declinable
Mobile SHALL NOT bundle the OCR models; it SHALL offer them as an explicit
consent-gated first-run download verified against pinned SHA-256 digests and
recorded in the egress ledger. Declining SHALL leave the app fully functional
with extraction degraded to name-findable for image/scanned content, and the
download SHALL be re-offerable from settings. No outbound request SHALL occur
before consent besides those the user initiates.

#### Scenario: Decline keeps the promise and the app
- **WHEN** a user declines the OCR download and asks about a text document
- **THEN** the ask works normally and no model-asset request was made

### Requirement: A pocket vault defends itself on the device
Mobile SHALL offer an opt-in biometric/passcode app-lock at onboarding,
redact the app-switcher snapshot on iOS, and set `FLAG_SECURE` on Android
for vault and chat views. Provider keys SHALL remain sealed AES-GCM with the
sealing secret in the app sandbox (OS keychain where validated). Chat
history SHALL persist in engine-side storage under the existing
persist-consent semantics rather than webview localStorage.

#### Scenario: App-lock gates a warm relaunch
- **WHEN** app-lock is enabled and Lighthouse returns from background
- **THEN** vault and chat content are not visible until biometric/passcode succeeds

### Requirement: One React tree serves phone, tablet, and desktop shells
The mobile UI SHALL reuse the existing component tree behind the transport
chokepoint, with a phone navigation shell (drawer/stack), an iPad two-pane
layout, touch-primary equivalents for every right-click/hover/drag-only
affordance (per-row overflow menus, the Attach popover, the Move-to menu),
44 pt minimum targets, safe-area/keyboard-viewport handling, Android
back-button stack behavior, and VoiceOver/TalkBack + Dynamic Type support.
Desktop-only settings and surfaces SHALL be hidden by the existing runtime
capability gating.

#### Scenario: Every explorer action is reachable by touch
- **WHEN** a user long-inspects a file row on a phone
- **THEN** rename, move, rules, and removal are reachable via the row's overflow menu without hover or right-click

#### Scenario: iPad keeps the two-pane shape
- **WHEN** the app runs full-screen on an iPad
- **THEN** explorer and chat render side-by-side as on desktop, and Split View narrows gracefully to the phone shell
