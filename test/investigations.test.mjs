// Investigations TS twin (src/server/investigations.ts) — mirrors the Rust
// integration tests (tests/investigations_test.rs) so the two engines stay
// byte-compatible: round trip, unknown-version/corrupt bak-on-write, the
// history-posture gate on conversation refs, duplicate-name rejection, the
// archive flag, and the §2 ask-context resolution (scope → attachments,
// local-only → cfg swap) plus its cross-engine retrieval-parity fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const inv = await import("../src/server/investigations.ts");
const pinsMod = await import("../src/server/pins.ts");
const policy = await import("../src/server/policy.ts");
const vaultMod = await import("../src/server/vault.ts");

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

// --- §2 ask-context resolution ----------------------------------------------

/** A mocked CLOUD model config — what modelConfig() yields for a keyed
 *  remote profile. The resolution must return it untouched except under a
 *  local-only investigation. */
function cloudCfg() {
  return { providerId: "anthropic", modelId: "claude-haiku-4-5", apiKey: "sk-test-cloud" };
}

// PARITY: investigations.rs mirrors this precedence table in its in-module
// scope_precedence_resolves_most_specific_wins test.
test("ask-context precedence: most-specific wins (pure resolver)", () => {
  const record = (scopeFileIds, providerPolicy, archived = false) => ({
    id: "inv-test",
    name: "T",
    createdMs: 1,
    archived,
    scopeFileIds,
    providerPolicy,
    conversationRefs: [],
    folderName: "T",
  });

  // Absent/unknown investigation → passthrough, no forced-local.
  assert.deepEqual(inv.resolveScopeAndPolicy(undefined, ["req.md"]), [["req.md"], false]);

  // Scope non-empty, request attachments empty → attachments := scope.
  const rec = record(["a.md", "b.md"], "default");
  assert.deepEqual(inv.resolveScopeAndPolicy(rec, []), [["a.md", "b.md"], false]);

  // Request attachments non-empty → they WIN; scope is not intersected
  // (c.md is outside the scope and still stands alone).
  assert.deepEqual(inv.resolveScopeAndPolicy(rec, ["c.md"]), [["c.md"], false]);

  // Empty scope = whole vault: attachments stay empty.
  assert.deepEqual(inv.resolveScopeAndPolicy(record([], "default"), []), [[], false]);

  // Dangling scope ids pass through UNTOUCHED — resolution never filters;
  // downstream candidate selection ignores unknown ids and the skip-note
  // honesty counts drops.
  assert.deepEqual(inv.resolveScopeAndPolicy(record(["gone.md", "a.md"], "default"), []), [
    ["gone.md", "a.md"],
    false,
  ]);

  // Archived records resolve exactly like live ones (never weaker).
  assert.deepEqual(inv.resolveScopeAndPolicy(record(["a.md"], "local-only", true), []), [
    ["a.md"],
    true,
  ]);

  // local-only forces local regardless of how attachments resolve.
  assert.deepEqual(inv.resolveScopeAndPolicy(record(["a.md"], "local-only"), ["c.md"]), [
    ["c.md"],
    true,
  ]);
});

test("resolveAskContext: scope applies, attachments win, local-only swaps the cfg", () => {
  freshVault();
  // Scope carries a dangling id on purpose — resolution must NOT filter.
  const scoped = inv.createInvestigation("Scoped", ["cases/a.md", "cases/gone.md"], "default");
  const sealed = inv.createInvestigation("Sealed", [], "local-only");

  // Default policy: scope becomes the attachments; the mocked cloud cfg
  // passes through UNTOUCHED (key included). No conversation refs yet, so
  // the recall preference (§3) is empty.
  let [atts, cfg, preferred] = inv.resolveAskContext(scoped.id, [], cloudCfg());
  assert.deepEqual(atts, ["cases/a.md", "cases/gone.md"], "dangling id kept");
  assert.deepEqual(cfg, cloudCfg(), "cfg passthrough");
  assert.deepEqual(preferred, [], "no refs ⇒ no recall preference");

  // Explicit per-ask attachments WIN; scope is not intersected.
  [atts] = inv.resolveAskContext(scoped.id, ["other/c.md"], cloudCfg());
  assert.deepEqual(atts, ["other/c.md"], "attachments override scope");

  // local-only: the mocked cloud cfg goes in, the LOCAL config comes out —
  // provider "local", the local model sentinel, no key — at the same
  // resolution point modelConfig() is consulted, so originOf() stamps
  // "device" and no cloud transport is ever constructed.
  [atts, cfg] = inv.resolveAskContext(sealed.id, [], cloudCfg());
  assert.deepEqual(atts, [], "empty scope = whole vault");
  assert.deepEqual(cfg, { providerId: "local", modelId: "lighthouse-local", apiKey: null });

  // Archived investigations resolve like live ones (never weaker).
  inv.setInvestigationArchived(sealed.id, true);
  [, cfg] = inv.resolveAskContext(sealed.id, [], cloudCfg());
  assert.equal(cfg.providerId, "local", "archived still enforces");

  // The investigation's conversation refs ride out as the recall preference
  // (§3) once recorded (history posture allowing).
  withPolicy(null, () => {
    inv.addInvestigationConversationRef(scoped.id, "c-91", true);
  });
  [, , preferred] = inv.resolveAskContext(scoped.id, [], cloudCfg());
  assert.deepEqual(preferred, ["c-91"], "conversationRefs become the preference");

  // Absent/blank/unknown investigation → passthrough, cfg untouched, no
  // recall preference.
  for (const missing of [undefined, "", "   ", "inv-nope"]) {
    const [passAtts, passCfg, passPreferred] = inv.resolveAskContext(
      missing,
      ["req.md"],
      cloudCfg(),
    );
    assert.deepEqual(passAtts, ["req.md"], `passthrough for ${JSON.stringify(missing)}`);
    assert.equal(passCfg.providerId, "anthropic");
    assert.deepEqual(passPreferred, [], "no investigation ⇒ empty preference");
  }
});

// --- Cross-engine parity (same fixture as the Rust twin) ---------------------

test("parity: scoped ask resolves identical retrieval candidate ids", async () => {
  // The byte-pinned §2 parity fixture. The Rust twin (tests/
  // investigations_test.rs parity_scoped_ask_retrieval_candidate_ids) builds
  // the SAME vault + investigation and asserts the SAME candidate ids: an
  // investigation scoped to 2 of 3 fixture files yields a retrieval
  // candidate set of exactly those 2 — the out-of-scope decoy loses even
  // though it matches the query best.
  const stateDir = freshVault();
  const vault = path.dirname(stateDir);
  const write = (rel, text) => {
    const p = path.join(vault, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };
  write("cases/alpha.md", "the harbor ledger shows the missing shipment entries");
  write("cases/beta.md", "harbor ledger notes about the missing shipment manifest");
  write("cases/decoy.md", "missing shipment missing shipment harbor ledger decoy dossier");
  const all = ["cases/alpha.md", "cases/beta.md", "cases/decoy.md"];
  for (const id of all) vaultMod.setIncluded(id, true);

  const record = inv.createInvestigation(
    "Harbor case",
    ["cases/alpha.md", "cases/beta.md"],
    "default",
  );

  // Control (no investigation): the decoy is a candidate — it matches best.
  const open = await vaultMod.retrieve("missing shipment harbor ledger", all, 5, [], [], false);
  assert.ok(
    open.references.some((r) => r.fileId === "cases/decoy.md"),
    `unscoped ask sees the decoy: ${open.references.map((r) => r.fileId)}`,
  );

  // Scoped: resolution turns the scope into attachments; the candidate set
  // is exactly the scope, decoy excluded.
  const [atts] = inv.resolveAskContext(record.id, [], {
    providerId: null,
    modelId: null,
    apiKey: null,
  });
  const scoped = await vaultMod.retrieve("missing shipment harbor ledger", all, 5, [], atts, false);
  assert.deepEqual(
    scoped.references.map((r) => r.fileId).sort(),
    ["cases/alpha.md", "cases/beta.md"],
    "candidate ids match the Rust twin",
  );
});

// --- §3 belonging: pins, notes, recall ----------------------------------------

test("pins belong via investigationId and the view derives pinRefs", () => {
  // Mirrors investigations_test.rs::pins_belong_and_the_view_derives_pin_refs
  // (PARITY): old stores load uncategorized, membership rides addPin, the
  // filter narrows, the view derives, and a re-pin moves the membership.
  const stateDir = freshVault();
  fs.mkdirSync(stateDir, { recursive: true });

  // A store written BEFORE the field existed (no investigationId anywhere).
  fs.writeFileSync(
    path.join(stateDir, "pins.json"),
    '{"pins":[{"id":"pin-legacy000001","question":"legacy pin","sql":"SELECT 1","fileIds":["a.csv"],"createdMs":7}]}',
  );
  const legacy = pinsMod.listPins();
  assert.equal(legacy.length, 1, "old stores still load");
  assert.equal(legacy[0].investigationId, undefined, "…and stay uncategorized");

  const created = inv.createInvestigation("Q3 audit", [], "default");

  // One pin inside the investigation, one global, plus a blank id that must
  // normalize to uncategorized.
  const member = pinsMod.addPin("member?", "SELECT 2", ["a.csv"], created.id);
  assert.equal(member.investigationId, created.id);
  const global = pinsMod.addPin("global?", "SELECT 3", []);
  assert.equal(global.investigationId, undefined);
  const blank = pinsMod.addPin("blank?", "SELECT 4", [], "  ");
  assert.equal(blank.investigationId, undefined, "blank id = uncategorized");

  // Round trip: re-read from disk, fields intact; the raw store carries
  // investigationId ONLY on the member pin (absent = omitted, so legacy
  // pins keep round-tripping byte-compatibly).
  const listed = pinsMod.listPins();
  assert.equal(listed.length, 4);
  assert.equal(listed.find((p) => p.id === member.id).investigationId, created.id);
  assert.equal(listed.find((p) => p.id === "pin-legacy000001").investigationId, undefined);
  const raw = fs.readFileSync(path.join(stateDir, "pins.json"), "utf8");
  assert.equal(raw.match(/"investigationId"/g).length, 1, raw);

  // The list filter narrows to the investigation; absent keeps "all".
  assert.equal(pinsMod.listPins().length, 4);
  const filtered = pinsMod.listPins(created.id);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, member.id);
  assert.deepEqual(pinsMod.listPins("inv-nope"), []);

  // The view derives pinRefs from the store — the member only.
  const views = inv.investigationsListing();
  assert.equal(views.length, 1);
  assert.deepEqual(views[0].pinRefs, [member.id]);

  // Re-pinning the same SQL from the GLOBAL context replaces the pin and
  // drops its membership (replace semantics, like every other field).
  const repinned = pinsMod.addPin("member?", "SELECT 2", ["a.csv"]);
  assert.equal(repinned.id, member.id, "same SQL ⇒ same pin id");
  assert.equal(repinned.investigationId, undefined);
  assert.deepEqual(inv.investigationsListing()[0].pinRefs, [], "membership followed the re-pin");
});

test("notes land under the investigation folder and the view derives noteRefs", () => {
  // Mirrors investigations_test.rs::
  // notes_land_under_the_investigation_folder_and_derive_note_refs (PARITY,
  // identical error strings).
  const stateDir = freshVault();
  const vault = path.dirname(stateDir);

  const created = inv.createInvestigation("Harbor case", [], "default");
  const subdir = inv.investigationNotesSubdir(created.id);
  assert.equal(subdir, "Lighthouse Notes/Harbor case");

  // Export through the resolved folder (what the exportChat op does) plus
  // one GLOBAL note — membership = location, so only the first derives.
  const note = vaultMod.writeArtifact(subdir, "Findings so far", "md", Buffer.from("# findings"));
  assert.equal(note.id, `Lighthouse Notes/Harbor case/${note.name}`);
  assert.ok(fs.existsSync(path.join(vault, note.id)), "written inside the vault");
  vaultMod.writeArtifact("Lighthouse Notes", "Global note", "md", Buffer.from("# global"));

  const views = inv.investigationsListing();
  assert.deepEqual(views[0].noteRefs, [note.id], "prefix scan, member only");

  // Unknown ids reject — a silently-global note would lose its membership.
  assert.throws(() => inv.investigationNotesSubdir("inv-nope"), /investigation not found/);

  // Validate-at-use: hand-tamper the store (the API's sanitizer can't be
  // driven to these) — a traversal segment, and the reserved G6 "Chats"
  // folder. Neither resolves; neither derives notes.
  fs.writeFileSync(
    path.join(stateDir, "investigations.json"),
    `{"v":1,"investigations":[
      {"id":"inv-evil","name":"Evil","createdMs":1,"archived":false,"scopeFileIds":[],"providerPolicy":"default","conversationRefs":[],"folderName":"../evil"},
      {"id":"inv-chats","name":"Chats twin","createdMs":2,"archived":false,"scopeFileIds":[],"providerPolicy":"default","conversationRefs":[],"folderName":"Chats"}
    ]}`,
  );
  assert.throws(
    () => inv.investigationNotesSubdir("inv-evil"),
    /investigation folder name is not usable/,
    "traversal attempt rejected",
  );
  assert.throws(
    () => inv.investigationNotesSubdir("inv-chats"),
    /investigation folder name is not usable/,
    "the G6 Chats folder can never be aliased",
  );
  for (const view of inv.investigationsListing()) {
    assert.deepEqual(view.noteRefs, [], "unusable folders derive nothing");
  }
});

test("parity: recall prefers the investigation's conversation notes, same order", async () => {
  // The byte-pinned §3 parity fixture. The Rust twin (tests/
  // investigations_test.rs recall_prefers_the_investigations_conversation_
  // notes) builds the SAME two conversation notes and asserts the SAME
  // reference ORDER: identical bodies score equally on a recall-cued ask;
  // naming one conversation as preferred ranks its note FIRST while the
  // other still surfaces (preference, not exclusion). The preferred ids are
  // the RAW conversation ids — matching the filenames' [cid8] proves
  // retrieve reuses writeConversationNote's exact derivation.
  freshVault();

  const body = Buffer.from(
    "We concluded the missing shipment was rerouted through the harbor depot.",
  );
  const alpha = vaultMod.writeConversationNote("conv-alpha", "Alpha thread", body);
  const beta = vaultMod.writeConversationNote("conv-beta", "Beta thread", body);
  vaultMod.setIncluded(alpha.id, true);
  vaultMod.setIncluded(beta.id, true);
  const all = [alpha.id, beta.id];

  // The recall-cued probe ("what did i conclude…" fires the cue; the topic
  // tokens hit both bodies equally).
  const query = "what did i conclude about the missing shipment?";
  const refIds = async (preferred) =>
    (await vaultMod.retrieve(query, all, 5, [], [], false, preferred)).references.map(
      (r) => r.fileId,
    );

  // No preference: both conversation notes surface (equal scores).
  const open = await refIds([]);
  assert.ok(open.includes(alpha.id) && open.includes(beta.id), `${open}`);

  // Preferring one conversation ranks ITS note first — and flipping the
  // preference flips the order, so it is the preference (not name or
  // insertion luck) that decides. The global note is still present.
  const preferAlpha = await refIds(["conv-alpha"]);
  assert.equal(preferAlpha[0], alpha.id, `preferred first: ${preferAlpha}`);
  assert.ok(preferAlpha.includes(beta.id), `global still surfaces: ${preferAlpha}`);

  const preferBeta = await refIds(["conv-beta"]);
  assert.equal(preferBeta[0], beta.id, `flipped preference flips order: ${preferBeta}`);
  assert.ok(preferBeta.includes(alpha.id), `preference never excludes: ${preferBeta}`);
});
