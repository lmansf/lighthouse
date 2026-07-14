/**
 * Local audit-log twin (src/server/audit.ts) — mirrors the Rust engine's record
 * shape, gating, egress-delta capture, and CSV export at the app/api/chat choke
 * point. The one deliberate divergence is that the twin keeps NO HMAC chain
 * (PARITY / design D6), so `verify` here always reports intact — this suite
 * asserts the behavior that IS shared, not the chain.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-audit-"));
const auditFile = path.join(dir, "audit.jsonl");
const settingsFile = path.join(dir, "settings.json");
process.env.LIGHTHOUSE_AUDIT_FILE = auditFile;
process.env.LIGHTHOUSE_SETTINGS_FILE = settingsFile;

const {
  appendAudit,
  recentAudit,
  verifyActiveAudit,
  exportCsvAudit,
  beginAudit,
  finishAudit,
  resetAuditForTests,
} = await import("../src/server/audit.ts");
const { recordEgress, resetEgressForTests, PURPOSE_AI_PROVIDER } = await import(
  "../src/server/egress.ts"
);
const policy = await import("../src/server/policy.ts");

/** Seed the settings file so `auditEnabled()` sees our choice; clear any policy. */
function reset(settings) {
  resetAuditForTests();
  fs.writeFileSync(settingsFile, JSON.stringify(settings ?? {}));
  delete process.env.LIGHTHOUSE_POLICY_FILE;
  policy.resetPolicyForTests();
}

function record(question, provider, egress) {
  appendAudit({ question, fileIds: ["budget.md"], provider, egress, artifacts: [] });
}

test("disabled: nothing is written", () => {
  reset({}); // auditEnabled absent → off
  record("q", "local", []);
  assert.ok(!fs.existsSync(auditFile), "no file when the log is off");
  const snap = recentAudit(10);
  assert.equal(snap.enabled, false);
  assert.equal(snap.records.length, 0);
});

test("enabled: cloud logs the host, local logs egress:none, newest first", () => {
  reset({ auditEnabled: true });
  record("cloud question", "openai", ["api.openai.com"]);
  record("local question", "local", []);

  const snap = recentAudit(10);
  assert.equal(snap.enabled, true);
  assert.equal(snap.intact, true, "twin claims no chain — always intact");
  assert.equal(snap.records.length, 2);
  // newest first
  assert.equal(snap.records[0].provider, "local");
  assert.deepEqual(snap.records[0].egress, ["none"], "a local answer records egress:none");
  assert.equal(snap.records[1].provider, "openai");
  assert.deepEqual(snap.records[1].egress, ["api.openai.com"]);
  // verbatim off by default → only the hash, never the text
  const flat = fs.readFileSync(auditFile, "utf8");
  assert.ok(!flat.includes("cloud question"), "verbatim text not stored by default");
  assert.ok(snap.records[1].questionSha256.length === 64, "sha256 recorded");
});

test("verbatim question is opt-in", () => {
  reset({ auditEnabled: true, auditVerbatim: true });
  record("secret question text", "local", []);
  const snap = recentAudit(10);
  assert.equal(snap.records[0].question, "secret question text");
});

test("choke point records only hosts dialed during the answer", () => {
  reset({ auditEnabled: true });
  resetEgressForTests();
  // A sentinel host no other test records → race-immune membership assertion.
  const before = beginAudit();
  recordEgress("https://audit-sentinel.example/v1/chat", PURPOSE_AI_PROVIDER);
  finishAudit(before, {
    question: "cloud q",
    provider: "openai",
    fileIds: ["budget.md"],
    artifacts: [],
  });
  const snap = recentAudit(1);
  assert.ok(
    snap.records[0].egress.includes("audit-sentinel.example"),
    `dialed host recorded: ${JSON.stringify(snap.records[0].egress)}`,
  );
  resetEgressForTests();
});

test("policy auditLog:'on' forces the log on with the pref off", () => {
  reset({}); // pref OFF
  assert.equal(verifyActiveAudit().count, 0);
  const pol = path.join(dir, "policy.json");
  fs.writeFileSync(pol, JSON.stringify({ auditLog: "on" }));
  process.env.LIGHTHOUSE_POLICY_FILE = pol;
  policy.resetPolicyForTests();

  record("forced by policy", "local", []);
  const snap = recentAudit(10);
  assert.equal(snap.enabled, true, "policy forces enabled() even with the pref off");
  assert.equal(snap.records.length, 1);

  delete process.env.LIGHTHOUSE_POLICY_FILE;
  policy.resetPolicyForTests();
});

test("CSV export has the reporting columns and escapes commas", () => {
  reset({ auditEnabled: true, auditVerbatim: true });
  record("a, b, c", "openai", ["api.openai.com"]);
  const csv = exportCsvAudit();
  const [header, row] = csv.trim().split("\n");
  assert.equal(header, "ts,provider,fileIds,egress,artifacts,question");
  assert.ok(row.includes("openai"));
  assert.ok(row.includes("api.openai.com"));
  assert.ok(row.includes('"a, b, c"'), "a field with commas is quoted");
});
