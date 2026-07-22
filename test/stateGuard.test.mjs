/**
 * §39 §5: the TS twin's state-file written_by guard — the same contract the
 * cargo state_guard_test pins on the Rust side: a state.json written by a
 * NEWER app goes read-only (writes refuse with one honest warning, the file's
 * unknown fields survive byte-for-byte), a pre-§39 file stays writable, and
 * the current-version normal path stamps the writer and round-trips
 * byte-identically.
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const vault = mkdtempSync(path.join(tmpdir(), "lh-state-guard-"));
process.env.VAULT_DIR = vault;

const { setIncluded, stateWrittenByNewer } = await import("../src/server/vault.ts");
const { appVersion, statePath } = await import("../src/server/config.ts");

test("version compare mirrors the Rust triples (junk never reads newer)", () => {
  assert.equal(stateWrittenByNewer("99.0.0", "0.14.5"), true);
  assert.equal(stateWrittenByNewer("0.15.0", "0.14.9"), true);
  assert.equal(stateWrittenByNewer("0.14.6", "0.14.5"), true);
  assert.equal(stateWrittenByNewer("0.14.5", "0.14.5"), false);
  assert.equal(stateWrittenByNewer("0.13.10", "0.14.5"), false);
  assert.equal(stateWrittenByNewer(undefined, "0.14.5"), false);
  assert.equal(stateWrittenByNewer("not-a-version", "0.14.5"), false);
  assert.equal(stateWrittenByNewer("1.0.0-beta", "0.14.5"), true);
});

test("an older build reading newer state goes read-only; unknown fields survive", () => {
  const file = statePath();
  mkdirSync(path.dirname(file), { recursive: true });
  const future =
    '{"sourceAvailable":true,"included":{},"futureFeatureFlags":{"beam2":true},"writtenBy":"99.0.0"}';
  writeFileSync(file, future);

  // One honest warning, and the write REFUSES — the file is byte-untouched.
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    setIncluded("some-node.md", true);
  } finally {
    console.warn = realWarn;
  }
  assert.equal(readFileSync(file, "utf8"), future, "the newer writer's file is byte-untouched");
  assert.ok(
    warnings.some((w) => w.includes("read-only")),
    `the refusal logs one honest line: ${warnings}`,
  );
});

test("the normal path stamps the writer and round-trips byte-identically", () => {
  // Fresh vault directory (the guard verdict is re-read per statePath()).
  process.env.VAULT_DIR = mkdtempSync(path.join(tmpdir(), "lh-state-guard2-"));
  setIncluded("notes.md", true);
  const file = statePath();
  const first = readFileSync(file, "utf8");
  assert.ok(
    first.includes(`"writtenBy": "${appVersion()}"`),
    `the save stamps the running version: ${first}`,
  );
  setIncluded("notes.md", true);
  assert.equal(readFileSync(file, "utf8"), first, "current-version normal path is byte-stable");
});
