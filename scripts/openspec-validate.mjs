#!/usr/bin/env node
/**
 * Local structural validator for OpenSpec changes.
 *
 * The `openspec` CLI is not installable in this environment (the npm `openspec`
 * package is an unrelated placeholder; `@openspec/cli` is unreachable), so this
 * script stands in for `openspec validate --all`, enforcing the same structural
 * rules the CLI checks against `openspec/config.yaml` (schema: spec-driven):
 *
 *   Every change under openspec/changes/<id>/ (excluding `archive/`) MUST have:
 *     - proposal.md containing a `## Why` and a `## What Changes` section
 *     - tasks.md
 *     - a specs/ directory with at least one specs/<capability>/spec.md
 *   Every spec delta (specs/<cap>/spec.md) MUST:
 *     - be titled `# <cap> — delta`
 *     - contain at least one `## (ADDED|MODIFIED|REMOVED|RENAMED) Requirements`
 *       operation header
 *     - give every `### Requirement:` at least one `#### Scenario:`
 *     - use `- **WHEN**` / `- **THEN**` bullets under each scenario
 *
 * Usage:
 *   node scripts/openspec-validate.mjs --all
 *   node scripts/openspec-validate.mjs <change-id> [<change-id> ...]
 *
 * Exits non-zero and prints every problem when validation fails; prints a
 * one-line OK summary and exits 0 when all requested changes are valid.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHANGES = join(ROOT, "openspec", "changes");

const OP_HEADER = /^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements\s*$/m;

/** Collect validation problems for one change id; empty array = valid. */
function validateChange(id) {
  const problems = [];
  const dir = join(CHANGES, id);
  const rel = `openspec/changes/${id}`;

  const proposal = join(dir, "proposal.md");
  if (!existsSync(proposal)) {
    problems.push(`${rel}/proposal.md: missing`);
  } else {
    const text = readFileSync(proposal, "utf8");
    if (!/^##\s+Why\s*$/m.test(text)) problems.push(`${rel}/proposal.md: no "## Why" section`);
    if (!/^##\s+What Changes\s*$/m.test(text))
      problems.push(`${rel}/proposal.md: no "## What Changes" section`);
  }

  if (!existsSync(join(dir, "tasks.md"))) problems.push(`${rel}/tasks.md: missing`);

  const specsDir = join(dir, "specs");
  if (!existsSync(specsDir) || !statSync(specsDir).isDirectory()) {
    problems.push(`${rel}/specs/: missing — a change must declare at least one spec delta`);
    return problems;
  }

  const caps = readdirSync(specsDir).filter((c) => statSync(join(specsDir, c)).isDirectory());
  if (caps.length === 0) problems.push(`${rel}/specs/: no capability directories`);

  for (const cap of caps) {
    const spec = join(specsDir, cap, "spec.md");
    const specRel = `${rel}/specs/${cap}/spec.md`;
    if (!existsSync(spec)) {
      problems.push(`${specRel}: missing`);
      continue;
    }
    problems.push(...validateSpec(spec, specRel, cap));
  }
  return problems;
}

/** Structural checks for one spec delta file. */
function validateSpec(path, rel, cap) {
  const problems = [];
  const text = readFileSync(path, "utf8");

  if (!new RegExp(`^#\\s+${escapeRe(cap)}\\s+—\\s+delta\\s*$`, "m").test(text)) {
    problems.push(`${rel}: title should be "# ${cap} — delta"`);
  }
  if (!OP_HEADER.test(text)) {
    problems.push(`${rel}: no "## ADDED|MODIFIED|REMOVED|RENAMED Requirements" operation header`);
  }

  // Split into requirement blocks and check each carries a scenario.
  const lines = text.split("\n");
  const reqs = [];
  let cur = null;
  for (const line of lines) {
    const m = /^###\s+Requirement:\s*(.+?)\s*$/.exec(line);
    if (m) {
      cur = { title: m[1], scenarios: 0, whens: 0, thens: 0 };
      reqs.push(cur);
      continue;
    }
    if (!cur) continue;
    if (/^####\s+Scenario:/.test(line)) cur.scenarios++;
    else if (/^-\s+\*\*WHEN\*\*/.test(line)) cur.whens++;
    else if (/^-\s+\*\*THEN\*\*/.test(line)) cur.thens++;
  }
  if (reqs.length === 0) problems.push(`${rel}: no "### Requirement:" entries`);
  for (const r of reqs) {
    if (r.scenarios === 0)
      problems.push(`${rel}: requirement "${r.title}" has no "#### Scenario:"`);
    if (r.whens === 0 || r.thens === 0)
      problems.push(`${rel}: requirement "${r.title}" is missing a "- **WHEN**"/"- **THEN**" bullet`);
  }
  return problems;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function allChangeIds() {
  if (!existsSync(CHANGES)) return [];
  return readdirSync(CHANGES)
    .filter((d) => d !== "archive")
    .filter((d) => statSync(join(CHANGES, d)).isDirectory());
}

function main() {
  const args = process.argv.slice(2);
  const ids = args.length === 0 || args.includes("--all") ? allChangeIds() : args;
  if (ids.length === 0) {
    console.error("no changes found under openspec/changes/");
    process.exit(1);
  }
  let failed = 0;
  for (const id of ids.sort()) {
    const problems = validateChange(id);
    if (problems.length === 0) {
      console.log(`  ok   ${id}`);
    } else {
      failed++;
      console.log(`  FAIL ${id}`);
      for (const p of problems) console.log(`         - ${p}`);
    }
  }
  const total = ids.length;
  if (failed === 0) {
    console.log(`\nopenspec validate: ${total}/${total} change(s) valid`);
    process.exit(0);
  }
  console.log(`\nopenspec validate: ${failed}/${total} change(s) INVALID`);
  process.exit(1);
}

main();
