# audit-log — delta

## ADDED Requirements

### Requirement: One tamper-evident record per answered question
When the audit log is enabled (by preference or the policy key
`auditLog: "on"`), the engine SHALL append exactly one JSONL record per
answered question to a local, append-only, 0600 file in the app-state dir,
written at the transport choke point that all answers pass through (widget,
main window, and headless server). Each record SHALL carry the question hash,
the files read, the provider used, the egress for that question, artifacts
written, and a per-record HMAC chained to the previous record. Writing the
log SHALL NOT block, delay, or alter the answer.

#### Scenario: A cloud-provider question is logged with its egress host
- **WHEN** the audit log is enabled and the user asks a question answered by a configured cloud provider
- **THEN** one record is appended with `provider` set to that provider, `egress` listing the provider host, `fileIds` for the cited files, and a valid HMAC linking to the prior record

#### Scenario: A local question logs no egress
- **WHEN** the audit log is enabled and the user asks a question answered by the local model or the extractive fallback
- **THEN** one record is appended with `egress: "none"` (or an empty host list)

#### Scenario: Off by default
- **WHEN** neither the preference nor the policy enables the audit log
- **THEN** no audit file is created and no records are written

### Requirement: Privacy-preserving by default
Records SHALL store the sha256 of the question, not its text, unless a
`auditVerbatim` preference or policy key is explicitly set. No record SHALL
contain document content, chunk text, or full request URLs.

#### Scenario: Hash, not text, by default
- **WHEN** the audit log is on and `auditVerbatim` is not set
- **THEN** the record contains `questionSha256` and no verbatim question text

### Requirement: Tampering with the log is detectable
The per-record HMAC SHALL chain each record to the previous one using a key
derived from the install's secrets store. A verifier SHALL report the log as
intact only when every record's HMAC recomputes correctly; deleting or
editing any record SHALL cause verification to fail from that record onward.

#### Scenario: A deleted middle record is caught
- **WHEN** a record is removed from the middle of an audit file and the verifier runs
- **THEN** verification fails, identifying the break

### Requirement: The log is viewable and exportable locally
The app SHALL provide a viewer (recent records + a tamper-check indication)
under the settings gear and a CSV export. The log SHALL never be transmitted
off the machine by the app.

#### Scenario: Export to CSV
- **WHEN** the user opens the audit viewer and exports
- **THEN** a CSV of the records is written locally (to the vault or a chosen path) and nothing is sent over the network

### Requirement: Policy can force the log on
When the managed policy sets `auditLog: "on"`, the audit log SHALL be enabled
regardless of the user preference, and the Preferences toggle SHALL render
locked on.

#### Scenario: Managed force-on
- **WHEN** policy sets `auditLog: "on"` and the user never enabled the preference
- **THEN** answered questions produce audit records and the toggle shows the managed-lock state
