/**
 * Managed-policy twin (src/server/policy.ts) — mirrors the Rust unit tests
 * in native/crates/lighthouse-core/src/policy.rs for the engine-shared
 * semantics: absent = unrestricted, malformed = fail-closed trio, provider
 * rules (forceLocalOnly / allowlist / contradictory intersection),
 * telemetry/history switches, and the snapshot lock shape.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const policy = await import("../src/server/policy.ts");

function withPolicy(content, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "lh-policy-"));
  const file = path.join(dir, "policy.json");
  if (content !== null) writeFileSync(file, content);
  process.env.LIGHTHOUSE_POLICY_FILE = file;
  policy.resetPolicyForTests();
  try {
    fn();
  } finally {
    delete process.env.LIGHTHOUSE_POLICY_FILE;
    policy.resetPolicyForTests();
  }
}

test("absent policy restricts nothing", () => {
  withPolicy(null, () => {
    assert.equal(policy.policyPresent(), false);
    assert.equal(policy.providerAllowed("deepseek"), true);
    assert.equal(policy.telemetryAllowed(), true);
    assert.equal(policy.historyAllowed(), true);
  });
});

test("malformed policy fails closed to the trio", () => {
  withPolicy("{ not json", () => {
    assert.equal(policy.policyPresent(), true);
    assert.equal(policy.policyError(), true);
    assert.equal(policy.providerAllowed("local"), true);
    assert.equal(policy.providerAllowed("anthropic"), false, "cloud refused under malformed policy");
    assert.equal(policy.telemetryAllowed(), false);
    assert.equal(policy.historyAllowed(), false);
  });
});

test("provider rules: forceLocalOnly, allowlist, contradictory intersection", () => {
  withPolicy(JSON.stringify({ forceLocalOnly: true }), () => {
    assert.equal(policy.providerAllowed("local"), true);
    assert.equal(policy.providerAllowed("openai"), false);
  });
  withPolicy(JSON.stringify({ allowedProviders: ["local", "anthropic"] }), () => {
    assert.equal(policy.providerAllowed("anthropic"), true);
    assert.equal(policy.providerAllowed("deepseek"), false);
  });
  withPolicy(JSON.stringify({ forceLocalOnly: true, allowedProviders: ["anthropic"] }), () => {
    assert.equal(policy.providerAllowed("anthropic"), false, "not local");
    assert.equal(policy.providerAllowed("local"), false, "contradictory policy is restrictive");
  });
});

test("unknown version fails closed; unknown keys do not", () => {
  withPolicy(JSON.stringify({ v: 9, telemetry: "off" }), () => {
    assert.equal(policy.policyError(), true);
  });
  withPolicy(JSON.stringify({ v: 1, telemetry: "off", futureKey: { x: 1 } }), () => {
    assert.equal(policy.policyError(), false);
    assert.equal(policy.telemetryAllowed(), false);
    assert.equal(policy.providerAllowed("openai"), true, "unset keys stay unrestricted");
  });
});

test("snapshot reports the lock shape the UI renders", () => {
  withPolicy(JSON.stringify({ forceLocalOnly: true, telemetry: "off", auditLog: "on" }), () => {
    const s = policy.policySnapshot();
    assert.equal(s.present, true);
    assert.equal(s.error, false);
    assert.deepEqual(s.locks.allowedProviders, ["local"]);
    assert.equal(s.locks.telemetryOff, true);
    assert.equal(s.locks.auditLogOn, true);
    assert.equal(s.locks.chatHistoryOff, false);
  });
});
