/**
 * §32 §3a/§3b: `meta.table` + the ONE accessor (`answerTable`). Under the
 * apple-fm prose contract the engine carries the verified rows on the
 * structured channel; every consumer reads tables through the accessor, which
 * prefers `meta.table` and falls back to parsing the answer markdown — so
 * legacy chats and cloud/desktop answers keep working unchanged. These are
 * the behavioral pins plus the structural wiring pins (the ChatPanel JSX
 * can't load in node — the chartIt.test.mjs house style).
 *
 * Run: `node --test test/answerTable.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const { answerTable, parseTableJson, parseMarkdownTable } = await import("../src/lib/answerTable.ts");
const { composeEvidencePack } = await import("../src/lib/evidencePack.ts");

const MD_TABLE = "Intro.\n\n| region | total |\n| --- | --- |\n| West | 42 |\n";
const META_TABLE = '{"columns":["region","total"],"rows":[["East","99"]]}';

test("answerTable prefers the engine's structured meta.table", () => {
  assert.deepEqual(answerTable({ content: MD_TABLE, meta: { table: META_TABLE } }), {
    header: ["region", "total"],
    rows: [["East", "99"]],
  });
});

test("answerTable falls back to the markdown parse (legacy chats, cloud/desktop)", () => {
  // No meta at all — the pre-§32 world.
  assert.deepEqual(answerTable({ content: MD_TABLE }), {
    header: ["region", "total"],
    rows: [["West", "42"]],
  });
  // A malformed structured field degrades to the parse, never throws.
  assert.deepEqual(answerTable({ content: MD_TABLE, meta: { table: "{not json" } })?.rows, [
    ["West", "42"],
  ]);
  // Nothing anywhere → null (prose-only answer, all refine chips stay).
  assert.equal(answerTable({ content: "Just prose." }), null);
});

test("parseTableJson validates shape and stringifies cells", () => {
  assert.deepEqual(parseTableJson('{"columns":["n"],"rows":[[1],[2.5]]}'), {
    header: ["n"],
    rows: [["1"], ["2.5"]],
  });
  assert.equal(parseTableJson('{"columns":[],"rows":[]}'), null, "empty header is no table");
  assert.equal(parseTableJson('{"columns":["a"],"rows":["not-a-row"]}'), null);
  assert.equal(parseTableJson("[]"), null);
});

test("the markdown parser kept its contract after the move to lib", () => {
  assert.deepEqual(parseMarkdownTable(MD_TABLE), { header: ["region", "total"], rows: [["West", "42"]] });
  assert.equal(parseMarkdownTable("no table"), null);
});

test("the evidence pack renders a prose answer's meta.table rows", () => {
  const html = composeEvidencePack({
    question: "Total by region?",
    contentMarkdown: "East leads with 99 [1].",
    meta: { origin: "device", excerptCount: 1, sourceFileCount: 1, table: META_TABLE },
    analytics: { sql: "SELECT region, total FROM t", fileIds: [] },
    generatedAt: 1_700_000_000_000,
  });
  assert.ok(html.includes("<th>region</th>"), "structured header exported");
  assert.ok(html.includes("<td>East</td>"), "structured row exported");
  // And it lands inside the Answer section, before the Query used section.
  assert.ok(html.indexOf("<td>East</td>") < html.indexOf("<h2>Query used</h2>"));
});

test("the chat renderer draws meta.table at the answer's table position (wiring pins)", () => {
  const chat = read("src/features/chat/ChatPanel.tsx");
  // AnswerMarkdown threads the field into the remark plugin beside the chart.
  assert.match(chat, /\[remarkAnswerCard, \{ chart: metaChart, table: metaTable \}\]/);
  // The plugin re-materializes it as a synthetic GFM table node (so
  // SortableTable/copy-as-CSV treat it exactly like a typed table), placed
  // with the chart before the SQL disclosure — table first.
  assert.match(chat, /const parsed = parseTableJson\(options\.table\);/);
  assert.match(chat, /type: "table",\s*\n\s*align: parsed\.header\.map\(\(\) => null\),/);
  // All three meta consumers receive the field from the message.
  const tableProps = chat.match(/metaTable=\{m\.meta\?\.table\}/g) ?? [];
  assert.equal(tableProps.length, 3, "AnswerMarkdown + RefineChips + ChartItRow all threaded");
});

test("boards read tables through the accessor too (parse-fallback arm)", () => {
  const model = read("src/features/boards/boardModel.ts");
  const card = read("src/features/boards/BoardCard.tsx");
  assert.match(model, /const table = answerTable\(\{ content: markdown \}\);/, "detectStat");
  assert.match(card, /const table = answerTable\(\{ content: markdown \}\);/, "LiveBody");
  assert.match(
    model,
    /export \{ answerTable, parseMarkdownTable, type ParsedTable \} from "\.\.\/\.\.\/lib\/answerTable";/,
    "boardModel re-exports the moved parser so existing importers keep working",
  );
});
