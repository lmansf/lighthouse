# managed-policy — delta

## ADDED Requirements

### Requirement: Machine-scope policy discovery
The engine SHALL read an optional `policy.json` from the fixed machine-scope
path for the OS (`/etc/lighthouse/`, `%ProgramData%\Lighthouse\`,
`/Library/Application Support/Lighthouse/`), once per process. An absent
file SHALL impose no restrictions. A present-but-invalid file SHALL fail
closed (local-only providers, telemetry and chat history off) and surface a
managed-configuration-error state. Unknown keys SHALL be ignored. Release
builds SHALL NOT honor any environment override of the policy path.

#### Scenario: No policy file
- **WHEN** no machine-scope policy.json exists
- **THEN** every control behaves exactly as before this change

#### Scenario: Malformed policy fails closed
- **WHEN** policy.json exists but is not valid JSON
- **THEN** cloud providers are refused, telemetry ops no-op, history writes refuse, and the UI shows a managed-configuration error

### Requirement: Provider restriction is enforced by the engine
When `allowedProviders` (or `forceLocalOnly`) is set, the engine SHALL
refuse both persisting a disallowed provider selection and executing a chat
call against a disallowed provider — regardless of any previously stored
profile or key. The refused ask SHALL fall back to the local/extractive
path rather than failing silently.

#### Scenario: forceLocalOnly blocks a keyed cloud provider
- **WHEN** policy sets `forceLocalOnly: true` and profile.json (written before the policy landed) selects `openai` with a valid stored key
- **THEN** asking a question makes no request to any cloud host and the answer comes from the local/extractive path, with the UI showing the provider as managed-blocked

#### Scenario: Allowed subset still works
- **WHEN** policy sets `allowedProviders: ["local", "anthropic"]`
- **THEN** selecting Anthropic works unchanged and selecting DeepSeek is rejected server-side with the managed-lock state shown

### Requirement: Telemetry hard-off
When `telemetry` is `"off"`, the launch ping, funnel events, click-event
batches, and experiment assignment SHALL NOT be transmitted, and the usage
opt-in SHALL read as locked off. License `check`/`start`/`activate` and
explicit user submissions (feedback, bug report) remain functional.

#### Scenario: Launch makes no telemetry calls
- **WHEN** policy sets `telemetry: "off"` and the app launches on a hosted build
- **THEN** no `ping`/`event`/`events`/`assign` op reaches the license function (the license `check` may still occur)

### Requirement: Chat-history hard-off
When `chatHistory` is `"off"`, no conversation SHALL be persisted, the
history preference SHALL read as locked off, and previously saved history
SHALL NOT be deleted by policy arrival.

#### Scenario: History write refused
- **WHEN** policy sets `chatHistory: "off"` and a chat completes with the user's old preference set to save
- **THEN** nothing is written to the history store and the toggle renders locked

### Requirement: Summon-hook suppression
When `widgetHotkeys` is `"off"`, the app SHALL NOT install the Whisper
keyboard hook or register the summon shortcut (never installed, not
installed-then-disabled), and the shortcut recorder SHALL render locked.

#### Scenario: No hook under policy
- **WHEN** policy sets `widgetHotkeys: "off"` and the user's settings have whisperMode enabled from before
- **THEN** no OS keyboard hook is installed at boot and the summon chord does nothing

### Requirement: OCR force-off
When `ocr` is `"off"`, image/scan extraction SHALL return empty and
uncached (the existing toggle-off semantics), regardless of the user
preference, with the Preferences control locked.

#### Scenario: Managed OCR off
- **WHEN** policy sets `ocr: "off"` and the user preference says on
- **THEN** a screenshot contributes no chunks and is not cached as empty, and flipping policy later re-reads it

### Requirement: Notifications force-off
When `notifications` is `"off"`, the app SHALL emit no OS notifications.

#### Scenario: Managed quiet
- **WHEN** policy sets `notifications: "off"`
- **THEN** any feature that would fire an OS notification (e.g. briefings) skips it

### Requirement: Audit-log force-on
When `auditLog` is `"on"`, the local audit log SHALL be enabled regardless
of the user preference, and the preference SHALL render locked on.

#### Scenario: Policy turns the log on
- **WHEN** policy sets `auditLog: "on"` and the user never enabled the audit preference
- **THEN** answered questions produce audit records (behavior specified by add-audit-log)

### Requirement: Vault-root allowlist
When `vaultRoots` is set, re-pointing the vault and linking files/folders
in place SHALL be rejected server-side for any path outside the listed
prefixes, after canonicalization, matching only at path-component
boundaries.

#### Scenario: Out-of-root vault move rejected
- **WHEN** policy sets `vaultRoots: ["/srv/vaults"]` and the user picks `/home/user/Documents/Vault`
- **THEN** the vault change is refused with a managed-restriction message and the previous vault stays active

#### Scenario: Prefix boundary is respected
- **WHEN** policy sets `vaultRoots: ["/srv/vaults"]`
- **THEN** linking `/srv/vaults-evil/file.md` is rejected while `/srv/vaults/team/file.md` is accepted

### Requirement: Managed controls are visibly locked
Every control governed by an active policy key SHALL render disabled with a
"Managed by your organization" indication, and the effective policy SHALL be
readable via a `policy` op on the API/command surface.

#### Scenario: Locked provider picker
- **WHEN** policy sets `forceLocalOnly: true`
- **THEN** the AI-models dialog shows cloud providers disabled with the managed indication, and `{op:"policy"}` reports the lock
