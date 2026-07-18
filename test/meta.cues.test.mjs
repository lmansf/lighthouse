/**
 * Vault meta-answers, TS twin (src/server/meta.ts): the anchored cue table
 * MUST mirror lighthouse-core/src/meta.rs (cue_table_positives/_negatives),
 * and the WhatsNew/ListFiles renderers answer from a real temp vault.
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

// Point the vault at a temp dir BEFORE importing the server modules.
const home = mkdtempSync(path.join(tmpdir(), "lh-meta-"));
const vault = path.join(home, "vault");
mkdirSync(vault, { recursive: true });
process.env.VAULT_DIR = vault;

const { metaIntent, renderMeta, savedAgeLabel, countsBarSpec } = await import("../src/server/meta.ts");
const { setIncluded } = await import("../src/server/vault.ts");

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

test("whatsNew + listFiles render from the walk; findColumn falls through (PARITY)", () => {
  writeFileSync(path.join(vault, "sales.csv"), "region,amount\nNE,100\n");
  writeFileSync(path.join(vault, "notes.md"), "# notes\n");
  // setIncluded persists state, which also invalidates the 3s walk cache —
  // the same freshness path the app relies on after any mutation.
  setIncluded("sales.csv", true);
  setIncluded("notes.md", true);
  const included = ["sales.csv", "notes.md"];
  const now = Date.now();

  const fresh = renderMeta({ kind: "whatsNew", windowMs: 7 * DAY_MS }, included, now);
  assert.ok(fresh, "whatsNew renders");
  assert.match(fresh.markdown, /sales\.csv/);
  assert.match(fresh.markdown, /just now/);
  assert.equal(fresh.references.length, 2);

  const sheets = renderMeta({ kind: "listFiles", filter: "spreadsheets" }, included, now);
  assert.ok(sheets, "listFiles renders");
  assert.match(sheets.markdown, /\*\*1 spreadsheet\*\*/);
  assert.doesNotMatch(sheets.markdown, /notes\.md/);
  assert.equal(sheets.references.length, 1);
  // §2: a single kind's count renders an inline stat tile from the inventory.
  assert.match(sheets.markdown, /```lighthouse-stat\n\{"raw":"1","value":1,"label":"spreadsheet"\}\n```/);

  // The whole-vault list (2 kinds: a spreadsheet + a document) renders a bar.
  const all = renderMeta({ kind: "listFiles", filter: null }, included, now);
  assert.ok(all, "listFiles (all) renders");
  assert.match(all.markdown, /```lighthouse-chart/);

  // PARITY: the catalog is desktop-only — the TS twin must fall through.
  assert.equal(renderMeta({ kind: "findColumn", name: "region" }, included, now), null);

  // No included files ⇒ null (the pipeline's fall-through contract).
  assert.equal(renderMeta({ kind: "whatsNew", windowMs: null }, [], now), null);
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
