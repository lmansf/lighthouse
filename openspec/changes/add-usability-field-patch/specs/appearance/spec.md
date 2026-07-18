# appearance — delta

## ADDED Requirements

### Requirement: Appearance is a set of whitelisted, engine-validated keys

The engine SHALL persist a whitelisted set of appearance settings in the app-state
dir — theme preset (`beam-light`|`beam-dark`|`auto`), an accent from a curated
enum, density (`comfortable`|`compact`), font scale (`s`|`m`|`l`), and a
background image reference with a scrim (0–100) — and SHALL validate every key and
value (enum membership, ranges) before persisting, exactly as the existing
settings writer validates `uiMode`/`briefingNoteHour`. There SHALL be no free-form
color and no arbitrary CSS or theme input.

#### Scenario: A valid appearance setting round-trips

- **WHEN** a valid theme preset, accent, density, and font scale are saved
- **THEN** they persist to the app-state settings and are restored on the next
  launch, and the settings round-trip test covers each new key

#### Scenario: An invalid appearance value is rejected

- **WHEN** an out-of-vocabulary accent or an out-of-range scrim is submitted
- **THEN** the engine rejects it (no persist) rather than storing an invalid value

### Requirement: Every curated accent passes WCAG-AA on both themes

Each accent in the curated set SHALL pass the repository's contrast script
(`scripts/check-contrast.mjs`) against BOTH the Paper (light) and Ink (dark)
themes, and the script SHALL gate CI. No accent that fails AA SHALL be offered.

#### Scenario: The contrast gate covers the accent set

- **WHEN** the contrast script runs in CI
- **THEN** it checks every curated accent's text/fill pairings on both themes and
  fails the build if any pairing is below its AA threshold

### Requirement: A background image sits behind the chrome only, never behind content

A user-uploaded background image SHALL be copied into the app-state dir (never
leaving the machine), downscaled to a bounded budget, and rendered ONLY behind the
canvas/chrome. Content surfaces — cards, chat, explorer rows, dialogs — SHALL stay
opaque token backgrounds so readability and AA hold regardless of the image. A
bounded scrim SHALL be adjustable and a one-click reset SHALL remove the image.

#### Scenario: Content stays readable over any background

- **WHEN** a background image is active
- **THEN** the image shows behind the chrome, every content surface remains its
  opaque neutral token, and the contrast checks (including the background-image
  case) still pass

#### Scenario: The image never egresses

- **WHEN** a background image is chosen
- **THEN** it is copied into the app-state dir and downscaled locally, and no
  network egress occurs for it

### Requirement: Appearance can be adjusted by asking, via a validated settings directive

Appearance intents SHALL route through the established fenced-directive pattern: on
a recognized intent the model emits ONE fenced appearance directive that names
ONLY the whitelisted appearance keys; the engine parses and validates it (enum,
range, contrast) and, if valid, applies it with an inline "Applied — Undo" chip.
An invalid or out-of-vocabulary request SHALL produce a polite explanation and NO
change. No directive SHALL yield a normal answer. The directive SHALL be a
settings patch only — it SHALL NOT emit or execute any CSS, markup, or code, and
it SHALL work on every provider.

#### Scenario: "Make it compact" applies density with an Undo

- **WHEN** the user asks to make the UI compact (via a model that emits the
  appearance directive)
- **THEN** the density setting changes to compact, an "Applied — Undo" chip shows,
  and Undo reverts to the prior density

#### Scenario: An out-of-vocabulary request changes nothing

- **WHEN** the user asks for something outside the whitelist (e.g. "rotate the
  sidebar 90 degrees")
- **THEN** no appearance change is applied and the user gets a polite explanation
  pointing at what can be adjusted

#### Scenario: The directive can never carry code

- **WHEN** any appearance directive is parsed
- **THEN** only whitelisted keys with validated enum/range values are read; any
  other content (CSS, markup, script, URLs) is ignored, so no arbitrary code or
  style is ever applied
