// Briefings TS twin (src/server/briefings.ts) — CRUD, the pure `due`
// scheduling math, and PARITY composition from pins' last summaries. Mirrors
// the Rust briefings tests so the two engines stay byte-compatible.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-brief-"));
process.env.VAULT_DIR = dir;

const {
  listBriefings,
  addBriefing,
  removeBriefing,
  dueBriefings,
  runBriefing,
  composeBriefingNote,
  MAX_BRIEFINGS,
} = await import("../src/server/briefings.ts");

// Seed a pins.json with one primed pin so composition has a summary to carry.
const stateDir = path.join(dir, ".rag-vault");
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(
  path.join(stateDir, "pins.json"),
  JSON.stringify({
    pins: [
      { id: "pin-a", question: "Revenue by region", sql: "SELECT 1", fileIds: [], createdMs: 1, lastSummary: "NE 150 · NW 200" },
    ],
  }),
);

test("CRUD replaces by title and preserves createdMs", () => {
  assert.deepEqual(listBriefings(), []);
  const b = addBriefing("Weekly Sales", ["pin-a", "pin-b"], "weekly");
  assert.equal(b.pinIds.length, 2);
  assert.equal(listBriefings().length, 1);

  const b2 = addBriefing("weekly sales", ["pin-a"], "daily"); // case-insensitive
  assert.equal(b2.id, b.id, "same title → replace");
  assert.equal(b2.createdMs, b.createdMs, "createdMs preserved");
  assert.equal(listBriefings().length, 1);
  assert.equal(listBriefings()[0].cadence, "daily");

  removeBriefing(b.id);
  assert.deepEqual(listBriefings(), []);
});

test("rejects empty input and enforces the cap", () => {
  assert.throws(() => addBriefing("", ["pin-a"], "manual"));
  assert.throws(() => addBriefing("no pins", [], "manual"));
  for (let i = 0; i < MAX_BRIEFINGS; i++) addBriefing(`b${i}`, ["pin-a"], "manual");
  assert.throws(() => addBriefing("one too many", ["pin-a"], "manual"), /limit/);
  // clean up for later tests
  for (const b of listBriefings()) removeBriefing(b.id);
});

test("dueBriefings respects cadence and last run", () => {
  addBriefing("manual one", ["pin-a"], "manual");
  const daily = addBriefing("daily one", ["pin-a"], "daily");
  const now = Date.now();

  const due = dueBriefings(now);
  assert.equal(due.length, 1, "only the daily is due");
  assert.equal(due[0], daily.id);

  // Running the daily stamps lastRunMs → no longer due now, due a day later.
  runBriefing(daily.id);
  assert.deepEqual(dueBriefings(Date.now()), [], "just-run daily isn't due");
  assert.equal(dueBriefings(now + 86_400_000 + 1000).length, 1, "due again after a day");
  for (const b of listBriefings()) removeBriefing(b.id);
});

test("runBriefing composes sections from pins (PARITY: summaries, not live SQL)", () => {
  const b = addBriefing("Q3", ["pin-a", "pin-missing"], "manual");
  const report = runBriefing(b.id);
  assert.ok(report);
  assert.equal(report.title, "Q3");
  assert.equal(report.sections.length, 2);
  assert.equal(report.sections[0].question, "Revenue by region");
  assert.equal(report.sections[0].markdown, "NE 150 · NW 200");
  assert.ok(report.sections[1].error, "removed pin → error section");

  assert.equal(runBriefing("brief-nope"), null, "unknown id → null");
});

// --- G5 briefing note: byte-parity with the Rust composer -------------------

test("composeBriefingNote matches the Rust golden output byte-for-byte", () => {
  // Same input + now_ms (2026-07-15 09:03 UTC = 1784106180000) as the Rust
  // test briefings::tests::compose_note_renders_before_after_tables_and_footer.
  const now = 1784106180000;
  const md = composeBriefingNote(
    [
      { question: "Revenue by region", before: "NE 120 · SE 300", after: "NE 150 · SE 480" },
      { question: "New signups", after: "42" },
    ],
    now,
  );
  const expected =
    "# Lighthouse Briefing\n" +
    "\n## Revenue by region\n\n" +
    "|        | Value |\n| ------ | ----- |\n| Before | NE 120 · SE 300 |\n| Now | NE 150 · SE 480 |\n" +
    "\n## New signups\n\n" +
    "|        | Value |\n| ------ | ----- |\n| Before | — |\n| Now | 42 |\n" +
    "\n*As of 2026-07-15 09:03 UTC. Every value is computed directly from your files — no AI.*\n";
  assert.equal(md, expected);
});

test("composeBriefingNote empty set is a coherent note", () => {
  const md = composeBriefingNote([], 1784106180000);
  assert.ok(md.startsWith("# Lighthouse Briefing\n"));
  assert.ok(md.includes("_No pinned questions changed since the last check._"));
  assert.ok(md.includes("no AI"));
});
