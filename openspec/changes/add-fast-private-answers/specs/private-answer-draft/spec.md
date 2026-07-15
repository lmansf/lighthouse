# private-answer-draft — delta

## ADDED Requirements

### Requirement: An instant extractive draft precedes the private model's answer
On the local-model answer path, when retrieval returns at least one context and the `draftAnswers` preference is on (its default), the engine SHALL emit one provisional draft chunk — an extractive rendering of the top retrieval passages — immediately, before the model composes its grounded answer. The draft chunk SHALL be marked as a draft on the wire so the client can present it distinctly and replace it. First visible content on the private path SHALL therefore arrive in well under two seconds, without any additional retrieval or model call.

#### Scenario: The draft appears before the model writes
- **WHEN** a user asks a question on the local (private) model path and retrieval returns passages
- **THEN** an extractive draft of the top passages is shown, marked as a draft, before the model's first grounded token

#### Scenario: The draft costs no model call and no prompt tokens
- **WHEN** the draft is produced
- **THEN** it is rendered from retrieval snippets already in memory, invokes no model, and its text enters no prompt (zero tokens against the local context window)

### Requirement: The verified answer replaces the draft in place
When the first authoritative (non-draft) answer token arrives, the client SHALL discard the provisional draft and render the verified answer in its place, so the final transcript contains only the grounded answer — never the draft concatenated ahead of it. The draft SHALL never block, delay, or alter the verified answer.

#### Scenario: First grounded token wipes the draft
- **WHEN** the local model's first non-draft delta arrives after a draft was shown
- **THEN** the draft text is cleared and the verified answer streams in its place

#### Scenario: A model failure still replaces the draft
- **WHEN** the local model errors and the engine falls back to an extractive or failure-note answer (a non-draft delta)
- **THEN** that answer replaces the draft exactly as a grounded answer would; the draft never persists alongside it

### Requirement: The draft is gated to the private path and is user-toggleable
The engine SHALL emit a draft ONLY for the local provider, ONLY when retrieval returned contexts, and ONLY when the `draftAnswers` preference is on (default on). Deterministic instant answers (vault meta-answers) and engine-verified analytics answers SHALL NOT be preceded by a draft, because they are produced and returned before the draft emission point. Turning `draftAnswers` off SHALL suppress the draft entirely and stream the verified answer exactly as before.

#### Scenario: A remote provider gets no draft
- **WHEN** the answer path uses a keyed remote provider, not the local model
- **THEN** no draft is emitted

#### Scenario: A meta or analytics answer gets no draft
- **WHEN** the question is answered by the vault meta path or the analytics engine
- **THEN** that answer returns with no draft ahead of it

#### Scenario: The preference off suppresses the draft
- **WHEN** `draftAnswers` is off and a local-model question is asked
- **THEN** no draft is emitted and the verified answer streams as it did before this capability

### Requirement: The draft rendering is identical across both engines
The extractive draft SHALL render the top passages in a form byte-identical between the Rust engine and the TypeScript twin (the same top-3 passages, the same `[n] **file** — snippet…` shape, the same snippet clamp and trim), because the draft text is user-visible.

#### Scenario: Both engines render the same draft
- **WHEN** the same retrieval contexts are drafted by each engine
- **THEN** the rendered draft text is identical
