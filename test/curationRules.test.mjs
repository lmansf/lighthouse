/**
 * Bulk curation rules (openspec: add-curation-rules) in the TS twin. Mirrors
 * native/crates/lighthouse-core/tests/curation_rules_test.rs: the precedence
 * contract (explicit own flag + ancestor exclusion beat rules; deepest scope
 * then last-defined; `clear` masks and yields the default), the predicates
 * (kind / ext / glob — with the twin's honest kind degradation), add-time
 * validation, non-surprising removal, the byte-pinned cross-engine parity
 * fixture (the SAME tree + rules as the Rust twin resolving the SAME effective
 * sets), and the end-to-end future arrival: a rule exists, a NEW matching file
 * lands, and it resolves with the rule's flags — with NO per-node write in
 * state.json — while the inspector names the rule.
 *
 * Run: `node --test test/curationRules.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

register("./_ts-extensionless-hook.mjs", import.meta.url);

/** A throwaway vault; files start EXCLUDED (the conservative default). */
function freshVault() {
  const home = mkdtempSync(path.join(tmpdir(), "lh-rules-"));
  const vault = path.join(home, "vault");
  mkdirSync(path.join(vault, ".rag-vault"), { recursive: true });
  process.env.VAULT_DIR = vault;
  delete process.env.LIGHTHOUSE_APP_STATE_DIR;
  return vault;
}

/** A synthetic VaultState for the pure resolver tests (no disk involved). */
function state(rules, extra = {}) {
  return { sourceAvailable: true, included: {}, localOnly: {}, references: {}, rules, ...extra };
}

const kindRule = (id, scope, kind, action) => ({ id, scope, kind, action });
const extRule = (id, scope, ext, action) => ({ id, scope, ext, action });
const globRule = (id, scope, glob, action) => ({ id, scope, glob, action });

const vaultMod = await import("../src/server/vault.ts");
const { isEffectivelyIncluded, isEffectivelyLocalOnly, ruleDisplayName } = vaultMod;

// --- Precedence (pure resolvers over synthetic state) -----------------------------

test("explicit own flag beats any rule; ancestor exclusion is inviolable", () => {
  const st = state([extRule("r1", "reports", ["xlsx"], "include")]);
  assert.equal(isEffectivelyIncluded("reports/q.xlsx", st, false, true), true, "rule decides");
  st.included["reports/q.xlsx"] = false;
  assert.equal(
    isEffectivelyIncluded("reports/q.xlsx", st, false, true),
    false,
    "a hand-excluded file stays excluded",
  );

  const st2 = state([extRule("r1", "", ["md"], "exclude")], { included: { "notes.md": true } });
  assert.equal(isEffectivelyIncluded("notes.md", st2, false, true), true, "hand-included survives");

  // Spec scenario: rules cannot resurrect an excluded subtree.
  const st3 = state([globRule("r1", "archive", "**", "include")], {
    included: { archive: false },
  });
  for (const defaultIn of [false, true]) {
    assert.equal(isEffectivelyIncluded("archive/deep/file.md", st3, defaultIn, true), false);
  }
});

test("deepest scope wins, then last-defined; clear masks and yields the default", () => {
  // Spec scenario — with a shared-fidelity predicate (ext) since kind:"image"
  // deliberately matches nothing in this twin (OCR is Rust-only).
  const st = state([
    extRule("root", "", ["png"], "exclude"),
    extRule("design", "design", ["png"], "include"),
  ]);
  assert.equal(isEffectivelyIncluded("design/logo.png", st, true, true), true);
  assert.equal(isEffectivelyIncluded("misc/photo.png", st, true, true), false);

  const st2 = state([extRule("a", "", ["txt"], "include"), extRule("b", "", ["txt"], "exclude")]);
  assert.equal(isEffectivelyIncluded("a.txt", st2, false, true), false, "last-defined wins");

  const st3 = state([
    kindRule("inc", "reports", "tabular", "include"),
    kindRule("clr", "reports/private", "tabular", "clear"),
  ]);
  assert.equal(isEffectivelyIncluded("reports/q.xlsx", st3, false, true), true);
  assert.equal(
    isEffectivelyIncluded("reports/private/salary.xlsx", st3, false, true),
    false,
    "clear masks the include and falls to the exclude default",
  );
  assert.equal(
    isEffectivelyIncluded("reports/private/salary.xlsx", st3, true, true),
    true,
    "clear yields the include default when that is the global setting",
  );
});

test("folders never take the rule layer", () => {
  const st = state([globRule("r1", "", "**", "include")]);
  assert.equal(isEffectivelyIncluded("reports/q.md", st, false, true), true);
  assert.equal(isEffectivelyIncluded("reports", st, false, false), false);
  assert.equal(isEffectivelyLocalOnly("reports", st, false), false);
});

test("local-only axis: explicit beats rules; clear unmarks rule-marked files only", () => {
  const st = state([globRule("lo", "hr", "**", "local-only")]);
  assert.equal(isEffectivelyLocalOnly("hr/salaries.xlsx", st, true), true, "rule marks");
  assert.equal(isEffectivelyLocalOnly("public/notes.md", st, true), false);

  // A rule NEVER removes an explicit mark…
  st.localOnly["hr/salaries.xlsx"] = true;
  st.rules.push(globRule("clr", "hr", "salaries.xlsx", "clear"));
  assert.equal(isEffectivelyLocalOnly("hr/salaries.xlsx", st, true), true);
  // …and an explicit own false ("allow cloud") shields the file from rules.
  st.localOnly["hr/handbook.md"] = false;
  assert.equal(isEffectivelyLocalOnly("hr/handbook.md", st, true), false);
  // An ancestor's explicit mark still wins over everything (as shipped).
  const st2 = state([globRule("clr", "hr", "**", "clear")], { localOnly: { hr: true } });
  assert.equal(isEffectivelyLocalOnly("hr/anything.md", st2, true), true);

  // clear DOES mask a broader local-only rule where nothing is explicit.
  const st3 = state([
    globRule("lo", "hr", "**", "local-only"),
    globRule("clr", "hr/public", "**", "clear"),
  ]);
  assert.equal(isEffectivelyLocalOnly("hr/salaries.xlsx", st3, true), true);
  assert.equal(isEffectivelyLocalOnly("hr/public/faq.md", st3, true), false);
});

// --- Predicates --------------------------------------------------------------------

test("predicates: kind (with the twin's honest degradation), ext, glob", () => {
  // kind:"tabular" — full fidelity (same set as the catalog gate).
  const st = state([kindRule("t", "", "tabular", "include")]);
  for (const f of ["a.csv", "b.tsv", "c.parquet", "d.xlsx", "e.xlsm", "f.xls", "G.XLSX"]) {
    assert.equal(isEffectivelyIncluded(f, st, false, true), true, `${f} is tabular`);
  }
  assert.equal(isEffectivelyIncluded("notes.md", st, false, true), false);

  // kind:"document" — the subset THIS twin extracts or reads; .doc/.pptx/.odt/
  // .odp/.rtf are name-match-only here so they deliberately DON'T match
  // (PARITY: the Rust engine extracts them and does match).
  const st2 = state([kindRule("d", "", "document", "include")]);
  for (const f of ["a.pdf", "b.docx", "c.md", "d.txt", "e.html"]) {
    assert.equal(isEffectivelyIncluded(f, st2, false, true), true, `${f} is a document here`);
  }
  for (const f of ["e.rtf", "f.odt", "g.pptx", "h.doc"]) {
    assert.equal(
      isEffectivelyIncluded(f, st2, false, true),
      false,
      `${f} is name-match-only in the twin — kind rules don't match it`,
    );
  }

  // kind:"image" — OCR is Rust-only, so image rules match NOTHING here.
  const st3 = state([kindRule("i", "", "image", "include")]);
  for (const f of ["a.png", "b.jpg", "c.tiff"]) {
    assert.equal(isEffectivelyIncluded(f, st3, false, true), false, `${f} stays default`);
  }

  // ext list: dot-less lowercase entries; extension-less files never match.
  const st4 = state([extRule("e", "", ["xlsx", "csv"], "include")]);
  assert.equal(isEffectivelyIncluded("Q3 Sales.XLSX", st4, false, true), true);
  assert.equal(isEffectivelyIncluded("data.csv", st4, false, true), true);
  assert.equal(isEffectivelyIncluded("notes.md", st4, false, true), false);
  assert.equal(isEffectivelyIncluded("README", st4, false, true), false);

  // glob is relative to the SCOPE, not the vault root.
  const st5 = state([globRule("g", "reports", "2024/*.xlsx", "include")]);
  assert.equal(isEffectivelyIncluded("reports/2024/q1.xlsx", st5, false, true), true);
  assert.equal(isEffectivelyIncluded("reports/2023/q1.xlsx", st5, false, true), false);
  assert.equal(isEffectivelyIncluded("2024/q1.xlsx", st5, false, true), false);

  // The vault-root scope covers vault-resident ids only — a linked (extN)
  // subtree is its own folder scope.
  const st6 = state([globRule("g", "", "**", "include")], {
    references: { ext0: { path: "/x", name: "x", kind: "folder" } },
  });
  assert.equal(isEffectivelyIncluded("loose.md", st6, false, true), true);
  assert.equal(isEffectivelyIncluded("ext0/inside.md", st6, false, true), false);
  st6.rules.push(globRule("g2", "ext0", "**", "include"));
  assert.equal(isEffectivelyIncluded("ext0/inside.md", st6, false, true), true);
});

/** PARITY FIXTURE — mirrored in vault.rs rule_glob_tests::glob_matcher_table:
 *  identical verdicts in both engines, probed through the resolver. */
test("glob matcher parity table", () => {
  const matches = (glob, rel) =>
    isEffectivelyIncluded(rel, state([globRule("g", "", glob, "include")]), false, true);
  assert.equal(matches("*.xlsx", "q1.xlsx"), true);
  assert.equal(matches("*.xlsx", "2024/q1.xlsx"), false, "single-segment * never crosses /");
  assert.equal(matches("q?.csv", "q1.csv"), true);
  assert.equal(matches("q?.csv", "q10.csv"), false);
  assert.equal(matches("**/*.xlsx", "q1.xlsx"), true, "** spans zero segments");
  assert.equal(matches("**/*.xlsx", "2024/deep/q1.xlsx"), true);
  assert.equal(matches("**", "anything/at/all.txt"), true);
  assert.equal(matches("2024/**/final.md", "2024/final.md"), true);
  assert.equal(matches("2024/**/final.md", "2024/a/b/final.md"), true);
  assert.equal(matches("2024/**/final.md", "2023/final.md"), false);
  assert.equal(matches("drafts/*", "drafts/x.md"), true);
  assert.equal(matches("drafts/*", "Drafts/x.md"), false, "literals are case-sensitive");
  assert.equal(matches("*a*a*a*a", "aaaaaaaa"), true, "backtracking-hostile stays correct");
  assert.equal(matches("*a*a*a*a", "bbbbbbbb"), false);
});

/** PARITY: byte-identical with vault.rs::rule_display_name. */
test("display names derive from predicate + scope (byte-identical with Rust)", () => {
  assert.equal(
    ruleDisplayName({ id: "r", scope: "reports", kind: "tabular", action: "include" }),
    "spreadsheets in /reports",
  );
  assert.equal(
    ruleDisplayName({ id: "r", scope: "", ext: ["xlsx", "csv"], action: "include" }),
    ".xlsx/.csv files in the vault",
  );
  assert.equal(
    ruleDisplayName({ id: "r", scope: "design/assets", glob: "**/*.png", action: "exclude" }),
    "files matching **/*.png in /design/assets",
  );
});

// --- Add-time validation -------------------------------------------------------------

test("addRule validates (whitelists, one predicate, glob parse) and mints ids", () => {
  freshVault();
  const { addRule, listRules } = vaultMod;
  assert.throws(() => addRule({ scope: "x", action: "banish", kind: "tabular" }), /action must be/);
  assert.throws(() => addRule({ scope: "x", action: "include" }), /exactly one/);
  assert.throws(
    () => addRule({ scope: "x", action: "include", kind: "tabular", glob: "**" }),
    /exactly one/,
  );
  assert.throws(
    () => addRule({ scope: "x", action: "include", kind: "spreadsheety" }),
    /kind must be/,
  );
  assert.throws(() => addRule({ scope: "x", action: "include", glob: "a**b" }), /invalid glob/);
  assert.throws(() => addRule({ scope: "x", action: "include", glob: "/lead" }), /invalid glob/);
  assert.throws(() => addRule({ scope: "x", action: "include", ext: [" "] }), /at least one/);
  assert.throws(() => addRule({ scope: "x", action: "include", ext: ["x/y"] }), /invalid extension/);
  assert.throws(() => addRule({ scope: "/x", action: "include", kind: "tabular" }), /invalid scope/);

  const rule = addRule({ scope: "reports", action: "include", ext: [".XLSX", "csv"] });
  assert.match(rule.id, /^r[0-9a-f]{8}$/, "short random id");
  assert.deepEqual(rule.ext, ["xlsx", "csv"], "extensions normalize to lowercase dot-less");
  assert.equal(listRules().length, 1);
});

// --- Removal reverts only what the rule decided ---------------------------------------

test("removing a rule reverts only rule-decided files; hand-set flags survive", () => {
  const vault = freshVault();
  const { addRule, removeRule, setIncluded, activeIncludedFileIds } = vaultMod;
  mkdirSync(path.join(vault, "reports"), { recursive: true });
  writeFileSync(path.join(vault, "reports", "auto.xlsx"), "a,b\n1,2\n");
  writeFileSync(path.join(vault, "reports", "hand.xlsx"), "a,b\n3,4\n");

  setIncluded("reports/hand.xlsx", true);
  const rule = addRule({ scope: "reports", kind: "tabular", action: "include" });
  assert.deepEqual(activeIncludedFileIds().sort(), ["reports/auto.xlsx", "reports/hand.xlsx"]);

  removeRule(rule.id);
  assert.deepEqual(
    activeIncludedFileIds(),
    ["reports/hand.xlsx"],
    "un-toggled files revert to the default; hand-toggled files keep their state",
  );
});

test("a rule's scope follows its folder through rename (like the flag maps)", () => {
  const vault = freshVault();
  const { addRule, renameNode, listRules, activeIncludedFileIds } = vaultMod;
  mkdirSync(path.join(vault, "reports"), { recursive: true });
  writeFileSync(path.join(vault, "reports", "q1.xlsx"), "a,b\n1,2\n");
  addRule({ scope: "reports", kind: "tabular", action: "include" });
  assert.deepEqual(activeIncludedFileIds(), ["reports/q1.xlsx"]);

  assert.equal(renameNode("reports", "ledgers").newId, "ledgers");
  assert.equal(listRules()[0].scope, "ledgers", "the rule followed its folder");
  assert.deepEqual(activeIncludedFileIds(), ["ledgers/q1.xlsx"]);
});

// --- Cross-engine parity (same fixture as the Rust twin) ------------------------------

test("parity: identical effective sets from the shared tree + rules", () => {
  const vault = freshVault();
  const { addRule, activeIncludedFileIds, shareableFileIds } = vaultMod;
  for (const [rel, text] of [
    ["loose.md", "loose notes"],
    ["q2.md", "quarterly two"],
    ["a.txt", "alpha"],
    ["reports/q1.xlsx", "a,b\n1,2\n"],
    ["reports/q2.csv", "a,b\n3,4\n"],
    ["reports/notes.md", "notes"],
    ["reports/private/salary.xlsx", "a,b\n5,6\n"],
  ]) {
    const abs = path.join(vault, ...rel.split("/"));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }

  // The SAME seven rules, in the SAME order, as the Rust twin.
  addRule({ scope: "", ext: ["md"], action: "include" });
  addRule({ scope: "reports", kind: "tabular", action: "include" });
  addRule({ scope: "reports/private", kind: "tabular", action: "clear" });
  addRule({ scope: "", glob: "**/q2.*", action: "exclude" });
  addRule({ scope: "", ext: ["txt"], action: "include" });
  addRule({ scope: "", ext: ["txt"], action: "exclude" });
  addRule({ scope: "reports", glob: "**", action: "local-only" });

  assert.deepEqual(
    activeIncludedFileIds().sort(),
    ["loose.md", "reports/notes.md", "reports/q1.xlsx", "reports/q2.csv"],
    "effective included set matches the Rust twin",
  );
  assert.deepEqual(shareableFileIds(false).sort(), [
    "loose.md",
    "reports/notes.md",
    "reports/q1.xlsx",
    "reports/q2.csv",
  ]);
  assert.deepEqual(shareableFileIds(true), ["loose.md"], "cloud path matches the Rust twin");
});

// --- End-to-end: the future arrival (spec scenario) -----------------------------------

test("a future arrival resolves by rule with no per-node write; the inspector names it", async () => {
  const vault = freshVault();
  const { addRule, addFile, listNodes, shareableFileIds, setIncluded } = vaultMod;
  const { inspect } = await import("../src/server/inspect.ts");
  mkdirSync(path.join(vault, "reports"), { recursive: true });

  // Create the spec's rule FIRST: "spreadsheets in /reports → include" (plus a
  // local-only rule so both axes ride the same arrival).
  const rule = addRule({ scope: "reports", kind: "tabular", action: "include" });
  const loRule = addRule({ scope: "reports", kind: "tabular", action: "local-only" });
  assert.equal(rule.name ?? undefined, undefined, "stored rules carry no name (derived on demand)");

  // A NEW matching file lands AFTER the rules exist — through the same write
  // path an upload takes (which announces itself to the walk cache).
  addFile("late.xlsx", Buffer.from("region,amount\nNE,1\n"), "reports");

  // The next walk resolves it with the rules' flags — no user action.
  const late = listNodes().find((n) => n.id === "reports/late.xlsx");
  assert.ok(late, "the arrival is walked");
  assert.equal(late.ragIncluded, true, "included on first appearance");
  assert.equal(late.localOnly, true, "local-only on first appearance");
  assert.deepEqual(shareableFileIds(true), [], "the cloud path withholds it");

  // NO per-node write: state.json's flag maps never mention the file.
  const raw = readFileSync(path.join(vault, ".rag-vault", "state.json"), "utf8");
  const stored = JSON.parse(raw);
  assert.deepEqual(stored.included, {}, `no inclusion flag written: ${raw}`);
  assert.deepEqual(stored.localOnly, {}, `no local-only flag written: ${raw}`);
  assert.equal(stored.rules.length, 2, "both rules persisted");

  // The inspector attributes both flags to the rules BY NAME.
  const inspection = await inspect("reports/late.xlsx");
  assert.equal(inspection.included, true);
  assert.deepEqual(inspection.includedBy, {
    source: "rule",
    ruleId: rule.id,
    ruleName: "spreadsheets in /reports",
  });
  assert.equal(inspection.localOnlyBy?.source, "rule");
  assert.equal(inspection.localOnlyBy?.ruleId, loRule.id);

  // An explicit toggle flips the attribution to "explicit" (and wins).
  setIncluded("reports/late.xlsx", false);
  const after = await inspect("reports/late.xlsx");
  assert.equal(after.included, false);
  assert.equal(after.includedBy?.source, "explicit");
});

// --- Migration tolerance ---------------------------------------------------------------

test("an old state.json (no rules key) loads rule-less with everything preserved", () => {
  const vault = freshVault();
  const { listRules, activeIncludedFileIds } = vaultMod;
  writeFileSync(path.join(vault, "a.md"), "alpha");
  writeFileSync(
    path.join(vault, ".rag-vault", "state.json"),
    JSON.stringify({ sourceAvailable: true, included: { "a.md": true }, references: {} }),
  );
  assert.deepEqual(listRules(), [], "no rules key ⇒ rule-less");
  assert.deepEqual(activeIncludedFileIds(), ["a.md"], "inclusion preserved");
});

// --- Listing enrichment (orphans + labels) ----------------------------------------------

test("rulesListing marks orphaned scopes and labels the vault root", () => {
  const vault = freshVault();
  const { addRule, rulesListing } = vaultMod;
  mkdirSync(path.join(vault, "reports"), { recursive: true });
  addRule({ scope: "reports", kind: "tabular", action: "include" });
  addRule({ scope: "gone", kind: "tabular", action: "include" });
  addRule({ scope: "", ext: ["md"], action: "include" });

  const listing = rulesListing();
  assert.equal(listing.length, 3);
  assert.equal(listing[0].orphaned, false);
  assert.equal(listing[0].scopeLabel, "reports");
  assert.equal(listing[0].name, "spreadsheets in /reports");
  assert.equal(listing[1].orphaned, true, "missing folder IS orphaned (kept for cleanup)");
  assert.equal(listing[2].orphaned, false, "the vault root always exists");
  assert.equal(listing[2].scopeLabel, "Vault");
});
