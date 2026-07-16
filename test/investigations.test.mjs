// Investigations TS twin (src/server/investigations.ts) — mirrors the Rust
// integration tests (tests/investigations_test.rs) so the two engines stay
// byte-compatible: round trip, unknown-version/corrupt bak-on-write, the
// history-posture gate on conversation refs, duplicate-name rejection, and
// the archive flag.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const inv = await import("../src/server/investigations.ts");
const policy = await import("../src/server/policy.ts");

/** Fresh vault per test — stateDir() re-reads VAULT_DIR on every call. */
function freshVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-inv-"));
  process.env.VAULT_DIR = dir;
  return path.join(dir, ".rag-vault");
}

/** Same seam as policy.test.mjs: point policy at a file (null = absent). */
function withPolicy(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-inv-policy-"));
  const file = path.join(dir, "policy.json");
  if (content !== null) fs.writeFileSync(file, content);
  process.env.LIGHTHOUSE_POLICY_FILE = file;
  policy.resetPolicyForTests();
  try {
    fn();
  } finally {
    delete process.env.LIGHTHOUSE_POLICY_FILE;
    policy.resetPolicyForTests();
  }
}

function bakFiles(stateDir) {
  return fs
    .readdirSync(stateDir)
    .filter((n) => n.startsWith("investigations.json.bak-"))
    .map((n) => path.join(stateDir, n));
}

test("round trip is byte-stable (v1 envelope, camelCase, field order)", () => {
  const stateDir = freshVault();
  const scope = ["reports/a.pdf", "reports/b.csv"];
  const created = inv.createInvestigation("Q3 audit", scope, "local-only");
  assert.ok(created.id.startsWith("inv-"), created.id);
  assert.equal(created.folderName, "Q3 audit");

  // Re-read from disk: every stored field returns as written.
  const listed = inv.listInvestigations();
  assert.equal(listed.length, 1);
  const rec = listed[0];
  assert.equal(rec.id, created.id);
  assert.equal(rec.name, "Q3 audit");
  assert.equal(rec.createdMs, created.createdMs);
  assert.equal(rec.archived, false);
  assert.deepEqual(rec.scopeFileIds, scope);
  assert.equal(rec.providerPolicy, "local-only");
  assert.deepEqual(rec.conversationRefs, []);

  // The on-disk envelope is the byte contract with the Rust engine: v1,
  // then the records, camelCase keys in declaration order, 2-space pretty.
  const raw = fs.readFileSync(path.join(stateDir, "investigations.json"), "utf8");
  assert.ok(raw.startsWith('{\n  "v": 1,\n  "investigations": ['), raw);
  const keys = [
    '"id"',
    '"name"',
    '"createdMs"',
    '"archived"',
    '"scopeFileIds"',
    '"providerPolicy"',
    '"conversationRefs"',
    '"folderName"',
  ];
  for (let i = 1; i < keys.length; i++) {
    const [a, b] = [raw.indexOf(keys[i - 1]), raw.indexOf(keys[i])];
    assert.ok(a >= 0 && b >= 0 && a < b, `${keys[i - 1]} must precede ${keys[i]}`);
  }
  assert.ok(raw.includes('"providerPolicy": "local-only"'), raw);

  // The wire view enriches with DERIVED memberships — empty until §3/§4.
  const views = inv.investigationsListing();
  assert.equal(views.length, 1);
  assert.deepEqual(views[0].pinRefs, []);
  assert.deepEqual(views[0].noteRefs, []);
});

test("unknown envelope version loads empty and baks on the next write", () => {
  const stateDir = freshVault();
  fs.mkdirSync(stateDir, { recursive: true });
  const newer = '{"v":99,"investigations":[{"id":"inv-from-the-future"}]}';
  fs.writeFileSync(path.join(stateDir, "investigations.json"), newer);

  // Session reads empty — never a crash, never a partial parse.
  assert.deepEqual(inv.listInvestigations(), [], "v99 loads empty");

  // The first write preserves the unreadable file, then writes fresh v1.
  inv.createInvestigation("Fresh", [], "default");
  const baks = bakFiles(stateDir);
  assert.equal(baks.length, 1, `exactly one bak: ${baks}`);
  assert.equal(fs.readFileSync(baks[0], "utf8"), newer, "newer data recoverable byte-for-byte");
  const parsed = JSON.parse(fs.readFileSync(path.join(stateDir, "investigations.json"), "utf8"));
  assert.equal(parsed.v, 1);
  assert.equal(parsed.investigations[0].name, "Fresh");
  assert.equal(inv.listInvestigations().length, 1);
});

test("corrupt JSON loads empty and baks on the next write", () => {
  const stateDir = freshVault();
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "investigations.json"), "{ not json");

  assert.deepEqual(inv.listInvestigations(), [], "corrupt loads empty");
  inv.createInvestigation("After corruption", [], "default");
  const baks = bakFiles(stateDir);
  assert.equal(baks.length, 1, `corrupt file preserved: ${baks}`);
  assert.equal(fs.readFileSync(baks[0], "utf8"), "{ not json");
  assert.equal(inv.listInvestigations().length, 1);
});

test("duplicate names are rejected case-insensitively", () => {
  freshVault();
  inv.createInvestigation("Alpha", [], "default");
  assert.throws(() => inv.createInvestigation("alpha", [], "default"), /already exists/);
  assert.throws(() => inv.createInvestigation("  Alpha  ", [], "default"), /already exists/);
  assert.throws(() => inv.createInvestigation("", [], "default"), /needs a name/);
  assert.throws(() => inv.createInvestigation("   ", [], "default"), /needs a name/);

  // Uniqueness spans ARCHIVED records too — unarchive must never collide.
  const alphaId = inv.listInvestigations()[0].id;
  inv.setInvestigationArchived(alphaId, true);
  assert.throws(() => inv.createInvestigation("ALPHA", [], "default"), /already exists/);
  inv.setInvestigationArchived(alphaId, false);

  // Rename obeys the same rule; its own name (a case change) is allowed and
  // the folder name + id stay fixed.
  const beta = inv.createInvestigation("Beta", [], "default");
  assert.throws(() => inv.renameInvestigation(beta.id, "ALPHA"), /already exists/);
  const renamed = inv.renameInvestigation(beta.id, "BETA");
  assert.equal(renamed.name, "BETA");
  assert.equal(renamed.folderName, "Beta", "folder name NEVER moves on rename");
  assert.equal(renamed.id, beta.id, "rename keeps the id");
  assert.throws(() => inv.renameInvestigation(beta.id, ""), /needs a name/);
  assert.throws(() => inv.renameInvestigation("inv-nope", "Gamma"), /not found/);
});

test("archive flag round-trips non-destructively", () => {
  freshVault();
  const scope = ["cases/cold.md"];
  const created = inv.createInvestigation("Cold case", scope, "default");
  withPolicy(null, () => {
    inv.addInvestigationConversationRef(created.id, "c-77", true);
  });

  const archived = inv.setInvestigationArchived(created.id, true);
  assert.equal(archived.archived, true);
  // Nothing cascades: the record stays listed with scope + refs intact.
  const rec = inv.listInvestigations()[0];
  assert.equal(rec.archived, true);
  assert.deepEqual(rec.scopeFileIds, scope);
  assert.deepEqual(rec.conversationRefs, ["c-77"]);

  const restored = inv.setInvestigationArchived(created.id, false);
  assert.equal(restored.archived, false);
  assert.deepEqual(restored.conversationRefs, ["c-77"], "restored fully");
  assert.throws(() => inv.setInvestigationArchived("inv-nope", true), /not found/);
});

test("history posture gates conversation refs (persistAllowed AND policy)", () => {
  freshVault();
  const created = inv.createInvestigation("Sensitive", [], "default");

  // Client verdict false ⇒ silent no-op, even with no managed policy.
  withPolicy(null, () => {
    const rec = inv.addInvestigationConversationRef(created.id, "c-1", false);
    assert.deepEqual(rec.conversationRefs, [], "persistAllowed=false is a no-op");
  });

  // Managed chatHistory off ⇒ no-op even when the client would persist —
  // while STRUCTURE writes keep landing (posture gates refs, not names).
  withPolicy('{"v":1,"chatHistory":"off"}', () => {
    const rec = inv.addInvestigationConversationRef(created.id, "c-1", true);
    assert.deepEqual(rec.conversationRefs, [], "policy history off is a no-op");
    const renamed = inv.renameInvestigation(created.id, "Sensitive, renamed");
    assert.equal(renamed.name, "Sensitive, renamed");
    assert.deepEqual(renamed.conversationRefs, []);
  });

  // Both allow ⇒ the ref lands exactly once (dedupe), and persists.
  withPolicy(null, () => {
    inv.addInvestigationConversationRef(created.id, "c-1", true);
    const rec = inv.addInvestigationConversationRef(created.id, "c-1", true);
    assert.deepEqual(rec.conversationRefs, ["c-1"], "deduped");
    assert.throws(() => inv.addInvestigationConversationRef("inv-nope", "c-2", true), /not found/);
    assert.throws(
      () => inv.addInvestigationConversationRef(created.id, "   ", true),
      /conversationId required/,
    );
  });
  assert.deepEqual(inv.listInvestigations()[0].conversationRefs, ["c-1"]);
});
