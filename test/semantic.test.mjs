// Semantic-layer TS twin (src/server/semantic.ts) — mirrors the Rust
// integration tests (tests/semantic_test.rs) so the two engines stay
// byte-compatible: metric round trip with derived reads + the camelCase byte
// contract, unknown-version/corrupt bak-on-write, the twin's textual guard
// (PARITY: guard_sql's parser is Rust-only), the name rules (reserved words,
// metric collisions, sanitization), the FROM/JOIN reads scan, the
// unknown-entity refusal, the lifecycle rules (metric rename/delete refuse or
// cascade against dependent synonyms), the model-free resolver, and the
// local-only cloud-posture gate. PARITY: the column-catalog name-shadow check
// is Rust-only (the twin's createMetric passes no columns), and the twin never
// certifies/reconciles an answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const semantic = await import("../src/server/semantic.ts");
const vault = await import("../src/server/vault.ts");

/** Fresh vault per test — stateDir() re-reads VAULT_DIR on every call. */
function freshVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-semantic-"));
  process.env.VAULT_DIR = dir;
  return { dir, stateDir: path.join(dir, ".rag-vault") };
}

/** A vault with one included sales.csv (columns: region, amount). */
function seedSales(dir) {
  fs.writeFileSync(path.join(dir, "sales.csv"), "region,amount\nnorth,3\nsouth,7\n");
  vault.setIncluded("sales.csv", true);
}

const summary = (text) => ({ text, source: "question" });

function bakFiles(stateDir) {
  return fs
    .readdirSync(stateDir)
    .filter((n) => n.startsWith("semantic.json.bak-"))
    .map((n) => path.join(stateDir, n));
}

test("metric round trip is byte-stable with derived reads", () => {
  const { dir, stateDir } = freshVault();
  seedSales(dir);

  const created = semantic.createMetric(
    "Net Revenue",
    "SUM(amount) FILTER (WHERE region <> 'north')",
    "revenue excluding the north region",
    "sales",
    summary("revenue by region"),
    ["sales.csv"],
  );
  assert.ok(created.id.startsWith("metric-"), created.id);
  assert.equal(created.name, "net_revenue", "name sanitized at save");
  assert.equal(created.entity, "sales");
  assert.deepEqual(created.reads.files, [{ fileId: "sales.csv", tableName: "sales" }]);
  assert.deepEqual(created.reads.views, []);
  assert.deepEqual(created.summary, { text: "revenue by region", source: "question" });
  assert.ok(created.createdMs > 0);

  // Re-read from disk: the identical record returns.
  assert.deepEqual(semantic.listSemantic().metrics[0], created);

  // Synonym + entity persist beside the metric.
  semantic.createSynonym("GMV", "net_revenue");
  semantic.createEntity("sales", "sales", ["region"], "the ledger");
  const store = semantic.listSemantic();
  assert.deepEqual(store.synonyms, [{ term: "GMV", canonical: "net_revenue" }]);
  assert.deepEqual(store.entities[0].keyColumns, ["region"]);

  // The on-disk envelope is the byte contract with the Rust engine.
  const raw = fs.readFileSync(path.join(stateDir, "semantic.json"), "utf8");
  assert.ok(raw.startsWith('{\n  "v": 1,\n  "metrics": ['), raw);
  for (const [a, b] of [
    ['"metrics"', '"synonyms"'],
    ['"synonyms"', '"entities"'],
    ['"entities"', '"joinHints"'],
    ['"id"', '"name"'],
    ['"name"', '"expression"'],
    ['"expression"', '"description"'],
    ['"description"', '"entity"'],
    ['"entity"', '"reads"'],
    ['"reads"', '"summary"'],
    ['"summary"', '"createdMs"'],
    ['"fileId"', '"tableName"'],
    ['"term"', '"canonical"'],
  ]) {
    assert.ok(raw.indexOf(a) !== -1 && raw.indexOf(a) < raw.indexOf(b), `${a} precedes ${b}`);
  }
  assert.ok(raw.includes('"source": "question"'), raw);
  assert.ok(raw.includes('"keyColumns": ['), raw);
});

test("unknown envelope version and corrupt json load empty and bak on write", () => {
  const { stateDir } = freshVault();
  fs.mkdirSync(stateDir, { recursive: true });
  const newer =
    '{"v":99,"metrics":[{"id":"metric-future"}],"synonyms":[],"entities":[],"joinHints":[]}';
  fs.writeFileSync(path.join(stateDir, "semantic.json"), newer);

  assert.deepEqual(semantic.listSemantic().metrics, [], "v99 loads empty");
  semantic.createSynonym("gmv", "revenue");
  const baks = bakFiles(stateDir);
  assert.equal(baks.length, 1, `exactly one bak: ${baks}`);
  assert.equal(fs.readFileSync(baks[0], "utf8"), newer, "newer data recoverable byte-for-byte");
  const parsed = JSON.parse(fs.readFileSync(path.join(stateDir, "semantic.json"), "utf8"));
  assert.equal(parsed.v, 1);
  assert.equal(parsed.synonyms[0].term, "gmv");

  // Corrupt JSON baks the same way.
  const { stateDir: sd2 } = freshVault();
  fs.mkdirSync(sd2, { recursive: true });
  fs.writeFileSync(path.join(sd2, "semantic.json"), "{ not json");
  assert.deepEqual(semantic.listSemantic().synonyms, [], "corrupt loads empty");
  semantic.createSynonym("after", "x");
  assert.equal(bakFiles(sd2).length, 1);
  assert.equal(fs.readFileSync(bakFiles(sd2)[0], "utf8"), "{ not json");
});

// PARITY: guard_sql's real parser is Rust-only; this table pins the twin's
// conservative textual guard + FROM/JOIN scan on the SYNTHESIZED statement.
test("guardMetricExpression accepts a read-only aggregation and refuses the rest", () => {
  freshVault();
  assert.deepEqual(
    semantic.guardMetricExpression("SUM(amount) FILTER (WHERE status = 'paid')", "sales"),
    ["sales"],
  );
  // An entity that is itself a join carries both sources into reads.
  assert.deepEqual(
    semantic.guardMetricExpression("SUM(s.amount)", "sales s JOIN costs c ON s.id = c.id"),
    ["sales", "costs"],
  );
  // A smuggled statement / a writing keyword refuse (the textual guard).
  assert.throws(
    () => semantic.guardMetricExpression("1; DROP TABLE sales; SELECT 1", "sales"),
    /expected exactly one SQL statement|only read-only SELECT queries are allowed/,
  );
  assert.throws(
    () => semantic.guardMetricExpression("(DELETE FROM sales)", "sales"),
    new Error("only read-only SELECT queries are allowed"),
  );
});

test("name rules reject reserved words, collisions, and empty names", () => {
  const { dir } = freshVault();
  seedSales(dir);

  // Reserved keywords, checked AFTER normalization (the shared view rules).
  for (const reserved of ["select", "  SELECT ", "table"]) {
    assert.throws(
      () => semantic.createMetric(reserved, "SUM(amount)", "", "sales", summary("q"), ["sales.csv"]),
      /is a reserved word/,
      reserved,
    );
  }
  // Unusable (empty after sanitization) names.
  for (const empty of ["", "   ", "!!!"]) {
    assert.throws(
      () => semantic.createMetric(empty, "SUM(amount)", "", "sales", summary("q"), ["sales.csv"]),
      new Error("a metric needs a name"),
      JSON.stringify(empty),
    );
  }
  // An empty expression is refused explicitly (parses leniently at SQL level).
  assert.throws(
    () => semantic.createMetric("blank", "   ", "", "sales", summary("q"), ["sales.csv"]),
    new Error("a metric needs an expression"),
  );

  // Case-insensitive collision with an existing metric.
  semantic.createMetric("Revenue", "SUM(amount)", "", "sales", summary("q"), ["sales.csv"]);
  for (const taken of ["revenue", "Revenue", "  REVENUE "]) {
    assert.throws(
      () => semantic.createMetric(taken, "SUM(amount)", "", "sales", summary("q"), ["sales.csv"]),
      new Error('a metric named "revenue" already exists'),
      taken,
    );
  }
  assert.equal(semantic.listSemantic().metrics.length, 1, "only the one valid create persisted");
});

test("unknown entity references are refused", () => {
  const { dir } = freshVault();
  seedSales(dir);
  assert.throws(
    () => semantic.createMetric("mystery", "SUM(amount)", "", "nowhere", summary("q"), ["sales.csv"]),
    new Error("unknown entity in definition: nowhere"),
  );
  assert.throws(
    () => semantic.createMetric("mystery", "SUM(amount)", "", "sales", summary("q"), []),
    new Error("unknown entity in definition: sales"),
  );
  assert.deepEqual(semantic.listSemantic().metrics, []);
});

test("resolveMetric returns the stored expression or undefined", () => {
  const { dir } = freshVault();
  seedSales(dir);
  assert.equal(semantic.resolveMetric("revenue"), undefined, "empty store");
  semantic.createMetric("revenue", "SUM(amount) FILTER (WHERE region <> 'north')", "", "sales", summary("q"), ["sales.csv"]);
  assert.equal(semantic.resolveMetric("revenue"), "SUM(amount) FILTER (WHERE region <> 'north')");
  assert.equal(
    semantic.resolveMetric("  REVENUE  "),
    "SUM(amount) FILTER (WHERE region <> 'north')",
    "trimmed, case-insensitive",
  );
  assert.equal(semantic.resolveMetric("unknown"), undefined);
});

test("metric lifecycle refuses or cascades against dependent synonyms", () => {
  const { dir } = freshVault();
  seedSales(dir);

  const revenue = semantic.createMetric("revenue", "SUM(amount)", "", "sales", summary("q"), ["sales.csv"]);
  semantic.createSynonym("GMV", "revenue");
  semantic.createSynonym("turnover", "Revenue"); // case-insensitive canonical

  assert.throws(
    () => semantic.renameMetric(revenue.id, "net_revenue"),
    new Error('"revenue" can\'t be renamed while synonyms map to it: GMV, turnover'),
  );
  assert.throws(
    () => semantic.deleteMetric(revenue.id, false),
    new Error('"revenue" can\'t be deleted while synonyms map to it: GMV, turnover'),
  );
  assert.equal(semantic.listSemantic().metrics.length, 1, "refusals changed nothing");

  // Cascade removes the metric AND both mapping synonyms in one write.
  assert.equal(semantic.deleteMetric(revenue.id, true), revenue.id);
  const store = semantic.listSemantic();
  assert.deepEqual(store.metrics, []);
  assert.deepEqual(store.synonyms, [], "dependent synonyms cascaded away");

  // A metric with NO dependents renames (id stable) and deletes freely.
  const m = semantic.createMetric("orders", "COUNT(*)", "", "sales", summary("q"), ["sales.csv"]);
  const renamed = semantic.renameMetric(m.id, "Order Count");
  assert.equal(renamed.name, "order_count");
  assert.equal(renamed.id, m.id, "rename keeps the id");
  assert.equal(semantic.deleteMetric(m.id, false), m.id);
  assert.throws(() => semantic.renameMetric("metric-nope", "x"), new Error("metric not found"));
  assert.throws(() => semantic.deleteMetric("metric-nope", true), new Error("metric not found"));
});

// PARITY: semantic_test.rs::local_only_definitions_are_ineligible_on_cloud_asks
// — the twin mirrors the posture helpers the cache key leans on.
test("local-only definitions are ineligible on cloud asks", () => {
  const { dir } = freshVault();
  fs.writeFileSync(path.join(dir, "private.csv"), "region,amount\nNE,5\n");
  fs.writeFileSync(path.join(dir, "public.csv"), "region,amount\nSW,7\n");
  vault.setIncluded("private.csv", true);
  vault.setIncluded("public.csv", true);
  vault.setLocalOnly("private.csv", true);

  const priv = semantic.createMetric("private_rev", "SUM(amount)", "", "private", summary("q"), ["private.csv"]);
  const pub = semantic.createMetric("public_rev", "SUM(amount)", "", "public", summary("q"), ["public.csv"]);
  semantic.createSynonym("pgmv", "private_rev");
  semantic.createSynonym("pubgmv", "public_rev");
  semantic.createEntity("priv_ent", "private", [], "");
  semantic.createEntity("pub_ent", "public", [], "");

  assert.ok(semantic.metricEffectivelyLocalOnly(priv.reads));
  assert.ok(!semantic.metricEffectivelyLocalOnly(pub.reads));

  // Device posture: everything is eligible.
  const local = semantic.eligibleForPosture(false);
  assert.equal(local.metrics.length, 2);
  assert.equal(local.synonyms.length, 2);
  assert.equal(local.entities.length, 2);

  // Cloud posture: the private metric, its synonym, and the private entity drop.
  const cloud = semantic.eligibleForPosture(true);
  assert.deepEqual(cloud.metrics.map((m) => m.name), ["public_rev"]);
  assert.deepEqual(cloud.synonyms.map((s) => s.term), ["pubgmv"]);
  assert.deepEqual(cloud.entities.map((e) => e.name), ["pub_ent"]);

  // Unmarking flows straight through (state is read per call, never cached).
  vault.setLocalOnly("private.csv", false);
  assert.equal(semantic.eligibleForPosture(true).metrics.length, 2);
});

test("source files are never touched by any op", () => {
  const { dir } = freshVault();
  const csv = path.join(dir, "sales.csv");
  fs.writeFileSync(csv, "region,amount\nnorth,3\nsouth,7\n");
  vault.setIncluded("sales.csv", true);
  const before = fs.readFileSync(csv);

  const m = semantic.createMetric("revenue", "SUM(amount)", "", "sales", summary("q"), ["sales.csv"]);
  semantic.createSynonym("gmv", "revenue");
  assert.throws(() => semantic.createMetric("select", "SUM(amount)", "", "sales", summary("q"), ["sales.csv"]));
  semantic.deleteMetric(m.id, true);

  assert.ok(before.equals(fs.readFileSync(csv)), "source bytes identical after create/refusal/delete");
  assert.deepEqual(semantic.listSemantic().metrics, []);
});

// --- §2 prompt block: resolution into NL→SQL ---------------------------------
// PARITY: the analytics-branch injection is Rust-only (this twin has no
// analytics branch), but renderBlock's label strings + SEMANTIC_FEWSHOTS lines
// are byte-identical to semantic.rs::render_block. This snapshot is the byte
// contract — it must match the Rust test render_block_pins_the_business_...
test("renderBlock pins the business-definitions block byte-for-byte (PARITY)", () => {
  const set = {
    metrics: [
      {
        id: "metric-x",
        name: "revenue",
        expression: "SUM(amount) FILTER (WHERE status='paid')",
        description: "paid revenue",
        entity: "sales",
        reads: { files: [], views: [] },
        summary: { text: "q", source: "question" },
        createdMs: 1,
      },
    ],
    synonyms: [{ term: "GMV", canonical: "revenue" }],
    entities: [
      { name: "sales", table: "sales", keyColumns: ["region", "product"], description: "the sales ledger" },
    ],
    joinHints: [
      { leftEntity: "orders", leftColumn: "rep", rightEntity: "reps", rightColumn: "rep", description: "each order's owner" },
    ],
  };
  const block = semantic.renderBlock(set);
  assert.equal(block.name, "business definitions");
  const expected = [
    "Business definitions for this vault (curated meanings — prefer these over guessing; write SQL that uses each metric's exact definition):",
    "",
    "Metrics (name = definition):",
    "- revenue = SUM(amount) FILTER (WHERE status='paid') — paid revenue",
    "",
    "Synonyms (term → canonical column or metric):",
    "- GMV → revenue",
    "",
    "Entities (name: table (key columns) — description):",
    "- sales: sales (region, product) — the sales ledger",
    "",
    "Curated join hints (authoritative — prefer over inferred joins):",
    "- orders.rep = reps.rep — each order's owner",
    "",
    "Examples (a defined term expands to its metric definition):",
    "Q: revenue by region",
    "SQL: SELECT region, SUM(amount) FILTER (WHERE status = 'paid') AS revenue FROM sales GROUP BY region ORDER BY revenue DESC",
    "Q: gmv by month (gmv is the revenue metric)",
    "SQL: SELECT substr(order_date, 1, 7) AS month, SUM(amount) FILTER (WHERE status = 'paid') AS revenue FROM sales GROUP BY month ORDER BY month",
  ].join("\n");
  assert.equal(block.text, expected);
  // An empty set renders nothing (the byte-identical-prompt invariant).
  assert.equal(semantic.renderBlock({ metrics: [], synonyms: [], entities: [], joinHints: [] }), null);
});

test("promptBlock is null on an empty store and respects the ask posture", () => {
  const { dir } = freshVault();
  assert.equal(semantic.promptBlock(false), null, "empty store ⇒ no block");

  fs.writeFileSync(path.join(dir, "private.csv"), "region,amount\nNE,5\n");
  fs.writeFileSync(path.join(dir, "public.csv"), "region,amount\nSW,7\n");
  vault.setIncluded("private.csv", true);
  vault.setIncluded("public.csv", true);
  vault.setLocalOnly("private.csv", true);
  semantic.createMetric("private_rev", "SUM(amount)", "", "private", summary("q"), ["private.csv"]);
  semantic.createMetric("public_rev", "SUM(amount)", "", "public", summary("q"), ["public.csv"]);

  // Device posture: both definitions ride into the block.
  const local = semantic.promptBlock(false);
  assert.ok(local.text.includes("- private_rev = SUM(amount)"), local.text);
  assert.ok(local.text.includes("- public_rev = SUM(amount)"), local.text);

  // Cloud posture: the local-only metric is absent; the public one stays.
  const cloud = semantic.promptBlock(true);
  assert.ok(!cloud.text.includes("private_rev"), cloud.text);
  assert.ok(cloud.text.includes("- public_rev = SUM(amount)"), cloud.text);
});

// --- §3 env-gated per-kind ablation hook (field-patch-0.12.5) -----------------
// PARITY: mirrors semantic.rs's Ablation tests. Seeds a full store directly (a
// joinHint has no CRUD, matching the Rust engine) and checks each gate removes
// exactly its kind, and that the hook ships INERT with no env var set.
function seedFullStore(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "semantic.json"),
    JSON.stringify({
      v: 1,
      metrics: [
        {
          id: "metric-x",
          name: "revenue",
          expression: "SUM(amount)",
          description: "",
          entity: "sales",
          reads: { files: [], views: [] },
          summary: { text: "q", source: "question" },
          createdMs: 1,
        },
      ],
      synonyms: [{ term: "gmv", canonical: "revenue" }],
      entities: [{ name: "sales", table: "sales", keyColumns: [], description: "" }],
      joinHints: [
        { leftEntity: "orders", leftColumn: "rep", rightEntity: "reps", rightColumn: "rep", description: "" },
      ],
    }),
  );
}

test("§3 per-kind ablation is env-gated and ships inert (PARITY)", () => {
  const { stateDir } = freshVault();
  seedFullStore(stateDir);
  for (const k of ["METRICS", "SYNONYMS", "JOINS"]) delete process.env[`LIGHTHOUSE_ABLATE_${k}`];
  try {
    // Inert: no env ⇒ everything eligible (byte-identical to today).
    let s = semantic.eligibleForPosture(false);
    assert.deepEqual(
      [s.metrics.length, s.synonyms.length, s.entities.length, s.joinHints.length],
      [1, 1, 1, 1],
      "inert with no env var set",
    );

    process.env.LIGHTHOUSE_ABLATE_METRICS = "1";
    s = semantic.eligibleForPosture(false);
    assert.deepEqual([s.metrics.length, s.synonyms.length, s.joinHints.length], [0, 1, 1], "metrics gated");
    delete process.env.LIGHTHOUSE_ABLATE_METRICS;

    process.env.LIGHTHOUSE_ABLATE_SYNONYMS = "true";
    s = semantic.eligibleForPosture(false);
    assert.deepEqual([s.metrics.length, s.synonyms.length], [1, 0], "synonyms gated");
    delete process.env.LIGHTHOUSE_ABLATE_SYNONYMS;

    process.env.LIGHTHOUSE_ABLATE_JOINS = "1";
    s = semantic.eligibleForPosture(false);
    assert.deepEqual(
      [s.metrics.length, s.synonyms.length, s.entities.length, s.joinHints.length],
      [1, 1, 0, 0],
      "joins gate drops joinHints AND backing entities",
    );

    // A stray non-truthy value never ablates (the inert-ship guard).
    process.env.LIGHTHOUSE_ABLATE_JOINS = "0";
    s = semantic.eligibleForPosture(false);
    assert.equal(s.joinHints.length, 1, "'0' is OFF");
  } finally {
    for (const k of ["METRICS", "SYNONYMS", "JOINS"]) delete process.env[`LIGHTHOUSE_ABLATE_${k}`];
  }
});
