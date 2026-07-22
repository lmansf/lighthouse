# Lighthouse conventions — the house patterns

Read this before changing shared systems. Each pattern below earned its place
by biting a real release; each entry names its canonical in-repo example so
you can copy a working shape instead of reinventing one. Roadmap § numbers
refer to the owner's roadmap; where a § is not represented in-repo the nearest
shipped example is named instead.

## The pure verdict-fn pattern

Any decision a stream/loop/retry path takes gets extracted into a PURE
function — inputs in, verdict enum out, no I/O — so the policy is a table the
tests pin, not control flow scattered through async code. Canonical:
`warm_wait_verdict` (native/crates/lighthouse-core/src/synth.rs, twinned in
src/server/synth.ts), `overflow_retry_verdict`
(native/crates/lighthouse-core/src/budget.rs + src/server/budget.ts),
`nudgeVerdict` (src/features/feedback/nudgeVerdict.ts). If your new feature
has an "if this then retry/skip/fall back" moment, write the verdict fn first
and test it without the surrounding machinery.

## Meta-channel additions + the answer-cache replay checklist

Engine-verified structures ride the final chunk's `meta` (chart, table), never
answer text (§22.6/§32). Adding a meta field is a THREE-STOP tour or replay
breaks silently: (1) the engine emits it on the final chunk; (2)
src/server/answerCache.ts (and the Rust cache) persists AND replays it —
a cached answer must re-materialize the same renderer inputs as a live one;
(3) the renderer re-materializes it (the `remarkAnswerCard` synthetic-node
idiom in src/features/chat/ChatPanel.tsx). Canonical: the §32 §3 `meta.table`
plumbing (src/lib/answerTable.ts + test/answerTable.test.mjs). Checklist:
emit → cache → replay → render → a test at each stop.

## Capability flags: one flag, one meaning

Platform ("is iOS"), shell ("runs inside the desktop/Tauri shell"), and
availability ("the private model can answer right now") are DIFFERENT
questions; §24 was bitten by one flag answering several. Never overload —
compose. Canonical: src/shell/desktopBridge.ts (`isDesktopShell`,
`platformKind`) versus the engine-reported availability verdicts
(`private_model_availability_impl` in
native/crates/lighthouse-desktop/src/commands.rs), pinned by
test/localModelPlatform.test.mjs. A new gate names which of the three it
reads, and reads exactly one.

## The WKWebView web-API checklist

The iOS shell is WKWebView: several web APIs silently do nothing. Before
shipping a surface that uses one, check: file inputs need a visible
label/overlay (no bare `<input type=file>` affordance); NO bare
`window.open`/`_blank` — every external open routes through the ONE seam
src/lib/openExternal.ts (§33 §2; pinned by test/openExternal.test.mjs); no
JIT-dependent tricks; no child processes; loopback fetches only to the
engine's own served ports. Canonical: the §33 external-links arc
(src/lib/openExternal.ts, src/lib/feedbackLinks.ts).

## Fixed/bottom-anchored surfaces: the registry

Every fixed-position surface with a bottom anchor MUST consume
`--lh-tabbar-h` / `--lh-safe-bottom` so the compact tab bar and the home
indicator never cover it (§33's nudge shipped floating over the tab bar —
once). The registry today:

| Surface | File |
|---|---|
| Compact tab bar (mints the vars) | src/shell/CompactTabBar.tsx |
| Shell chrome | src/shell/AppShell.tsx |
| Feedback nudge | src/features/feedback/FeedbackNudge.tsx |
| Bug-report FAB | src/features/feedback/BugReport.tsx |
| Files-page action bar | src/features/explorer/FileTileGrid.tsx |
| Bottom sheets | src/shell/Sheet.tsx |
| Dialog surface | src/shell/controls/LhDialog.tsx |

Desktop-only fixed surfaces that never meet the tab bar (QuickOpen,
SummonHint, VersionBadge) live on the explicit allowlist in
test/fixedBottomRegistry.test.mjs — the structural pin that makes the §33
class un-repeatable: any NEW `position: "fixed"` in src/ with a bottom offset
must reference the vars or join the allowlist with a reason.

## Pins policy: three kinds, never substituted

- BYTE-PINS for contracts, labels, and prompts (test/promptParity.test.mjs,
  test/cloudSnapshot.test.mjs): the bytes ARE the contract.
- BEHAVIOR TESTS for behavior (test/collapseSections.test.mjs runs real
  markdown through the real pipeline).
- END-TO-END ASSEMBLY PINS for integration: a component pin can be green
  while the assembled whole is dead (§36's planner passed its unit tests and
  never ran in the real prompt). Canonical:
  `whole_framing_prompt_fits_the_4k_window_end_to_end` in
  native/crates/lighthouse-core/src/reports.rs — the ASSEMBLED call is
  measured, not its parts.

## The model-call budget rule

Every `stream_answer`/`stream_local` call site declares a call type
registered in the budget tables (`CallType` in
native/crates/lighthouse-core/src/budget.rs + src/server/budget.ts), so its
output reserve and input budget are decided in ONE place. A new model call
without a registered type fails test/budgetCallRegistry.test.mjs — add the
call type (both twins) and its reserve first, then the call site. Canonical:
`CallType::ReportFraming` and its §38 packing in reports.rs.

## Token semantics: changing a VALUE is a consumer audit

Design tokens are load-bearing: §35 found answer prose silently riding the
chrome ramp because a remap changed what a slot MEANT without auditing who
read it. Changing a token's value (or remapping a slot) requires enumerating
its consumers first — and if two consumer classes want different values, the
token must SPLIT (the content-vs-chrome `CONTENT_TYPE` split in
src/shell/theme.ts, pinned by test/contentType.test.mjs), never quietly serve
both.

## End-of-chain assertions for supply chains

A multi-layer artifact chain (fetch → stage → resolve → bundle) is only as
real as its FINAL artifact; every layer can be green while the payload is
missing. CI asserts the end of the chain, in the built product. Canonical:
the ios-build tripwires in .github/workflows/mobile-bootstrap.yml — "Assert
OCR models boarded the .app payload" (§25/fp3 §1) and "Assert the
private-model bridge boarded the app binary" (0.13.9). A new staged asset
ships with its own end-of-chain assert, not just a staging-step check.

## Cross-feature structural floors

When feature A references feature B's DOM/structure (anchors, ids, class
hooks), A ships a PER-MODE structural test proving the referenced structure
exists in every mode A runs in — otherwise B's refactor silently breaks A
(§33's tour pointed at anchors that didn't exist on the phone). Canonical:
test/tourAnchors.test.mjs — every tour step's `data-tour` target is asserted
present in a component mounted in that step's mode.

## The findability rule

Relocating or burying a capability requires it be findable AT THE MOMENT OF
RELEVANCE — "it still exists somewhere" is not acceptance (§37 lesson; not
yet represented in-repo). Nearest shipped example: the 0.14.2 compact-header
de-crowd kept every relocated action reachable from the visible "More"
submenu (src/features/chat/ChatPanel.tsx) instead of orphaning them. A move
PR states where the capability surfaces in each mode and how the user gets
there when they need it.

## Sentinel hygiene

No magic scores/values with implicit meaning feeding generic algorithms: a
sentinel (score 0 = "unranked", the §36 lesson) silently interacts with
sorting/thresholds written for real values. Name the semantics in a type or a
constant WITH its interactions documented. Canonical: `ASSUMED_DOC_SCORE` in
src/server/synth.ts (a named, documented stand-in relevance) and the typed
`Segment` enum in budget.rs — never a bare `0.0` with a story only in the
author's head.

## Interaction specs

A spec that names a gesture states its discrimination rules — axis lock, edge
zones, thresholds, cancel conditions — or the implementing session must
propose them and get agreement BEFORE coding (§34: an under-specified
edge-swipe yanked tabs during scrolls and was deleted). If you find yourself
inventing thresholds mid-implementation, stop and write the interaction spec
first; the deletion commit for the §34 swipe (src/shell/AppShell.tsx history)
is what skipping this costs.

## Diagnose before prescribe

A § patch starts from a CODE TRACE, not a symptom: locate the failing call
path in the source, name the file:line where behavior diverges from intent,
and only then design the fix. The 0.14.2 field-report arc is canonical — the
"connection refused" symptom traced to the bridge's listener lifecycle
(PrivateModelServer.swift) before any fix was written, which is why one patch
closed three symptoms.

## State files: additive-only + the written_by guard

`state.json` migrates by SERDE-DEFAULT TOLERANCE: new fields are additive
with `#[serde(default)]` (vault.rs::VaultState — the documented
"un-versioned migration story"), so old files load unchanged. The §39
`written_by` guard closes the other direction: every save stamps the writing
app's version, and an app OLDER than the file's writer goes READ-ONLY on that
state (answers work; writes refuse with one honest log line) instead of
clobbering fields it doesn't know. Never remove or re-type an existing field;
never write a state file you only partially understand.
