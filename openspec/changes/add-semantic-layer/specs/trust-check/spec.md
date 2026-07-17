# trust-check — delta

## ADDED Requirements

### Requirement: The trust check reconciles by re-running the blessed definition through the guard
The trust check SHALL verify a computed answer against the semantic layer in two
deterministic steps: first confirm the executed SQL used a blessed metric
definition (the certified check), then RE-RUN that blessed definition through the
same guarded executor (`run_query` — the same guard, timeout, and result caps as
the original) and compare the re-run number(s) to the answer's. It SHALL consult
NO model at any step — the reconciliation is engine arithmetic, not an LLM
opinion.

#### Scenario: A matching answer reconciles
- **WHEN** a certified `revenue` answer is trust-checked and the blessed definition re-run over the same data yields the same number
- **THEN** the verdict reports `certified: true` and `reconciled: true`, having re-executed the definition through the guard and compared the results — with no model call

#### Scenario: The reconciliation degrades honestly on error
- **WHEN** re-running the blessed definition errors or times out during a trust check
- **THEN** the verdict records `reconciled: false` with the reason and never reports a fabricated pass, and the original answer is unaffected

### Requirement: The trust check catches a mismatch
When the answer's number does not reconcile with the re-run blessed definition,
the trust check SHALL report the mismatch (verdict fails) rather than pass it —
catching a mismatch is the capability's purpose. A non-metric ad-hoc answer SHALL
report "not certified" honestly rather than a failure.

#### Scenario: A number that does not reconcile fails the verdict
- **WHEN** an answer claims a `revenue` figure that differs from re-running the blessed `revenue` definition over the same data
- **THEN** the verdict reports `reconciled: false` with the expected and got figures, surfacing the mismatch instead of silently accepting the answer

#### Scenario: An ad-hoc answer is honestly uncertified, not failed
- **WHEN** an answer uses no blessed definition and is trust-checked
- **THEN** the verdict reports `certified: false` with no reconciliation — an honest "not certified", not a failure

### Requirement: The trust verdict is deterministic and surfaced on the answer
The trust verdict SHALL be a pure function of the executed SQL, the result, and
the semantic definitions — the same inputs yield a byte-identical verdict — and
SHALL ride the analytics answer's structured meta so the client can render it,
persisting with the cached answer like the certified mark.

#### Scenario: The same answer yields the same verdict twice
- **WHEN** the trust check runs twice over the same SQL, result, and definitions
- **THEN** the two verdicts are byte-identical, because the check reads only engine facts and the store, never model text

#### Scenario: The verdict rides the analytics card and replays
- **WHEN** a trust-checked answer is pinned, boarded, or served from cache
- **THEN** its trust verdict travels on the analytics meta and replays unchanged, with no recomputation on the replay
