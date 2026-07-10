/**
 * Answer artifacts, TS twin (src/server/vault.ts::writeArtifact): name repair
 * and collision safety MUST mirror native vault.rs::write_artifact
 * (openspec: add-answer-artifacts).
 *
 * Run: `node --test test/artifacts.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

register("./_ts-extensionless-hook.mjs", import.meta.url);

// Point the vault at a temp dir BEFORE importing the server modules.
const home = mkdtempSync(path.join(tmpdir(), "lh-artifact-"));
const vault = path.join(home, "vault");
mkdirSync(vault, { recursive: true });
process.env.VAULT_DIR = vault;

const { writeArtifact } = await import("../src/server/vault.ts");

test("hostile hints are repaired and stay inside the vault", () => {
  const { id, name } = writeArtifact("Lighthouse Notes", "../../evil name", "md", Buffer.from("x"));
  assert.equal(id, `Lighthouse Notes/${name}`);
  const abs = path.join(vault, id);
  assert.ok(existsSync(abs), `written inside the vault: ${abs}`);
  assert.ok(!existsSync(path.join(home, "evil name.md")), "no traversal outside the vault");

  // An empty / dotfile hint falls back instead of failing.
  const fallback = writeArtifact("Lighthouse Notes", "...", "md", Buffer.from("y"));
  assert.equal(fallback.name, "result.md");
});

test("collisions suffix; existing artifacts are never overwritten", () => {
  const a = writeArtifact("Lighthouse Results", "totals", "csv", Buffer.from("a"));
  const b = writeArtifact("Lighthouse Results", "totals", "csv", Buffer.from("b"));
  assert.equal(a.name, "totals.csv");
  assert.equal(b.name, "totals (1).csv");
  assert.equal(readFileSync(path.join(vault, "Lighthouse Results/totals.csv"), "utf8"), "a");
  assert.equal(readFileSync(path.join(vault, "Lighthouse Results/totals (1).csv"), "utf8"), "b");
});
