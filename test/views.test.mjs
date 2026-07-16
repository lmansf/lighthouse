// Shaped views TS twin (src/server/views.ts) — mirrors the Rust integration
// tests (tests/views_test.rs) so the two engines stay byte-compatible: round
// trip with derived reads, unknown-version/corrupt bak-on-write, the twin's
// textual guard (PARITY: guard_sql's parser is Rust-only), the name rules
// (reserved words, view/table collisions, sanitization), the FROM/JOIN reads
// scan (PARITY: the AST walk is Rust-only), unknown-table refusal, the DAG
// rules (depth cap, crafted-cycle refusal, synthetic-graph checkers), the
// lifecycle rules (rename/delete dependent refusals, cascade set in one
// write), and the sources-untouched invariant.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const views = await import("../src/server/views.ts");
const vault = await import("../src/server/vault.ts");

/** Fresh vault per test — stateDir() re-reads VAULT_DIR on every call. */
function freshVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-views-"));
  process.env.VAULT_DIR = dir;
  return { dir, stateDir: path.join(dir, ".rag-vault") };
}

/** A vault with one included sales.csv, ready for view creation. */
function seedSales(dir) {
  fs.writeFileSync(path.join(dir, "sales.csv"), "region,amount\nnorth,3\nsouth,7\n");
  vault.setIncluded("sales.csv", true);
}

const summary = (text) => ({ text, source: "question" });

function bakFiles(stateDir) {
  return fs
    .readdirSync(stateDir)
    .filter((n) => n.startsWith("views.json.bak-"))
    .map((n) => path.join(stateDir, n));
}

test("round trip is byte-stable with derived reads", () => {
  const { dir, stateDir } = freshVault();
  seedSales(dir);

  // Create from a Beam answer's meta: display name sanitizes, the file
  // dependency is derived from the SQL with its name binding pinned.
  const created = views.createView(
    "Top Regions",
    "SELECT region, SUM(amount) AS total FROM sales GROUP BY region",
    summary("which regions sell most"),
    ["sales.csv"],
  );
  assert.ok(created.id.startsWith("view-"), created.id);
  assert.equal(created.name, "top_regions", "name sanitized at save");
  assert.deepEqual(created.reads.files, [{ fileId: "sales.csv", tableName: "sales" }]);
  assert.deepEqual(created.reads.views, []);
  assert.deepEqual(created.summary, { text: "which regions sell most", source: "question" });
  assert.ok(created.createdMs > 0);

  // Re-read from disk: the identical record returns.
  const listed = views.listViews();
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0], created, "round trip preserves the record exactly");

  // A view over the view: the reference resolves by name to the saved id.
  const over = views.createView(
    "north only",
    "SELECT * FROM top_regions WHERE region = 'north'",
    summary("just the north"),
    [],
  );
  assert.deepEqual(over.reads.files, []);
  assert.deepEqual(over.reads.views, [created.id]);

  // The on-disk envelope is the byte contract with the Rust engine: v1,
  // then the records, camelCase keys in declaration order, 2-space pretty,
  // the summary source as a bare lowercase string.
  const raw = fs.readFileSync(path.join(stateDir, "views.json"), "utf8");
  assert.ok(raw.startsWith('{\n  "v": 1,\n  "views": ['), raw);
  for (const [a, b] of [
    ['"id"', '"name"'],
    ['"name"', '"sql"'],
    ['"sql"', '"reads"'],
    ['"reads"', '"summary"'],
    ['"summary"', '"createdMs"'],
    ['"fileId"', '"tableName"'],
    ['"text"', '"source"'],
  ]) {
    assert.ok(raw.indexOf(a) !== -1 && raw.indexOf(a) < raw.indexOf(b), `${a} precedes ${b}`);
  }
  // Within reads: files precede views (the envelope's own "views" key is
  // first in the file, so compare against the LAST "views" occurrence).
  assert.ok(raw.indexOf('"files"') < raw.lastIndexOf('"views"'));
  assert.ok(raw.includes('"source": "question"'), raw);
  assert.ok(raw.includes(`"views": [\n          "${created.id}"\n        ]`), raw);
});

test("unknown envelope version loads empty and baks on write", () => {
  const { stateDir } = freshVault();
  fs.mkdirSync(stateDir, { recursive: true });
  const newer = '{"v":99,"views":[{"id":"view-from-the-future"}]}';
  fs.writeFileSync(path.join(stateDir, "views.json"), newer);

  // Session reads empty — never a crash, never a partial parse.
  assert.deepEqual(views.listViews(), [], "v99 loads empty");

  // The first write preserves the unreadable file, then writes fresh v1.
  views.createView("fresh", "SELECT 1", summary("q"), []);
  const baks = bakFiles(stateDir);
  assert.equal(baks.length, 1, `exactly one bak: ${baks}`);
  assert.equal(fs.readFileSync(baks[0], "utf8"), newer, "newer data recoverable byte-for-byte");
  const parsed = JSON.parse(fs.readFileSync(path.join(stateDir, "views.json"), "utf8"));
  assert.equal(parsed.v, 1);
  assert.equal(parsed.views[0].name, "fresh");
  assert.equal(views.listViews().length, 1);
});

test("corrupt json loads empty and baks on write", () => {
  const { stateDir } = freshVault();
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "views.json"), "{ not json");

  assert.deepEqual(views.listViews(), [], "corrupt loads empty");
  views.createView("after", "SELECT 1", summary("q"), []);
  const baks = bakFiles(stateDir);
  assert.equal(baks.length, 1, `corrupt file preserved: ${baks}`);
  assert.equal(fs.readFileSync(baks[0], "utf8"), "{ not json");
  assert.equal(views.listViews().length, 1);
});

// PARITY: guard_sql's real parser is Rust-only; this twin's textual check is
// deliberately conservative and the desktop re-guards before every execution.
test("the textual guard refuses anything but one read-only SELECT", () => {
  const { stateDir } = freshVault();

  // The pure check, both verdicts (error strings match guard_sql's).
  assert.equal(views.guardViewSql("SELECT 1"), null);
  assert.equal(views.guardViewSql("  WITH t AS (SELECT 1) SELECT * FROM t"), null);
  assert.equal(views.guardViewSql("SELECT 1;"), null, "trailing terminator is fine");
  assert.equal(views.guardViewSql("SELECT 1; SELECT 2"), "expected exactly one SQL statement");
  assert.equal(views.guardViewSql(""), "expected exactly one SQL statement");
  assert.equal(views.guardViewSql("UPDATE sales SET amount = 0"), "only SELECT queries are allowed");
  assert.equal(views.guardViewSql("DROP TABLE sales"), "only SELECT queries are allowed");
  for (const embedded of [
    "SELECT * FROM t WHERE id IN (DELETE FROM u)",
    "WITH x AS (INSERT INTO t VALUES (1)) SELECT 1",
    "SELECT set FROM t", // conservative: banned words refuse even as columns
    "SELECT replace(name, 'a', 'b') FROM t", // …and as scalar functions
  ]) {
    assert.equal(
      views.guardViewSql(embedded),
      "only read-only SELECT queries are allowed",
      embedded,
    );
  }
  // Keywords inside string literals and comments never trip the scan.
  assert.equal(views.guardViewSql("SELECT * FROM logs WHERE msg = 'DROP TABLE x'"), null);
  assert.equal(views.guardViewSql("SELECT 1 -- drop table x\nFROM logs"), null);
  assert.equal(views.guardViewSql("SELECT 1 /* update t */ FROM logs"), null);
  assert.equal(views.guardViewSql("SELECT * FROM t WHERE a = 'it''s; fine'"), null);

  // The guard runs at save: refusals persist nothing.
  assert.throws(
    () => views.createView("mutation", "UPDATE sales SET amount = 0", summary("q"), []),
    new Error("only SELECT queries are allowed"),
  );
  assert.throws(
    () => views.createView("two", "SELECT 1; SELECT 2", summary("q"), []),
    new Error("expected exactly one SQL statement"),
  );
  assert.deepEqual(views.listViews(), [], "refusals persist nothing");
  assert.ok(!fs.existsSync(path.join(stateDir, "views.json")), "no store file was ever written");
});

test("name rules reject reserved words, collisions, and empty names", () => {
  const { dir } = freshVault();
  seedSales(dir);

  // The normalization table (PARITY: views.rs unit tests mirror it).
  assert.equal(views.normalizeViewName("Top Sales"), "top_sales");
  assert.equal(views.normalizeViewName("Q3 Sales (final)"), "q3_sales_final");
  assert.equal(views.normalizeViewName("q3.totals"), "q3_totals", "no extension strip");
  assert.equal(views.normalizeViewName("2024 totals"), "t_2024_totals");
  assert.equal(views.normalizeViewName("  __weird -- name__  "), "weird_name");
  assert.equal(views.normalizeViewName("!!!"), "");
  assert.equal(views.normalizeViewName("a".repeat(80)).length, 64, "64-char cap");
  assert.equal(views.normalizeViewName(`${"a".repeat(63)}_x`), "a".repeat(63));

  // …and the file-name pipeline it derives from (KEEP IN SYNC checks).
  assert.equal(views.sanitizeTableName("Q3 Sales (final).xlsx"), "q3_sales_final");
  assert.equal(views.sanitizeTableName("2024.csv"), "t_2024");
  assert.equal(views.sanitizeTableName("!!!.csv"), "table");
  assert.equal(views.uniqueTableName("report", []), "report");
  assert.equal(views.uniqueTableName("report", ["report"]), "report_2");
  assert.equal(views.uniqueTableName("report", ["report", "report_2"]), "report_3");

  // Reserved keywords, checked AFTER normalization ("  SELECT " → select).
  for (const reserved of ["select", "  SELECT ", "table", "With"]) {
    assert.throws(
      () => views.createView(reserved, "SELECT 1", summary("q"), []),
      /is a reserved word/,
      reserved,
    );
  }
  // Unusable (empty after sanitization) names.
  for (const empty of ["", "   ", "!!!"]) {
    assert.throws(
      () => views.createView(empty, "SELECT 1", summary("q"), []),
      new Error("a view needs a name"),
      JSON.stringify(empty),
    );
  }

  // Case-insensitive collision with an existing view, sanitize-aware.
  views.createView("Top Sales", "SELECT 1", summary("q"), []);
  for (const taken of ["top_sales", "Top Sales", "top  SALES!"]) {
    assert.throws(
      () => views.createView(taken, "SELECT 1", summary("q"), []),
      new Error('a view named "top_sales" already exists'),
      taken,
    );
  }

  // Collision with a CURRENT catalog file table name (sales.csv → sales),
  // fetched by createView's public entry from the vault…
  assert.throws(
    () => views.createView("sales", "SELECT 1", summary("q"), []),
    new Error('a table named "sales" already exists in your files'),
  );
  // …and via the parameterized core with caller-supplied taken names.
  assert.throws(
    () => views.createViewWithTables("Q3 Report", "SELECT 1", summary("q"), [], ["q3_report"]),
    new Error('a table named "q3_report" already exists in your files'),
  );

  assert.equal(views.listViews().length, 1, "only the one valid create persisted");
});

// PARITY: the authoritative derivation is the Rust AST walk; this scan is
// the twin's conservative approximation.
test("the reads scan collects FROM/JOIN/comma lists and excludes CTEs", () => {
  const names = views.collectTableNames;
  assert.deepEqual(names("SELECT * FROM sales"), ["sales"]);
  assert.deepEqual(names("SELECT * FROM sales s JOIN costs c ON s.id = c.id"), [
    "sales",
    "costs",
  ]);
  assert.deepEqual(names("SELECT * FROM sales LEFT JOIN costs ON true"), ["sales", "costs"]);
  // Comma-separated FROM lists, bare and AS-aliased.
  assert.deepEqual(names("SELECT * FROM sales, costs"), ["sales", "costs"]);
  assert.deepEqual(names("SELECT * FROM sales AS s, costs AS c"), ["sales", "costs"]);
  assert.deepEqual(names("SELECT * FROM sales s, costs c WHERE s.id = c.id"), [
    "sales",
    "costs",
  ]);
  // CTE aliases are declarations, not dependencies.
  assert.deepEqual(names("WITH t AS (SELECT * FROM sales) SELECT * FROM t JOIN costs ON true"), [
    "sales",
    "costs",
  ]);
  assert.deepEqual(
    names("WITH a AS (SELECT 1), b AS (SELECT * FROM base) SELECT * FROM a JOIN b ON true"),
    ["base"],
  );
  // Parenthesized subqueries: the wrapper collects nothing, the inner
  // FROM matches the same global scan.
  assert.deepEqual(names("SELECT * FROM (SELECT * FROM inner_t) x"), ["inner_t"]);
  // UNION arms both scan; case-insensitive dedupe keeps the first spelling.
  assert.deepEqual(names("SELECT a FROM north UNION ALL SELECT a FROM south"), [
    "north",
    "south",
  ]);
  assert.deepEqual(names("SELECT a FROM sales UNION ALL SELECT a FROM SALES"), ["sales"]);
  // Dotted names ride whole (they resolve to nothing and get refused).
  assert.deepEqual(names("SELECT * FROM db.t"), ["db.t"]);
  // Quoted names are blanked with the literal scrub — nothing collected.
  assert.deepEqual(names('SELECT * FROM "My Table"'), []);

  // Unknown references refuse the save, naming the offender.
  const { dir } = freshVault();
  seedSales(dir);
  assert.throws(
    () =>
      views.createView("mystery", "SELECT * FROM sales JOIN nowhere ON true", summary("q"), [
        "sales.csv",
      ]),
    new Error("unknown table in definition: nowhere"),
  );
  assert.throws(
    () => views.createView("mystery", "SELECT * FROM sales", summary("q"), []),
    new Error("unknown table in definition: sales"),
  );
  assert.deepEqual(views.listViews(), []);
});

test("file table bindings replay the registration naming pipeline", () => {
  freshVault();
  // Same-stem files suffix-on-collision in fileIds order — the bindings
  // store exactly what register_tables would have named them.
  const created = views.createViewWithTables(
    "both reports",
    "SELECT * FROM report UNION ALL SELECT * FROM report_2",
    summary("q"),
    [
      { fileId: "a/report.csv", name: "report.csv" },
      { fileId: "b/report.csv", name: "report.csv" },
    ],
    [],
  );
  assert.deepEqual(created.reads.files, [
    { fileId: "a/report.csv", tableName: "report" },
    { fileId: "b/report.csv", tableName: "report_2" },
  ]);
});

test("depth beyond the cap and cycles are refused at save", () => {
  const { dir, stateDir } = freshVault();
  seedSales(dir);

  views.createView("lvl1", "SELECT * FROM sales", summary("q"), ["sales.csv"]);
  views.createView("lvl2", "SELECT * FROM lvl1", summary("q"), []);
  views.createView("lvl3", "SELECT * FROM lvl2", summary("q"), []);
  assert.throws(
    () => views.createView("lvl4", "SELECT * FROM lvl3", summary("q"), []),
    new Error("view depth is capped at 3"),
  );
  assert.equal(views.listViews().length, 3, "the refused layer never persisted");
  views.createView("side", "SELECT * FROM lvl1", summary("q"), []); // shallow is fine

  // The pure checkers on synthetic graphs (KEEP IN SYNC with views.rs).
  const mk = (id, readViews) => ({
    id,
    name: id,
    sql: "SELECT 1",
    reads: { files: [], views: readViews },
    summary: summary(""),
    createdMs: 1,
  });
  // b → a, and a carries a manual edge to the id the NEW view would get.
  assert.ok(views.wouldCycle([mk("a", ["view-new"]), mk("b", ["a"])], "view-new", ["b"]));
  // Reading the new view's own id directly is a self-cycle.
  assert.ok(views.wouldCycle([], "view-new", ["view-new"]));
  // A hand-crafted store that is ALREADY cyclic trips the back-edge check.
  assert.ok(views.wouldCycle([mk("a", ["b"]), mk("b", ["a"])], "view-new", ["a"]));
  // A diamond (b and c both read d) is legal DAG shape, NOT a cycle.
  const diamond = [mk("d", []), mk("b", ["d"]), mk("c", ["d"])];
  assert.ok(!views.wouldCycle(diamond, "view-new", ["b", "c"]));
  assert.ok(!views.wouldCycle(diamond, "view-new", []));
  assert.equal(views.viewDepth(diamond, ["b", "c"]), 3, "max of the arms, not the sum");
  assert.equal(views.viewDepth(diamond, []), 1, "files only");
  assert.ok(views.viewDepth([mk("a", ["b"]), mk("b", ["a"])], ["a"]) > views.MAX_VIEW_DEPTH);

  // A crafted cyclic STORE refuses a create that walks into the loop, and
  // the refusal leaves the store byte-identical.
  const crafted = JSON.stringify(
    {
      v: 1,
      views: [
        {
          id: "view-aaa", name: "alpha", sql: "SELECT * FROM beta",
          reads: { files: [], views: ["view-bbb"] },
          summary: { text: "q", source: "question" }, createdMs: 1,
        },
        {
          id: "view-bbb", name: "beta", sql: "SELECT * FROM alpha",
          reads: { files: [], views: ["view-aaa"] },
          summary: { text: "q", source: "question" }, createdMs: 2,
        },
      ],
    },
    null,
    2,
  );
  fs.writeFileSync(path.join(stateDir, "views.json"), crafted);
  assert.throws(
    () => views.createView("closer", "SELECT * FROM alpha", summary("q"), []),
    new Error("that definition would create a cycle"),
  );
  assert.equal(fs.readFileSync(path.join(stateDir, "views.json"), "utf8"), crafted);
});

test("rename refuses with dependents and otherwise updates in place", () => {
  const { dir } = freshVault();
  seedSales(dir);

  const base = views.createView("base", "SELECT * FROM sales", summary("q"), ["sales.csv"]);
  const mid = views.createView("mid", "SELECT * FROM base", summary("q"), []);
  views.createView("top_v", "SELECT * FROM mid", summary("q"), []);

  // Refused while ANY other view reads it — the message names the DIRECT
  // dependents (the definitions whose SQL uses this name).
  assert.throws(
    () => views.renameView(base.id, "renamed"),
    new Error('"base" can\'t be renamed while other views read it: mid'),
  );
  assert.equal(views.listViews()[0].name, "base", "refusal changed nothing");

  // Helpers the refusals and the UI lean on.
  assert.deepEqual(views.dependentsOf(base.id).map((d) => d.name), ["mid"]);
  assert.deepEqual(views.transitiveDependents(base.id).map((d) => d.name), ["mid", "top_v"]);

  // A leaf renames freely: sanitized, id stable, reads untouched everywhere.
  const peakId = views.listViews()[2].id;
  const renamed = views.renameView(peakId, "The Peak");
  assert.equal(renamed.name, "the_peak");
  assert.equal(renamed.id, peakId, "rename keeps the id");
  assert.deepEqual(renamed.reads.views, [mid.id], "reads untouched");
  assert.deepEqual(views.listViews()[1].reads.views, [base.id]);

  // The new name passes the create rules.
  assert.throws(() => views.renameView(peakId, "select"), new Error('"select" is a reserved word'));
  assert.throws(
    () => views.renameView(peakId, "MID"),
    new Error('a view named "mid" already exists'),
  );
  assert.throws(
    () => views.renameView(peakId, "sales"),
    new Error('a table named "sales" already exists in your files'),
  );
  assert.throws(() => views.renameView(peakId, "  "), new Error("a view needs a name"));
  assert.throws(() => views.renameView("view-nope", "x"), new Error("view not found"));
});

test("delete refuses with the transitive list and cascades in one write", () => {
  const { dir } = freshVault();
  seedSales(dir);

  const base = views.createView("base", "SELECT * FROM sales", summary("q"), ["sales.csv"]);
  const mid = views.createView("mid", "SELECT * FROM base", summary("q"), []);
  const top = views.createView("top_v", "SELECT * FROM mid", summary("q"), []);
  const other = views.createView("other", "SELECT * FROM sales", summary("q"), ["sales.csv"]);

  // Refused by default, naming the FULL transitive list (what the UI's
  // cascade confirmation must show), creation order.
  assert.throws(
    () => views.deleteView(base.id, false),
    new Error('"base" can\'t be deleted while other views read it: mid, top_v'),
  );
  assert.equal(views.listViews().length, 4, "refusal deleted nothing");

  // Cascade removes the view plus EXACTLY its transitive dependents in one
  // write; unrelated views survive.
  assert.deepEqual(views.deleteView(base.id, true), [base.id, mid.id, top.id]);
  const left = views.listViews();
  assert.equal(left.length, 1);
  assert.equal(left[0].id, other.id);

  // A leaf deletes without cascade; unknown ids refuse.
  assert.deepEqual(views.deleteView(other.id, false), [other.id]);
  assert.deepEqual(views.listViews(), []);
  assert.throws(() => views.deleteView(other.id, false), new Error("view not found"));
  assert.throws(() => views.deleteView("view-nope", true), new Error("view not found"));
});

test("source files are never touched by any op", () => {
  const { dir } = freshVault();
  const csv = path.join(dir, "sales.csv");
  fs.writeFileSync(csv, "region,amount\nnorth,3\nsouth,7\n");
  vault.setIncluded("sales.csv", true);
  const before = fs.readFileSync(csv);

  const base = views.createView(
    "shaped",
    "SELECT region, SUM(amount) AS total FROM sales GROUP BY region",
    summary("q"),
    ["sales.csv"],
  );
  views.createView("over", "SELECT * FROM shaped", summary("q"), []);
  views.renameView(views.listViews()[1].id, "renamed_over");
  assert.throws(() => views.createView("select", "SELECT 1", summary("q"), [])); // a refusal too
  views.deleteView(base.id, true);

  assert.ok(
    before.equals(fs.readFileSync(csv)),
    "source bytes identical after create/rename/refusal/cascade-delete",
  );
  assert.deepEqual(views.listViews(), []);
});

// --- §2: posture (local-only propagation, openspec: add-shaped-views) ---------------
// PARITY: views_test.rs::local_only_views_are_ineligible_on_cloud_asks — the
// resolution itself is Rust-only; the twin mirrors the posture helpers the
// cache key leans on.

test("local-only marks propagate to views transitively and gate the cloud posture", () => {
  const { dir } = freshVault();
  fs.writeFileSync(path.join(dir, "private.csv"), "region,amount\nNE,5\n");
  fs.writeFileSync(path.join(dir, "public.csv"), "region,amount\nSW,7\n");
  vault.setLocalOnly("private.csv", true);

  const priv = views.createView("private_view", "SELECT * FROM private", summary("q"), [
    "private.csv",
  ]);
  // A view OVER the marked view inherits the mark transitively.
  const over = views.createView("over_private", "SELECT COUNT(*) AS n FROM private_view", summary("q"), []);
  const pub_ = views.createView("public_view", "SELECT * FROM public", summary("q"), [
    "public.csv",
  ]);

  const records = views.listViews();
  assert.ok(views.viewEffectivelyLocalOnly(priv, records));
  assert.ok(
    views.viewEffectivelyLocalOnly(over, records),
    "the mark rides through the parent view",
  );
  assert.ok(!views.viewEffectivelyLocalOnly(pub_, records));

  // Posture: local sees everything; cloud sees only the unmarked view.
  assert.deepEqual(
    views.eligibleForPosture(false).map((v) => v.name),
    ["private_view", "over_private", "public_view"],
    "device posture keeps store order",
  );
  assert.deepEqual(
    views.eligibleForPosture(true).map((v) => v.name),
    ["public_view"],
    "cloud posture drops the marked chain",
  );

  // Unmarking flows straight through (state is read per call, never cached).
  vault.setLocalOnly("private.csv", false);
  assert.equal(views.eligibleForPosture(true).length, 3);
});

// --- §3: dispatch arms (openspec: add-shaped-views) ----------------------------------
// The twin's route (app/api/rag/route.ts) can't be invoked under node --test
// (NextResponse), so its guarantees are asserted structurally against the
// source — the boardsUi.test.mjs house style: the views CRUD arms round-trip
// through THIS module's fns, and shapeView answers {available:false} without
// ever touching the store or a model (PARITY: shaping is Rust-engine-only).

const routeSrc = fs.readFileSync(new URL("../app/api/rag/route.ts", import.meta.url), "utf8");

test("route.ts views arms round-trip through src/server/views.ts", () => {
  assert.match(routeSrc, /from "@\/server\/views"/, "the arms import this module");
  assert.match(routeSrc, /case "views": \{/, "the op exists");
  for (const fn of [
    "listViews()",
    "createView(",
    "renameView(",
    "deleteView(",
    "dependentsOf(",
    "transitiveDependents(",
  ]) {
    assert.ok(routeSrc.includes(fn), `${fn} is called by an arm`);
  }
  // The wire carries the summary FLATTENED; the arm builds the labeled record
  // and rejects an out-of-whitelist source with the engines' exact reason.
  assert.match(routeSrc, /summarySource must be "question" or "model"/);
  assert.match(routeSrc, /text: typeof body\.summaryText === "string" \? body\.summaryText : ""/);
  // Delete returns the deleted ids; cascade defaults false (absent = no).
  assert.match(routeSrc, /deletedIds: deleteView\(body\.id, body\.cascade === true\)/);
  // Dependents answers the NAME lists the rename/delete dialogs show.
  assert.match(routeSrc, /dependents: dependentsOf\(body\.id\)\.map\(\(v\) => v\.name\)/);
  assert.match(routeSrc, /transitive: transitiveDependents\(body\.id\)\.map\(\(v\) => v\.name\)/);
  // Refusals surface as 400 + the engine's reason (the boards idiom).
  assert.match(routeSrc, /views action must be list, create, rename, delete, or dependents/);
});

test("route.ts shapeView arm is the PARITY stub: available:false, nothing persisted", () => {
  const from = routeSrc.indexOf('case "shapeView"');
  assert.ok(from !== -1, "the op exists");
  const body = routeSrc.slice(from, routeSrc.indexOf('case "source"', from));
  assert.match(body, /available: false/);
  assert.match(
    body,
    /reason: "shaping runs in the Rust engine — this dev server can't execute SQL"/,
  );
  assert.doesNotMatch(body, /createView|writeJson|save\(/, "the stub persists nothing");
});
