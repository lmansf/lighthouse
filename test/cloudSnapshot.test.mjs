/**
 * §32 §0: the cloud-snapshot rail. The hosted prompt assembly — SYSTEM_PROMPT,
 * buildPrompt(question, contexts), priorTurns(history) — must stay
 * BYTE-IDENTICAL while the on-device tiers move underneath it. The canonical
 * bytes live in test/fixtures/cloud-snapshot/ and BOTH engines assert against
 * the same files (llm.rs's cloud_snapshot tests are the Rust half), so twin
 * drift and accidental cloud changes both fail loud. Regenerating the
 * fixtures IS the act of changing the cloud prompt — do it only when a spec
 * explicitly says so.
 *
 * Run: `node --test test/cloudSnapshot.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fx = (p) => readFileSync(path.join(ROOT, "test/fixtures/cloud-snapshot", p), "utf8");

const { SYSTEM_PROMPT, buildPrompt, priorTurns } = await import("../src/server/llm.ts");
const inputs = JSON.parse(fx("inputs.json"));

test("SYSTEM_PROMPT is byte-identical to the canonical snapshot", () => {
  assert.equal(SYSTEM_PROMPT, fx("system-prompt.txt"), "the cloud system prompt moved — §32 forbids that");
});

test("buildPrompt output is byte-identical for the fixture ask", () => {
  assert.equal(
    buildPrompt(inputs.question, inputs.contexts),
    fx("expected-prompt.txt"),
    "the context/question framing moved — §32 forbids that",
  );
});

test("priorTurns drops empties, trims to a leading user turn, and preserves order", () => {
  assert.deepEqual(
    priorTurns(inputs.history),
    JSON.parse(fx("expected-turns.json")),
    "the history shaping moved — §32 forbids that",
  );
});
