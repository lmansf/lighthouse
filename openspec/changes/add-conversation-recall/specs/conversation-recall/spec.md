# conversation-recall — delta

## ADDED Requirements

### Requirement: Relevant prior exchanges are surfaced as the user types
As the analyst composes a question, the app SHALL rank the user↔assistant exchanges in their OTHER stored conversations by relevance to the draft and surface the strongest matches as a compact, tappable list. Tapping a match SHALL open that conversation. Ranking SHALL be deterministic and on device.

#### Scenario: Reopening last week's answer
- **WHEN** the analyst starts typing "Q3 churn by region" and a past conversation asked "regional churn for Q3"
- **THEN** that past exchange appears under "From earlier chats" and tapping it opens that conversation

#### Scenario: Nothing relevant, nothing shown
- **WHEN** the draft has no meaningful overlap with any past conversation (or the draft is trivially short)
- **THEN** no recall affordance is shown

### Requirement: Recall is passive — it never changes the ask
Recall SHALL only surface prior exchanges for the user to open; it SHALL NOT inject past turns into the current prompt, call the model, or otherwise alter the question being asked. No recall action SHALL cause any network egress.

#### Scenario: Suggestion, not context
- **WHEN** recall matches are shown and the user submits the current question without tapping one
- **THEN** the question is asked exactly as typed, with no recalled text added

### Requirement: Recall is bounded and de-duplicated
Recall SHALL return at most one (the best) exchange per past conversation and a small overall cap, so the affordance stays a glance, not a search results page. The current conversation SHALL be excluded from its own recall.

#### Scenario: One hit per conversation
- **WHEN** a single past conversation contains several loosely matching turns
- **THEN** at most its single best exchange is offered, and the current conversation never appears

### Requirement: Recall is gated by the history opt-in and fails closed
Recall SHALL read only conversations that history persistence already stores. When persistence is off (or a managed policy forbids persisting conversations), there SHALL be no stored conversations to rank and recall SHALL be empty. Recall SHALL never resurface content the user chose not to keep.

#### Scenario: History off means no recall
- **WHEN** "save chats on this device" is disabled
- **THEN** no recall is offered for any draft, because nothing is stored

#### Scenario: Managed lock
- **WHEN** a managed policy forbids persisting conversations
- **THEN** recall is inert, following the same store the lock already gates
