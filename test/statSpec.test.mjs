/**
 * Unit tests for the inline stat-tile spec parser (src/lib/statSpec.ts, §2).
 * The ```lighthouse-stat fence body carries ONE engine number; a malformed spec
 * must fail closed (null) so the chat degrades to a visible code block, never a
 * broken tile.
 *
 * Run: `node --test test/statSpec.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { parseStatSpec } = await import("../src/lib/statSpec.ts");

test("parses a well-formed stat fence body", () => {
  assert.deepEqual(parseStatSpec('{"raw":"3","value":3,"label":"PDFs"}'), {
    raw: "3",
    value: 3,
    label: "PDFs",
  });
});

test("a missing/blank label reads as null, not a violation", () => {
  assert.deepEqual(parseStatSpec('{"raw":"12","value":12}'), {
    raw: "12",
    value: 12,
    label: null,
  });
  assert.deepEqual(parseStatSpec('{"raw":"12","value":12,"label":null}'), {
    raw: "12",
    value: 12,
    label: null,
  });
});

test("fails closed on any shape violation", () => {
  assert.equal(parseStatSpec("not json"), null);
  assert.equal(parseStatSpec("[1,2,3]"), null);
  assert.equal(parseStatSpec("null"), null);
  assert.equal(parseStatSpec('{"value":3,"label":"x"}'), null); // no raw
  assert.equal(parseStatSpec('{"raw":"","value":3}'), null); // blank raw
  assert.equal(parseStatSpec('{"raw":"3","value":"3"}'), null); // value not a number
  assert.equal(parseStatSpec('{"raw":"x","value":null}'), null); // value not finite
  assert.equal(parseStatSpec('{"raw":"3","value":3,"label":9}'), null); // label not a string
});
