/**
 * Egress registry twin (src/server/egress.ts) — mirrors the Rust unit test:
 * aggregation by host+purpose, paths/query/userinfo never stored, All-local
 * empty state.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const {
  recordEgress,
  egressSnapshot,
  resetEgressForTests,
  PURPOSE_AI_PROVIDER,
  PURPOSE_UPDATE_CHECK,
} = await import("../src/server/egress.ts");

test("records aggregate by host+purpose and never keep paths", () => {
  resetEgressForTests();
  assert.equal(egressSnapshot().total, 0, "fresh session reads All local");

  recordEgress("https://api.anthropic.com/v1/messages?secret=nope", PURPOSE_AI_PROVIDER);
  recordEgress("https://api.anthropic.com/v1/models", PURPOSE_AI_PROVIDER);
  recordEgress("https://user:pw@api.github.com:443/repos/x", PURPOSE_UPDATE_CHECK);

  const snap = egressSnapshot();
  assert.equal(snap.total, 3);
  assert.equal(snap.destinations.length, 2, "same host+purpose aggregates");
  const flat = JSON.stringify(snap);
  assert.ok(flat.includes("api.anthropic.com"));
  assert.ok(flat.includes("api.github.com"));
  assert.ok(!flat.includes("/v1/"), "paths never stored");
  assert.ok(!flat.includes("secret"), "query strings never stored");
  assert.ok(!flat.includes("user:pw"), "userinfo never stored");
  const anthropic = snap.destinations.find((d) => d.host === "api.anthropic.com");
  assert.equal(anthropic.count, 2);
  assert.ok(anthropic.lastAt > 0);
  resetEgressForTests();
});
