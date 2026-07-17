// Assumption ledger (openspec: add-recipes §1) — the client fold and the two
// engine emit sites, asserted structurally against source. The client fold
// lives inside ChatPanel.tsx's remarkAnswerCard (a React/JSX module that can't
// load in node), and the engine emitters live in Rust, so this is the
// boardsUi/investigationsUi house style: read the source and assert the wiring.
// Live rendering is covered by the Rust ledger_test + the UI E2E pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const chatPanel = read("src/features/chat/ChatPanel.tsx");
const synthRs = read("native/crates/lighthouse-core/src/synth.rs");
const synthTs = read("src/server/synth.ts");
const ledgerRs = read("native/crates/lighthouse-core/src/ledger.rs");

// --- Client fold: the *Assumptions:* label + list becomes its own <details> ---

test("ChatPanel recognizes the engine's assumption-ledger label", () => {
  assert.match(
    chatPanel,
    /const ASSUMPTIONS_LABEL_RE = \/\^Assumptions/,
    "an emphasis-led *Assumptions:* label is matched by its own regex",
  );
  assert.match(
    chatPanel,
    /function isAssumptionsLabel\(node: MdNode\): boolean/,
    "a dedicated predicate identifies the label paragraph",
  );
});

test("remarkAnswerCard folds the label + list into its own disclosure", () => {
  // The fold is gated on the label AND a following list, then wraps them in an
  // lhAssumptions details node whose summary is the re-tagged label paragraph —
  // mirroring the SQL fold exactly.
  const fold =
    /if \(!isAssumptionsLabel\(children\[i\]\)\) continue;[\s\S]*?children\[i \+ 1\]\.type !== "list"[\s\S]*?hName: "summary"[\s\S]*?type: "lhAssumptions"[\s\S]*?hName: "details"[\s\S]*?children\.splice\(i, 2, details\)/;
  assert.match(chatPanel, fold, "label + following list fold into an lhAssumptions <details>");
});

test("the folded ledger rides the card and reuses the quiet disclosure styling", () => {
  // Added to isFooterish, so the answer-card range sweeps the disclosure in.
  assert.match(
    chatPanel,
    /function isFooterish[\s\S]*?node\.type === "lhAssumptions"/,
    "lhAssumptions counts as footer-ish, so it joins the answer card",
  );
  // Reuses the existing lh-query-used disclosure class (no new colors); the
  // lh-assumptions class is a semantic hook.
  assert.match(
    chatPanel,
    /className: \["lh-query-used", "lh-assumptions"\]/,
    "the assumptions disclosure reuses the SQL footer's styling",
  );
});

test("a non-analytics answer grows no disclosure (the fold is label-gated)", () => {
  // There is exactly one place that can mint an lhAssumptions node, and it is
  // guarded by isAssumptionsLabel — so an answer with no *Assumptions:* label
  // (an ordinary prose answer) can never produce the disclosure.
  const mints = chatPanel.match(/type: "lhAssumptions"/g) ?? [];
  assert.equal(mints.length, 1, "only one construction site for the disclosure");
  const guardBeforeMint = /if \(!isAssumptionsLabel\(children\[i\]\)\) continue;[\s\S]*?type: "lhAssumptions"/;
  assert.match(chatPanel, guardBeforeMint, "the sole construction site is behind the label guard");
});

// --- Engine emit sites: single-query + multi-step both call the ledger ---

test("synth.rs emits the ledger on the single-query analytics path", () => {
  assert.match(
    synthRs,
    /crate::ledger::assumption_ledger\(&sql, &regs, &res\)/,
    "single-query path derives the ledger from the executed SQL + result",
  );
});

test("synth.rs emits the ledger on the multi-step analytics path", () => {
  assert.match(
    synthRs,
    /crate::ledger::assumption_ledger_parts\(\s*&last\.sql, &regs, last_rows/,
    "multi-step path derives the ledger for the last step with threaded row facts",
  );
  // The ledger emit sits after the provenance footers on both paths.
  assert.ok(
    synthRs.indexOf("assumption_ledger(&sql") > synthRs.indexOf("*Query used:*"),
    "single-query ledger is emitted after the Query-used footer",
  );
});

// --- Contracts + parity ---

test("ledger.rs exposes both entry points", () => {
  assert.match(ledgerRs, /pub fn assumption_ledger\(/);
  assert.match(ledgerRs, /pub fn assumption_ledger_parts\(/);
});

test("the TS twin documents that it emits no ledger (PARITY)", () => {
  assert.match(
    synthTs,
    /PARITY[\s\S]*?assumption_ledger[\s\S]*?emits no ledger/,
    "the twin has no analytics branch, so it emits no ledger — noted as PARITY",
  );
});
