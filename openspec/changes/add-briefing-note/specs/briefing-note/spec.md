# briefing-note — delta

## ADDED Requirements

### Requirement: The briefing note is composed deterministically from verified pin changes
The engine SHALL compose the briefing note by deterministic string formatting over the pins that changed since the last note, with NO model call. For each changed pin it SHALL render the question and a two-row "Before → Now" table whose values are that pin's VERIFIED prior and current summaries; a pin with no prior summary SHALL render an em dash for "Before". The note SHALL end with a footer that stamps the composition time in UTC and states explicitly that every value is computed directly from the user's files with no AI. An empty change set SHALL still produce a coherent note that says nothing changed. The composer SHALL be byte-identical between the Rust engine and the TypeScript twin for the same inputs.

#### Scenario: Two changed pins render before/after tables and a footer
- **WHEN** the note is composed from a pin that moved from "NE 120 · SE 300" to "NE 150 · SE 480" and a pin with no prior summary now reading "42"
- **THEN** the note renders each question with a Before/Now table, shows "—" for the pin with no prior value, and ends with a UTC-stamped footer containing the "no AI" line

#### Scenario: An empty change set is still a coherent note
- **WHEN** the note is composed with no changed pins
- **THEN** the note is a well-formed document that states no pinned questions changed since the last check, and still carries the "no AI" footer

#### Scenario: The two engines agree byte-for-byte
- **WHEN** the Rust composer and the TypeScript twin are given the same changed pins and the same composition timestamp
- **THEN** they produce the exact same note bytes, because the footer stamp is UTC and the formatting is fixed

### Requirement: The note performs no arithmetic and states no model text
Every value in the note SHALL be a pin's own verified before/after summary carried through verbatim (only escaped for table safety). The engine SHALL NOT compute a delta, percentage, total, or any other derived number for the note, and SHALL NOT summarize or rephrase the values with a model. The note therefore states no number the pin's guarded query did not already produce.

#### Scenario: Values pass through unchanged
- **WHEN** a pin's verified summary is carried into the note
- **THEN** the note shows that summary as-is, with no computed change figure and no model-generated prose added

### Requirement: The scheduled note refreshes at most once per user-set daily hour
The desktop shell SHALL refresh the note automatically only when a pure due-gate allows it: the LOCAL hour is at or after the user's configured hour AND the note has not already been written today (never written, or last written on an earlier local day). The gate SHALL be a pure function of the last-written timestamp, the current time, and the hour, so it is testable without a real clock. The last-written time SHALL be persisted engine-side so the once-per-day guarantee survives restarts. When multiple recheck passes occur before a note is due, the accumulated change set SHALL keep each pin's earliest prior value and its latest current value, so the note reflects the true change since the last note.

#### Scenario: Before the configured hour, nothing is written
- **WHEN** the local time is 8am and the user's hour is 9
- **THEN** the note is not refreshed, even if it has never been written

#### Scenario: After the hour, once per day
- **WHEN** the local time is at or after 9am and the note has not been written today
- **THEN** the note refreshes once; a later refresh the same day is gated off until the next local day

#### Scenario: A pin that changes twice before a note reads oldest→newest
- **WHEN** a pin changes from A to B and then B to C across two recheck passes before the note is due
- **THEN** the note's Before shows A and its Now shows C, not B

### Requirement: The note notification is opt-in and never wakes a hidden app, but the note is always written
The scheduled refresh SHALL fire at most one OS notification when the note updates. The notification SHALL be suppressed when the user has turned the briefing notification off, and SHALL be suppressed while the application is hidden to the tray or idle-suspended, so the app never surfaces itself from the background. Suppressing the notification for any reason SHALL NOT suppress the note file: the file SHALL be written, and its last-written time stamped, regardless of the notification decision.

#### Scenario: Notification off still writes the note
- **WHEN** the briefing notification setting is off and the note comes due
- **THEN** the note file is refreshed and stamped, and no OS notification is shown

#### Scenario: Hidden app writes silently
- **WHEN** the note comes due while the app is suspended in the tray
- **THEN** the note is written but no notification is shown, so the app does not pull itself to the foreground

#### Scenario: Visible app with notifications on is nudged once
- **WHEN** the note comes due, notifications are on, and the app is not suspended
- **THEN** the note is written and exactly one OS notification announces the update

### Requirement: The pins dialog can refresh the note on demand without a notification
The app SHALL expose an on-demand action that rechecks pins to freshen their summaries and then composes the note from a SNAPSHOT of every pin that has a summary, overwriting the note in place immediately. Because it is a full snapshot, an on-demand refresh SHALL NOT overwrite a meaningful note with the empty-set message merely because nothing changed since the last check. This on-demand refresh SHALL NOT fire an OS notification, because the user requested it and sees the result inline, and SHALL NOT stamp the scheduled daily gate — the on-demand snapshot and the scheduled daily delta are independent.

#### Scenario: On-demand refresh writes a full snapshot and confirms inline
- **WHEN** the user triggers "Refresh briefing note" from the pins dialog
- **THEN** pins are rechecked, the note is composed from all pins that have a summary and overwritten in place, the result is confirmed in the dialog, and no OS notification is shown

#### Scenario: On-demand refresh on a quiet system does not blank the note
- **WHEN** the user triggers an on-demand refresh and no pin has changed since the last check
- **THEN** the note still shows every pin that has a summary, rather than being overwritten with the "nothing changed" message

### Requirement: The note is a single file overwritten in place inside the vault
The engine SHALL write the note to one deterministic vault path and overwrite it in place on each refresh, never accumulating collision-suffixed duplicates. The write SHALL reuse the same filename sanitization and the same vault-escape guard the artifact writer uses, so a crafted name can never place the file outside the vault. After writing, the walk cache SHALL be invalidated so the file explorer reflects the update.

#### Scenario: Refreshing overwrites rather than duplicating
- **WHEN** the note is refreshed twice
- **THEN** there is exactly one note file at the fixed path, carrying the latest content, with no "(1)"-suffixed copy

#### Scenario: The note cannot escape the vault
- **WHEN** the note path would resolve outside the vault root
- **THEN** the write is rejected by the escape guard and no file is written outside the vault

### Requirement: Two settings govern the note, round-tripped through the exhaustiveness tripwire
The app SHALL expose a briefing-notify toggle (default on) and a briefing-note-hour value (an integer hour 0–23, default 9). The hour SHALL be validated on write so an out-of-range value is dropped and the reader falls back to the default. Both settings SHALL be covered by the exhaustive settings round-trip so adding either without wiring every writer call site and wire key is a compile-time failure, not a field report.

#### Scenario: An out-of-range hour is rejected
- **WHEN** a client tries to persist a briefing-note hour of 42
- **THEN** the value is not stored and the effective hour remains the default

#### Scenario: Both settings survive a round trip
- **WHEN** the two settings are written and read back
- **THEN** their values persist, and the settings exhaustiveness test compels every writer call site and wire key to cover them
