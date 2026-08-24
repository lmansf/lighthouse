/**
 * Vault meta-answers, TS twin (src/server/meta.ts): the anchored cue table
 * MUST mirror lighthouse-core/src/meta.rs (cue_table_positives/_negatives),
 * and the WhatsNew/ListFiles renderers answer from a real conversation corpus.
 * PARITY: findColumn is recognized but always renders null here — the column
 * catalog is desktop-only.
 *
 * Run: `node --test test/meta.cues.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const DAY_MS = 86_400_000;

// Point the engine's state root at a temp dir BEFORE importing the modules.
const home = mkdtempSync(path.join(tmpdir(), "lh-meta-"));
process.env.LIGHTHOUSE_APP_STATE_DIR = path.join(home, ".rag-vault");
mkdirSync(process.env.LIGHTHOUSE_APP_STATE_DIR, { recursive: true });

const { metaIntent, renderMeta, savedAgeLabel, countsBarSpec } = await import("../src/server/meta.ts");
const workspace = await import("../src/server/workspace.ts");
const { Corpus } = await import("../src/server/synth.ts");

test("cue table positives (mirrors meta.rs::cue_table_positives)", () => {
  assert.deepEqual(metaIntent("What's new?"), { kind: "whatsNew", windowMs: null });
  assert.deepEqual(metaIntent("what's new this week"), { kind: "whatsNew", windowMs: 7 * DAY_MS });
  assert.deepEqual(metaIntent("Whats new today?"), { kind: "whatsNew", windowMs: DAY_MS });
  assert.deepEqual(metaIntent("What changed in my vault this month?"), {
    kind: "whatsNew",
    windowMs: 31 * DAY_MS,
  });
  assert.deepEqual(metaIntent("anything new lately?"), { kind: "whatsNew", windowMs: 7 * DAY_MS });
  assert.deepEqual(metaIntent("What files do I have?"), { kind: "listFiles", filter: null });
  assert.deepEqual(metaIntent("which spreadsheets do i have in this chat"), {
    kind: "listFiles",
    filter: "spreadsheets",
  });
  // "vault" survives as a legacy alias so a returning user's phrasing lands.
  assert.deepEqual(metaIntent("which spreadsheets do i have in my vault"), {
    kind: "listFiles",
    filter: "spreadsheets",
  });
  assert.deepEqual(metaIntent("list my documents"), { kind: "listFiles", filter: "documents" });
  assert.deepEqual(metaIntent("show me all my pdfs"), { kind: "listFiles", filter: "pdfs" });
  // "how many" is the count phrasing §2 answers with a stat tile.
  assert.deepEqual(metaIntent("how many pdfs do i have"), { kind: "listFiles", filter: "pdfs" });
  assert.deepEqual(metaIntent("How many files do I have?"), { kind: "listFiles", filter: null });
  assert.deepEqual(metaIntent("Which files have an employee id column?"), {
    kind: "findColumn",
    name: "employee id",
  });
  assert.deepEqual(metaIntent("which files have a column called region"), {
    kind: "findColumn",
    name: "region",
  });
  assert.deepEqual(metaIntent("who has a revenue column"), { kind: "findColumn", name: "revenue" });
});

test("cue table negatives (mirrors meta.rs::cue_table_negatives)", () => {
  for (const q of [
    "What's new in the Q3 report?", // names a document
    "what's newest", // frame must end on a word boundary
    "What are the key risks across my files?", // content synthesis
    "what files does the contract mention", // content, not inventory
    "which files have the highest revenue", // aggregate → analytics
    "Summarize what's new in accounting.xlsx", // not anchored at start
    "total amount by region", // analytics
    "who has the largest budget", // not a column question
    "what did I add to the deck about pricing", // tail names content
    "",
  ]) {
    assert.equal(metaIntent(q), null, `expected full pipeline for ${JSON.stringify(q)}`);
  }
});

test("savedAgeLabel mirrors the Rust ladder", () => {
  const now = 1_700_000_000_000;
  assert.equal(savedAgeLabel(now - 5_000, now), "just now");
  assert.equal(savedAgeLabel(now + 120_000, now), "just now"); // clock skew reads fresh
  assert.equal(savedAgeLabel(now - 90_000, now), "1 minute ago");
  assert.equal(savedAgeLabel(now - 5 * 3_600_000, now), "5 hours ago");
  assert.equal(savedAgeLabel(now - 10 * DAY_MS, now), "1 week ago");
  assert.equal(savedAgeLabel(now - 70 * DAY_MS, now), "2 months ago");
});

test("whatsNew + listFiles render from the corpus; findColumn falls through (PARITY)", () => {
  const CONV = "conv-meta";
  const included = [
    workspace.attach(CONV, "sales.csv", Buffer.from("region,amount\nNE,100\n")).id,
    workspace.attach(CONV, "notes.md", Buffer.from("# notes\n")).id,
  ];
  const corpus = new Corpus(CONV);
  const empty = new Corpus("conv-meta-empty");
  const now = Date.now();

  const fresh = renderMeta(corpus, { kind: "whatsNew", windowMs: 7 * DAY_MS }, included, now);
  assert.ok(fresh, "whatsNew renders");
  assert.match(fresh.markdown, /sales\.csv/);
  assert.match(fresh.markdown, /just now/);
  assert.equal(fresh.references.length, 2);

  const sheets = renderMeta(corpus, { kind: "listFiles", filter: "spreadsheets" }, included, now);
  assert.ok(sheets, "listFiles renders");
  assert.match(sheets.markdown, /\*\*1 spreadsheet\*\*/);
  assert.doesNotMatch(sheets.markdown, /notes\.md/);
  assert.equal(sheets.references.length, 1);
  // §2: a single kind's count renders an inline stat tile from the inventory.
  assert.match(sheets.markdown, /```lighthouse-stat\n\{"raw":"1","value":1,"label":"spreadsheet"\}\n```/);

  // The whole-corpus list (2 kinds: a spreadsheet + a document) renders a bar.
  const all = renderMeta(corpus, { kind: "listFiles", filter: null }, included, now);
  assert.ok(all, "listFiles (all) renders");
  assert.match(all.markdown, /```lighthouse-chart/);

  // PARITY: the catalog is desktop-only — the TS twin must fall through.
  assert.equal(renderMeta(corpus, { kind: "findColumn", name: "region" }, included, now), null);

  // An EMPTY id list means the whole conversation, not "nothing" — the same
  // rule Corpus.candidates follows. PARITY: meta.rs::included_files_with_mtime.
  const implicit = renderMeta(corpus, { kind: "whatsNew", windowMs: null }, [], now);
  assert.ok(implicit, "an ask that names no subset still answers over the conversation");
  assert.equal(implicit.references.length, 2);

  // A conversation with nothing attached ⇒ null (the fall-through contract).
  assert.equal(renderMeta(empty, { kind: "whatsNew", windowMs: null }, [], now), null);
});

test("countsBarSpec charts the by-kind counts, and only from counts (§2)", () => {
  // Two+ kinds → a bar over the by-kind counts, x-labels pluralized.
  const bar = countsBarSpec([
    ["spreadsheet", 5],
    ["document", 3],
    ["PDF", 2],
  ]);
  assert.ok(bar, "two kinds chart");
  const spec = JSON.parse(bar);
  assert.equal(spec.kind, "bar");
  assert.deepEqual(spec.x, ["spreadsheets", "documents", "PDFs"]);
  assert.deepEqual(spec.series[0].values, [5, 3, 2]);
  // CONSTITUTION guard: a single count is a tile, never a one-bar chart — and
  // there is no path that turns a prose number into either.
  assert.equal(countsBarSpec([["spreadsheet", 5]]), null);
  assert.equal(countsBarSpec([]), null);
});

// --- twin pins for the two mutants cargo-mutants found in meta.rs ----------

test("the ListFiles tail gate rejects a tail outside the corpus allow-list", () => {
  // PARITY: meta.rs::corpus_tail_gate_rejects_a_tail_outside_the_allow_list.
  // cargo-mutants replaced the whole of `corpus_tail_ok` with `true` in the
  // Rust twin and nothing failed — no test used a tail OUTSIDE the list. The
  // gate is what stops a question that merely LOOKS like a listing from being
  // answered as one: "how many csvs do i have in q3" asks about Q3, and
  // answering it with the file list is a WRONG answer, not a missing one.
  for (const tail of ["in this chat", "here", "attached", "in my chat", "in the vault"]) {
    assert.deepEqual(
      metaIntent(`how many csvs do i have ${tail}`),
      { kind: "listFiles", filter: "spreadsheets" },
      `should accept the corpus tail ${JSON.stringify(tail)}`,
    );
  }
  for (const tail of ["in q3", "on my desktop", "in the downloads folder", "from last week"]) {
    assert.equal(
      metaIntent(`how many csvs do i have ${tail}`),
      null,
      `a question scoped to ${JSON.stringify(tail)} must NOT become a file listing`,
    );
  }
});

test("listFiles reference scores DESCEND with list order and clamp at 0.5", () => {
  // PARITY: meta.rs::reference_scores_descend_with_list_order_and_clamp_at_half.
  // Mutating the `-` to a `+` makes the scores ascend, silently reversing the
  // list any score-sorted rendering shows. Six files so the ordering has room
  // to be wrong.
  const conv = "conv-meta-scores";
  const included = ["a.csv", "b.csv", "c.csv", "d.csv", "e.csv", "f.csv"].map(
    (n) => workspace.attach(conv, n, Buffer.from(`x,y\n1,2\n# ${n}\n`)).id,
  );
  const out = renderMeta(
    new Corpus(conv),
    { kind: "listFiles", filter: "spreadsheets" },
    included,
    Date.now(),
  );
  assert.ok(out, "listFiles renders");
  const scores = out.references.map((r) => r.score);
  assert.ok(scores.length >= 6, `expected the attached files back, got ${scores.length}`);
  assert.equal(scores[0], 1.0, "the first listed file scores highest");
  for (let i = 1; i < scores.length; i += 1) {
    assert.ok(scores[i] < scores[i - 1], `scores must DESCEND, got ${JSON.stringify(scores)}`);
  }
  assert.ok(scores.every((s) => s >= 0.5), "clamped at 0.5, never negative");
});
