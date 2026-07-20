/**
 * Privacy legibility (0.12.1 §2) — "Private — this device only" made VISIBLE.
 * The enforcement itself is engine-side and already proven end-to-end
 * (localOnly.test.mjs ⇄ local_only_test.rs); this suite pins the PRESENTATION
 * layer that makes it legible, in the boardsUi.test.mjs house style: the pure
 * helpers are exercised for real, and the JSX surfaces (FileExplorer,
 * FileInspector, ChatPanel, FirstRunTour) are asserted structurally against
 * the source since they can't load in node. The last tests prove the engine
 * emitters were NOT touched: the skip-note templates are byte-pinned in both
 * engines, and the UI's provider rule is checked against the TS twin's
 * isCloudProvider truth table for real.
 *
 * Run: `node --test test/privacyLegibility.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { cloudProviderActive, hiddenFromCloudLabel, LOCAL_ONLY_SKIP_NOTE_RE } = await import(
  "../src/lib/privacyState.ts"
);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const explorer = read("src/features/explorer/FileExplorer.tsx");
const inspector = read("src/features/explorer/FileInspector.tsx");
const chat = read("src/features/chat/ChatPanel.tsx");
const tour = read("src/features/help/FirstRunTour.tsx");
const helper = read("src/lib/privacyState.ts");

// --- One rule, one place -------------------------------------------------------

test("the provider rule lives in privacyState and every surface imports it", () => {
  assert.match(
    helper,
    /KEEP IN SYNC with synth\.rs::is_cloud_provider/,
    "the helper names the engine predicate it mirrors",
  );
  for (const [name, src] of [
    ["FileExplorer", explorer],
    ["FileInspector", inspector],
    ["ChatPanel", chat],
  ]) {
    assert.match(
      src,
      /from "@\/lib\/privacyState"/,
      `${name} derives cloud-vs-local from the shared helper, not an inline rule`,
    );
    assert.match(src, /cloudProviderActive\(/, `${name} calls the single rule`);
  }
});

// --- A. The lock's two states on the explorer row --------------------------------

test("row lock: ENFORCING and DORMANT tooltips are exact, unmarked unchanged", () => {
  assert.match(
    explorer,
    /"Private — hidden from cloud models right now; click to allow cloud models"/,
    "ENFORCING (cloud active, file marked)",
  );
  assert.match(
    explorer,
    /"Hidden from cloud models\. The private model can always read it\."/,
    "DORMANT (private model active, file marked)",
  );
  assert.match(
    explorer,
    /"Shareable with cloud models — click to keep on this device only"/,
    "unmarked tooltip unchanged",
  );
  // The branch itself: marked ⇒ provider identity decides which state renders.
  assert.match(
    explorer,
    /const lockLabel = isLocalOnly\s*\?\s*cloudActive\s*\?/,
    "the label branches marked → cloudActive",
  );
});

test("row lock: red stays for enforcement; dormant drops to a neutral token", () => {
  assert.match(
    explorer,
    /lockDormant:\s*\{\s*color:\s*tokens\.colorNeutralForeground3\s*\}/,
    "dormant tint is a neutral theme token (both themes), never a literal color",
  );
  assert.match(
    explorer,
    /isLocalOnly \? \(cloudActive \? styles\.lockOn : styles\.lockDormant\) : undefined/,
    "the button class branches red (enforcing) vs neutral (dormant)",
  );
  assert.match(
    explorer,
    /lockOn:\s*\{\s*color:\s*tokens\.colorPaletteRedForeground1\s*\}/,
    "the enforcing red treatment is untouched",
  );
  // The closed-lock glyph is kept for BOTH marked states.
  assert.match(explorer, /icon=\{isLocalOnly \? <LockClosedRegular \/> : <LockOpenRegular \/>\}/);
});

test("row lock a11y: aria-pressed kept, aria-label carries the state", () => {
  assert.match(explorer, /aria-pressed=\{isLocalOnly\}/, "toggle semantics kept");
  assert.match(
    explorer,
    /aria-label=\{lockLabel\}\s*aria-pressed=\{isLocalOnly\}/,
    "the state-bearing label is the aria-label, so screen readers hear the difference",
  );
});

test("context menu actions stay byte-identical; bulk switch gains the state tooltip", () => {
  assert.match(explorer, /"Allow cloud models" : "Keep private \(this device only\)"/);
  // The bulk "Private (this device)" switch: label unchanged, and when the
  // whole selection is marked a tooltip says what the mark is doing right now.
  assert.match(explorer, /label="Private \(this device\)"/);
  assert.match(
    explorer,
    /allSelectedLocalOnly \? \([\s\S]{0,400}"Private — hidden from cloud models right now"[\s\S]{0,200}"Hidden from cloud models\. The private model can always read it\."/,
    "checked bulk switch explains enforcing vs dormant",
  );
});

// --- A. Inspector pill nuance ----------------------------------------------------

test("inspector pill: marked files say enforcing vs dormant; unmarked unchanged", () => {
  assert.match(inspector, /"Private — hidden from cloud models right now"/);
  assert.match(
    inspector,
    /"Private — hidden from cloud models\. The private model can always read it\."/,
  );
  assert.match(inspector, /"Shareable with cloud models"/, "unmarked pill unchanged");
  assert.match(
    inspector,
    /localOnly\s*\?\s*cloudProviderActive\(providerId\)/,
    "the pill branches on the shared rule",
  );
  // Rule attribution lines are untouched.
  assert.match(inspector, /Kept on this device by rule/);
  assert.match(inspector, /\{included \? "Included" : "Hidden"\} by rule/);
});

// --- B. Header count inside the egress shield's status popover -------------------
// §22.2 (declutter the top bar): the standalone header button collapsed INTO
// the EgressShield dialog — same copy, same events, one popover. The exact
// label still comes from the one pure helper; the ChatPanel computes the
// count and gates it on the provider rule, the shield renders it.

test("header count: exact copy, cloud-only visibility, renders inside EgressShield", () => {
  // Copy comes from the one pure helper — both plural forms pinned for real.
  assert.equal(hiddenFromCloudLabel(1), "1 file hidden from cloud models");
  assert.equal(hiddenFromCloudLabel(3), "3 files hidden from cloud models");
  const shield = read("src/features/egress/EgressShield.tsx");
  assert.match(shield, /from "@\/lib\/privacyState"/, "the shield imports the one helper");
  assert.match(shield, /hiddenFromCloudLabel\(withheld\)/, "the shield renders the helper's copy");
  assert.match(
    chat,
    /const hiddenFromCloud = useMemo\(\(\) => hiddenFromCloudCount\(nodes\), \[nodes\]\)/,
    "count = files with localOnly && ragIncluded, from the store's nodes",
  );
  assert.match(
    chat,
    /hiddenFromCloud=\{cloudActive \? hiddenFromCloud : 0\}/,
    "the owner passes the count ONLY while a cloud provider is active",
  );
  assert.match(
    shield,
    /\{withheld > 0 && \(/,
    "the shield hides the section entirely at zero",
  );
});

test("header count click: dispatches the filter event (+ the sidebar-open ping)", () => {
  assert.match(
    chat,
    /dispatchEvent\(new CustomEvent\("lighthouse:filter-local-only"\)\)/,
    "the click hands off to the explorer via the new event",
  );
  // A collapsed sidebar would hide the result: AppShell un-collapses on the
  // reveal seam by event NAME alone, and the explorer's reveal handler ignores
  // a detail-less dispatch — so the ping opens the rail with no other effect.
  assert.match(
    chat,
    /lighthouse:filter-local-only"\)\);\s*window\.dispatchEvent\(new CustomEvent\("lighthouse:reveal-node"\)\)/,
    "the detail-less reveal-node ping rides along to open a collapsed sidebar",
  );
  const appShell = read("src/shell/AppShell.tsx");
  // §5/fp4 §3 reshaped the handler (compact selects the Files tab instead of
  // un-collapsing) but the property this pins is unchanged: the listener reads
  // NO detail — the ping is safe.
  assert.match(
    appShell,
    /const onReveal = \(\) => \{\s*\/\/[^\n]*\n\s*if \(compactRef\.current\) setCompactTab\("files"\);\s*else setCollapsed\(false\);/,
    "AppShell's listener really is name-only (no detail read) — the ping is safe",
  );
  assert.match(
    explorer,
    /if \(typeof id === "string"\) revealInExplorerRef\.current\(id\)/,
    "the explorer's reveal handler really ignores a detail-less event",
  );
});

test("explorer filter: onlyLocalOnly beside onlyVisible, honest and clearable in place", () => {
  assert.match(explorer, /const \[onlyLocalOnly, setOnlyLocalOnly\] = useState\(false\)/);
  assert.match(
    explorer,
    /const filterActive = trimmedQuery !== "" \|\| onlyVisible \|\| onlyLocalOnly/,
    "filterActive extended (drives force-open of matched ancestors too)",
  );
  assert.match(
    explorer,
    /\(!onlyVisible \|\| n\.ragIncluded\) &&\s*\(!onlyLocalOnly \|\| n\.localOnly\)/,
    "the keep predicate gains the lock axis beside the eye axis",
  );
  // The filter-bar toggle: the state is visible and clearable where it acts.
  assert.match(explorer, /checked=\{onlyLocalOnly\}/);
  assert.match(explorer, /Hidden from cloud\s*<\/ToggleButton>/);
  // The header's event flips it on and clears the search so the filtered view
  // is honestly "everything hidden from cloud", not "∩ a stale search".
  assert.match(
    explorer,
    /setOnlyLocalOnly\(true\);\s*setQuery\(""\);\s*setDebouncedQuery\(""\)/,
    "event handler: filter on, search cleared (both debounce halves)",
  );
  assert.match(explorer, /addEventListener\("lighthouse:filter-local-only"/);
  assert.match(
    explorer,
    /removeEventListener\("lighthouse:filter-local-only"/,
    "cleanup mirrors the house listener style",
  );
  // Quick-open reveal must not strand a node behind the new filter.
  assert.match(
    explorer,
    /setOnlyVisible\(false\);\s*setOnlyLocalOnly\(false\)/,
    "reveal-in-explorer clears the lock filter like the eye filter",
  );
});

// --- C. Skip note rendered as a callout (presentation only) ----------------------

test("skip-note callout: em renderer branches on the stable prefix, others untouched", () => {
  assert.match(
    chat,
    /em: \(\{ node, children, \.\.\.props \}\) =>/,
    "an em renderer exists among the custom markdown components",
  );
  assert.match(
    chat,
    /LOCAL_ONLY_SKIP_NOTE_RE\.test\(hastText\(node\)\)/,
    "detection = the shared regex over the emphasis node's TEXT",
  );
  assert.match(
    chat,
    /LOCAL_ONLY_SKIP_NOTE_RE\.test\(hastText\(node\)\)[\s\S]{0,400}<LockClosedRegular/,
    "the callout carries the small closed lock",
  );
  assert.match(
    chat,
    /return <em \{\.\.\.props\}>\{children\}<\/em>/,
    "every other emphasis renders as a plain <em>",
  );
  // The callout style: hairline border + theme tokens (savedNote family).
  assert.match(chat, /skipNoteCallout:[\s\S]{0,700}colorNeutralStroke2/, "hairline via tokens");
  assert.match(chat, /skipNoteCallout:[\s\S]{0,700}fontStyle: "normal"/, "italics replaced");
});

test("skip-note regex matches the REAL emitted note from the TS twin, both plural forms", async () => {
  const synth = await import("../src/server/synth.ts");
  for (const n of [1, 4]) {
    const note = synth.localOnlySkipNote(n);
    // The markdown `_…_` wrapper is emphasis SYNTAX — the rendered em node's
    // text starts at the paren, which is what the UI regex sees.
    const emText = note.replace(/^_/, "");
    assert.match(emText, LOCAL_ONLY_SKIP_NOTE_RE, `n=${n}: ${note}`);
  }
});

// --- D. Tour copy -----------------------------------------------------------------

test("tour: the lock sentence is the new plain-language one, verbatim", () => {
  assert.match(
    tour,
    /The lock toggle keeps a file private to this device — hidden from cloud models, while the private model can always read it\./,
  );
  assert.doesNotMatch(
    tour,
    /never sent to a cloud model/,
    "the old sentence is gone",
  );
});

// --- Engines untouched (this change is presentation + copy ONLY) ------------------

test("engine skip-note emitters are byte-untouched in BOTH engines", () => {
  const rs = read("native/crates/lighthouse-core/src/synth.rs");
  const ts = read("src/server/synth.ts");
  assert.ok(
    rs.includes(
      "\"_({n} {files} skipped — marked private (this device only), so the AI can't send {them} to a cloud model. Switch to the private model to include {them}.)_\\n\\n\"",
    ),
    "synth.rs::local_only_skip_note template line is exactly as shipped",
  );
  assert.ok(
    ts.includes(
      "return `_(${n} ${files} skipped — marked private (this device only), so the AI can't send ${them} to a cloud model. Switch to the private model to include ${them}.)_\\n\\n`;",
    ),
    "synth.ts::localOnlySkipNote template line is exactly as shipped",
  );
});

test("UI rule ⇄ engine rule: cloudProviderActive matches isCloudProvider's verdicts", async () => {
  const { isCloudProvider } = await import("../src/server/synth.ts");
  for (const providerId of [null, "", "local", "anthropic", "openai", "mistral"]) {
    assert.equal(
      cloudProviderActive(providerId),
      isCloudProvider({ providerId, modelId: "m", apiKey: "" }),
      `providerId=${JSON.stringify(providerId)}`,
    );
  }
});
