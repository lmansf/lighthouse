#!/usr/bin/env node
// PR-scoped JS mutation gate (quality-audit §07 rec 8: "changed files only").
//
// Finds the TS engine/lib modules this branch changed, runs the mutation
// harness on each against its PAIRED test file (the audit's convention:
// src/server/foo.ts ↔ test/foo.test.mjs), and fails when any changed
// module's kill score lands under the floor. Whole-module scoring — the
// per-line precision cargo-mutants gets from --in-diff has no JS analog
// here, so the unit of accountability is the module you touched.
//
// Usage: node scripts/mutation/pr-run.mjs [--base origin/main]
// Env:   MUTATION_MIN — kill-score floor in percent (default 80; the audit's
//        "strong suite" band). Survivors judged equivalent don't excuse a
//        module under the floor — write the killing test or improve the code
//        until the score clears it, the way the audit's remediation pass did.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const baseIdx = args.indexOf("--base");
const BASE = baseIdx >= 0 ? args[baseIdx + 1] : "origin/main";
const MIN = Number(process.env.MUTATION_MIN || "80");

const repo = path.join(import.meta.dirname, "..", "..");
const diff = execFileSync(
  "git",
  ["diff", "--name-only", `${BASE}...HEAD`],
  { cwd: repo, encoding: "utf8" },
);

const changed = diff
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => /^src\/(server|lib)\/[A-Za-z0-9]+\.ts$/.test(l));

if (changed.length === 0) {
  console.log(`no engine/lib modules changed vs ${BASE} — nothing to mutate`);
  process.exit(0);
}

const results = [];
for (const target of changed) {
  const name = path.basename(target, ".ts");
  const test = `test/${name}.test.mjs`;
  if (!existsSync(path.join(repo, test))) {
    console.log(`SKIP ${target}: no paired ${test} (pairing convention)`);
    continue;
  }
  const sandbox = path.join(os.tmpdir(), `lh-mut-${name}`);
  const out = path.join(os.tmpdir(), `lh-mut-${name}.json`);
  console.log(`mutating ${target} against ${test} …`);
  const r = spawnSync(
    "node",
    [
      path.join(import.meta.dirname, "mutate.mjs"),
      "--repo", repo,
      "--sandbox", sandbox,
      "--target", target,
      "--tests", test,
      "--out", out,
    ],
    { stdio: "inherit", timeout: 25 * 60_000 },
  );
  if (r.status !== 0) {
    console.error(`harness failed on ${target} (baseline red, or timeout)`);
    process.exit(1);
  }
  const { summary } = JSON.parse(readFileSync(out, "utf8"));
  results.push({ target, ...summary });
}

let failed = false;
for (const r of results) {
  const verdict = r.score >= MIN ? "ok " : "LOW";
  if (r.score < MIN) failed = true;
  console.log(
    `${verdict} ${r.target}: ${r.score}% (${r.killed} killed, ${r.survived} survived, ${r.timeouts} timeouts of ${r.tested})`,
  );
}
if (failed) {
  console.error(`\nmutation score under the ${MIN}% floor — add killing tests for the survivors listed in the module summaries above`);
  process.exit(1);
}
