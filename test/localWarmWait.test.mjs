// §22.4 model warm start (queue-not-fail): the pure warm-wait state machine and
// its byte-pinned twin strings. The Rust engine mirrors every case in
// synth.rs::warm_wait_verdict / warming_label and llm.rs::health_url_for —
// KEEP the two suites in sync (docs/ts-twin.md rule 5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { warmWaitVerdict, warmingLabel } = await import("../src/server/synth.ts");
const { healthUrlFor } = await import("../src/server/llm.ts");

const GRACE = 20_000; // LOCAL_SPAWN_GRACE_MS — pinned; a drift here is a real change
const BUDGET = 300_000; // LOCAL_WARM_WAIT_MS

test("ready always proceeds", () => {
  for (const waited of [0, GRACE, BUDGET]) {
    for (const installed of [true, false]) {
      assert.equal(warmWaitVerdict("ready", installed, waited), "proceed");
    }
  }
});

test("loading waits until the budget, then proceeds", () => {
  assert.equal(warmWaitVerdict("loading", true, 0), "wait");
  assert.equal(warmWaitVerdict("loading", false, 0), "wait");
  assert.equal(warmWaitVerdict("loading", true, BUDGET - 1), "wait");
  assert.equal(warmWaitVerdict("loading", true, BUDGET), "proceed");
});

test("down waits only for an installed model within the spawn grace", () => {
  // Installed → the desktop supervisor will spawn within a reconcile tick.
  assert.equal(warmWaitVerdict("down", true, 0), "wait");
  assert.equal(warmWaitVerdict("down", true, GRACE - 1), "wait");
  // Grace exhausted → the old immediate-fallback behavior returns.
  assert.equal(warmWaitVerdict("down", true, GRACE), "proceed");
  // No installed model (BYO endpoint absent, web twin) → never wait.
  assert.equal(warmWaitVerdict("down", false, 0), "proceed");
});

test("warming label is byte-identical to the Rust twin (staged, progressive)", () => {
  assert.equal(warmingLabel(0), "Private model warming up…");
  assert.equal(warmingLabel(4_500), "Private model warming up…");
  assert.equal(warmingLabel(8_000), "Loading the private model into memory…");
  assert.equal(warmingLabel(19_999), "Loading the private model into memory…");
  assert.equal(warmingLabel(20_000), "Almost ready — the first private answer takes a moment…");
  assert.equal(warmingLabel(61_000), "Almost ready — the first private answer takes a moment…");
});

test("health URL derives from the chat-completions origin", () => {
  assert.equal(
    healthUrlFor("http://127.0.0.1:8080/v1/chat/completions"),
    "http://127.0.0.1:8080/health",
  );
  assert.equal(
    healthUrlFor("http://127.0.0.1:11434/v1/chat/completions"),
    "http://127.0.0.1:11434/health",
  );
  assert.equal(healthUrlFor("not a url"), "http://127.0.0.1:8080/health");
});
