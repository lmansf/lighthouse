// Shaped-views creation UI (openspec: add-shaped-views §3) — the contracts
// mock is imported and exercised for real (the offline store the dialogs run
// against: create/list/rename/delete round trips, the canned shapeView
// proposal, and the nothing-persists-without-Save contract). The JSX surfaces
// (SaveViewDialog, ShapeViewDialog, the ChatPanel chip) can't load in node,
// so their guarantees are asserted structurally against the source — the
// boardsUi.test.mjs house style. Live behavior is the E2E pass (§6).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { ragService } = await import("../src/contracts/mocks/rag.mock.ts");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

// --- Mock store: what the dialogs drive offline --------------------------------------

test("mock createView round-trips with the provenance-labeled summary", async () => {
  const created = await ragService.createView({
    name: "Top Sales",
    sql: "SELECT region, SUM(amount) AS total FROM sales GROUP BY region",
    summaryText: "which regions sell most",
    summarySource: "question",
    fileIds: ["sales.csv"],
  });
  assert.ok(created.id.startsWith("view-"), created.id);
  assert.equal(created.name, "top_sales", "name normalized like the engines");
  assert.deepEqual(created.summary, { text: "which regions sell most", source: "question" });
  const listed = await ragService.listViews();
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0], created);

  // Refusals THROW with a human-readable reason — the dialogs show it verbatim.
  await assert.rejects(
    () =>
      ragService.createView({
        name: "top_sales",
        sql: "SELECT 1",
        summaryText: "q",
        summarySource: "question",
        fileIds: [],
      }),
    /a view named "top_sales" already exists/,
  );
  await assert.rejects(
    () =>
      ragService.createView({
        name: "  !!!  ",
        sql: "SELECT 1",
        summaryText: "q",
        summarySource: "question",
        fileIds: [],
      }),
    /a view needs a name/,
  );

  // Lifecycle: rename normalizes, delete answers the removed ids.
  const renamed = await ragService.renameView(created.id, "The Peak");
  assert.equal(renamed.name, "the_peak");
  assert.deepEqual(await ragService.viewDependents(created.id), {
    dependents: [],
    transitive: [],
  });
  assert.deepEqual(await ragService.deleteView(created.id), [created.id]);
  assert.deepEqual(await ragService.listViews(), []);
  await assert.rejects(() => ragService.deleteView(created.id), /view not found/);
});

test("mock shapeView answers a canned proposal and PERSISTS NOTHING by itself", async () => {
  const res = await ragService.shapeView("messy", "make amount a real number", ["messy.csv"]);
  assert.equal(res.available, true, "the mock always has its canned model");
  assert.match(res.sql, /^SELECT \* FROM messy/, "one SELECT over the source");
  assert.match(res.before, /\| region \| amount \|/, "before is a markdown sample table");
  assert.match(res.after, /\| region \| amount \|/, "after is a markdown sample table");
  assert.ok(res.before.includes("$3") && !res.after.includes("$3"), "messy→clean is visible");
  assert.ok(res.summary.length > 0, "a model-stated summary rides the proposal");

  // The service contract the dialog leans on: proposing persists NOTHING —
  // only an explicit createView (the Save click) writes.
  assert.deepEqual(await ragService.listViews(), [], "no view without Save");

  // Blank inputs refuse like the engine does.
  await assert.rejects(() => ragService.shapeView("", "x", []), /source table or view/);
  await assert.rejects(() => ragService.shapeView("t", "  ", []), /instruction/);
});

// --- Structural guarantees on the JSX surfaces ----------------------------------------

const chat = read("src/features/chat/ChatPanel.tsx");
const saveDialog = read("src/features/views/SaveViewDialog.tsx");
const shapeDialog = read("src/features/views/ShapeViewDialog.tsx");
const services = read("src/contracts/services.ts");
const real = read("src/contracts/real/rag.real.ts");

test("the Save-as-view chip rides RefineChips under the Edit SQL condition", () => {
  assert.match(chat, /Save as view/, "the chip exists");
  assert.match(
    chat,
    /onSaveView\?: \(meta: AnalyticsMeta\) => void;/,
    "an optional RefineChips prop, like Pin/Evidence pack",
  );
  assert.match(
    chat,
    /onSaveView=\{\(meta\) => openSaveView\(m\.id, meta\)\}/,
    "wired per turn beside the other chips",
  );
  // Same visibility as Edit SQL: the whole chip row renders only for answers
  // whose meta carries analytics SQL.
  assert.match(chat, /\{m\.analytics && !m\.error && [\s\S]{0,80}<>\s*<RefineChips/);
  // The dialog gets the answer's OWN sql + files and the asked question —
  // recovered from the preceding user turn, the pinAnswer derivation.
  assert.match(chat, /sql=\{saveView\?\.meta\.sql \?\? ""\}/);
  assert.match(chat, /fileIds=\{saveView\?\.meta\.fileIds \?\? \[\]\}/);
  assert.match(chat, /question=\{saveView\?\.question \?\? ""\}/);
  assert.match(chat, /prev\?\.role === "user" \? prev\.content : ""/);
  // Success paints the quiet Save-as-CSV-style inline note, keyed per turn…
  assert.match(chat, /Saved view “\{viewNotes\[m\.id\]\.name\}”/);
  // …and the state resets per conversation like savedNotes/pinNotes.
  assert.match(chat, /setSaveView\(null\);\s*\n\s*setViewNotes\(\{\}\);/);
});

test("SaveViewDialog records the question as the summary, labeled question", () => {
  assert.match(saveDialog, /summaryText: question/, "the asked question IS the summary");
  assert.match(saveDialog, /summarySource: "question"/, "…labeled as question-derived");
  assert.match(saveDialog, /ragService\.createView\(\{/, "creation goes through the contract");
  assert.match(saveDialog, /name: name\.trim\(\)/, "the UI trims and nothing more");
  assert.match(
    saveDialog,
    /lowercase letters, digits, and underscores/,
    "the helper text names the rules the ENGINE enforces",
  );
  assert.match(
    saveDialog,
    /err instanceof Error \? err\.message :/,
    "the engine's refusal shows verbatim in the dialog",
  );
  assert.doesNotMatch(saveDialog, /shapeView|chatService/, "no model call in this flow");
});

test("ShapeViewDialog: propose → review → explicit Save; cancel keeps nothing", () => {
  // Propose calls the contract with the picked source + instruction + files.
  assert.match(shapeDialog, /ragService\.shapeView\(source, instruction\.trim\(\), fileIds\)/);
  // The proposal renders the SQL as a code block and BOTH engine-rendered
  // samples as labeled markdown tables (the shared markdown renderer).
  // §1: the proposed view SQL is display-formatted (pretty-printed) in the block.
  assert.match(shapeDialog, /<pre className=\{styles\.sqlBlock\}>\{formatSql\(phase\.proposal\.sql\)\}<\/pre>/);
  assert.match(shapeDialog, /Before — first rows of \{source\}/);
  assert.match(shapeDialog, /After — first rows of the shaped result/);
  assert.equal(
    (shapeDialog.match(/<MarkdownView content=\{phase\.proposal\.(before|after)\} \/>/g) ?? [])
      .length,
    2,
    "before AND after render through MarkdownView",
  );
  // Save persists through createView with the MODEL-stated summary.
  assert.match(shapeDialog, /summaryText: proposal\.summary/);
  assert.match(shapeDialog, /summarySource: "model"/);
  // createView is the ONLY persisting call, and it fires only from save().
  assert.equal((shapeDialog.match(/ragService\.createView/g) ?? []).length, 1);
  assert.match(shapeDialog, /async function save\(proposal: ShapeProposal\)/);
  // State provably resets when the dialog (re)opens — Cancel leaves nothing.
  assert.match(shapeDialog, /if \(open\) \{[\s\S]{0,400}setPhase\(\{ kind: "compose" \}\)/);
  // {available:false} renders the engine's reason and RETIRES Propose (the
  // button renders only while composing — no retry spam).
  assert.match(shapeDialog, /kind: "unavailable"; reason: string/);
  assert.match(shapeDialog, /\{composing && \(\s*<Button/);
  assert.doesNotMatch(shapeDialog, /chatService/, "shaping rides the rag contract only");
});

test("the contracts carry the two ops end to end", () => {
  // The service surface §4/§5 build on.
  for (const sig of [
    "listViews(): Promise<View[]>",
    "createView(input: ViewCreateInput): Promise<View>",
    "renameView(id: string, name: string): Promise<View>",
    "deleteView(id: string, cascade?: boolean): Promise<string[]>",
    "viewDependents(id: string): Promise<{ dependents: string[]; transitive: string[] }>",
    "shapeView(source: string, instruction: string, fileIds: string[]): Promise<ShapeViewResult>",
  ]) {
    assert.ok(services.includes(sig), `services.ts declares ${sig}`);
  }
  // The real client posts the exact wire ops the three engines answer.
  assert.match(real, /JSON\.stringify\(\{ op: "views", \.\.\.body \}\)/);
  assert.match(real, /JSON\.stringify\(\{ op: "shapeView", source, instruction, fileIds \}\)/);
  // The flattened summary rides create; refusals throw the engine's reason.
  assert.match(real, /summaryText: input\.summaryText/);
  assert.match(real, /summarySource: input\.summarySource/);
  assert.match(real, /throw new Error\(\s*typeof data\.error === "string"/);
});
