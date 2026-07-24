/**
 * §44 §2: the numeric trust guard twin (src/server/numguard.ts) — byte-parity
 * with native/crates/lighthouse-core/src/numguard.rs. The tokenizer, the
 * verified-set membership, the citation stripping, and the byte-pinned
 * degradation copy must match the Rust twin exactly (the same fixtures the
 * cargo unit tests assert).
 *
 * Run: `node --test test/numguard.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const {
  numberTokens,
  verifiedSet,
  answerHasUnverifiedNumber,
  numberFreeDegradation,
} = await import("../src/server/numguard.ts");

test("numberTokens match the report framer's tokenizer (parity)", () => {
  const toks = numberTokens("$4,200.50 rose +2.85σ over 2024-10; see row 7.");
  for (const t of ["4200.50", "2.85", "2024", "10", "7"]) {
    assert.ok(toks.has(t), `${t} missing`);
  }
  assert.ok(!toks.has("4,200.50"), "separators are stripped");
  assert.ok(!toks.has("7."), "sentence punctuation is trimmed");
  assert.equal(numberTokens("no digits here").size, 0);
});

test("verifiedSet admits integer parts only", () => {
  const v = verifiedSet(["mean 7.25, sum 210"]);
  assert.ok(v.has("7.25") && v.has("7"), "decimal and its integer part");
  assert.ok(v.has("210"));
  assert.ok(!v.has("8"), "an unrelated number is not admitted");
});

test("an unverified number is caught; a faithful citation passes", () => {
  const verified = verifiedSet(["mean 7.25 min 5 max 9"]);
  assert.ok(
    !answerHasUnverifiedNumber("Your nightly average is about 7 hours.", verified),
    "7 is the integer part of the verified 7.25",
  );
  assert.ok(
    answerHasUnverifiedNumber("Your average is 6.5 hours across 42 nights.", verified),
    "6.5 and 42 appear nowhere in the verified set",
  );
  assert.ok(!answerHasUnverifiedNumber("This file tracks nightly sleep.", verified));
});

test("citation markers are not data numbers", () => {
  const empty = new Set();
  assert.ok(
    !answerHasUnverifiedNumber(
      "The log records bedtime and wake time [1], plus a quality note [2, 3].",
      empty,
    ),
  );
  assert.ok(answerHasUnverifiedNumber("The average was 7.2 hours [1].", empty));
});

test("degradation names columns and is byte-pinned (parity)", () => {
  assert.equal(
    numberFreeDegradation("sleep.csv", ["sleep_hours", "quality", "weekday"]),
    'I can read sleep.csv, but I couldn\'t compute a verified statistic for that. ' +
      'Try phrasing it as "average sleep_hours" or "total quality by weekday" — ' +
      "I only show numbers Lighthouse computed from the data.",
  );
  assert.equal(
    numberFreeDegradation("", []),
    'I can read this file, but I couldn\'t compute a verified statistic for that. ' +
      'Try phrasing it as "average <column>" or "total <x> by <y>" — ' +
      "I only show numbers Lighthouse computed from the data.",
  );
});
