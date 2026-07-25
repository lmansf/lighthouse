/**
 * §48 §3: a visible Report door in two always-relevant places.
 *  a. Hero: the report chip is NAMED "Report on <table>" (not hidden behind
 *     "Investigate"), with a report icon, keeping its Standard/Scientific/
 *     Business menu.
 *  b. Per-answer: a "Report…" action on a tabular analytics answer whose source
 *     table resolves — the §46 hypothesis prompt + reused investigate() + a
 *     Saved—Open confirmation; absent when no source table resolves (no dead
 *     door).
 * Source-pinned (JSX the node runner can't import); live behavior is the
 * simulator/E2E pass.
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

test("§3a: the hero chip reads \"Report on <table>\" with a report icon, menu intact", () => {
  const chip = read("src/features/chat/ReportChip.tsx");
  assert.match(chip, /`Report on \$\{table\}`/, "the trigger names the report");
  assert.match(chip, /icon=\{<IconReport \/>\}/, "a report icon, not a search glass");
  // The Standard/Scientific/Business menu + engine op stay byte-identical.
  assert.match(chip, /label: "Standard report",/);
  assert.match(chip, /label: "Scientific method",/);
  assert.match(chip, /label: "Business report",/);
  assert.match(chip, /ragService\.investigate\(table, undefined, template\)/, "reused investigate op");
});

test("§3b: the per-answer Report action is gated on a resolvable source table", () => {
  const action = read("src/features/chat/AnswerReportAction.tsx");
  // Resolves THIS answer's source table from its own files via the investigable
  // gate, and is ABSENT when none resolves (no dead door).
  assert.match(action, /ragService\s*\n?\s*\.capabilityMap\(/, "resolves from the answer's files");
  assert.match(action, /\.find\(\(t\) => t\.investigable\)\?\.name \?\? null/, "investigable source table");
  assert.match(action, /if \(!table\) return null;/, "absent when no source table resolves");
  // The §46 hypothesis prompt + reused investigate with the hypothesis + the
  // Saved—Open confirmation.
  assert.match(action, /aria-label="Working hypothesis"/, "the §46 hypothesis prompt");
  assert.match(
    action,
    /ragService\.investigate\(\s*table!,\s*currentInvestigationId,\s*template,\s*hypoText\.trim\(\) \|\| undefined,\s*\)/,
    "investigate reused with the current investigation + hypothesis",
  );
  assert.match(action, /Saved \{saved\.name\}/, "Saved <name> confirmation");
  assert.match(action, />\s*Open\s*</, "with an Open affordance");
  // Standard maps to NO template (the deterministic report), like the hero door.
  assert.match(action, /picked === "standard" \? undefined : picked/, "Standard = no template");
});

test("§3b: the Report action rides the per-answer action row", () => {
  const chat = read("src/features/chat/ChatPanel.tsx");
  assert.match(chat, /<AnswerReportAction fileIds=\{meta\.fileIds\} \/>/, "mounted in the RefineChips row");
});
